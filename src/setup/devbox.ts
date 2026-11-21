import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiPlan, ModelRow } from "../pack/types.ts";
import { canBeDevbox } from "../hub/names.ts";
import { onHub, quote } from "../hub/ssh.ts";
import { loadProfile, pullProfile, saveAnswers, validHost } from "../profile/profile.ts";
import type { AgentRuntime, OnboardingContext } from "../sdk/runtime.ts";
import type { Machine } from "./commands.ts";
import { engineRepo } from "./defaults.ts";
import { type HumanContext, humanStep, type SignIn } from "./human.ts";
import type { Step, StepOutcome } from "./runner.ts";
import { chatgptSignIn, claudeSignIn, githubSignIn } from "./signins.ts";
import type { Terminal } from "./terminal.ts";

export const skipDevbox = "skip";
const boxProfile = "$HOME/.local/share/hedge/profile";
const boxEngine = "$HOME/.local/share/hedge/engine";
const remotePath = `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH";`;

/** The concrete hosts in ~/.ssh/config: Host entries without wildcards or negations. */
export function sshHosts(home: string): string[] {
  const path = join(home, ".ssh", "config");
  if (!existsSync(path)) return [];
  const hosts = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim().match(/^host\s+(.+)$/i)?.[1])
    .filter((names): names is string => Boolean(names))
    .flatMap((names) => names.split(/\s+/))
    .filter((name) => !/[*?!]/.test(name));
  return [...new Set(hosts)];
}


/** The devbox as a Machine: its commands run over SSH, while sleeping and the browser stay on this machine. */
export function overSsh(machine: Machine, host: string): Machine {
  if (!validHost(host)) throw new Error(`${host} is not an SSH host name`);
  const line = (command: string[], scratch = false) => {
    const words = command.map(quote).join(" ");
    const body = scratch ? `d=$(mktemp -d) && cd "$d" && ${words}; s=$?; cd / && rm -rf "$d"; exit $s` : words;
    return `${remotePath} ${body}`;
  };
  const batch = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host];
  return {
    exec: (command, options = {}) => machine.exec(["ssh", "-T", ...batch, line(command, options.cwd !== undefined)], { ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.input === undefined ? {} : { input: options.input }) }),
    start: (command) => machine.start(["ssh", "-T", ...batch, line(command)]),
    run: (command, options = {}) => machine.run(["ssh", options.input ? "-t" : "-T", ...batch, line(command)], options),
    sleep: (ms) => machine.sleep(ms),
    openUrl: (url) => machine.openUrl(url),
    has: () => true,
  };
}

export type DevboxContext = {
  terminal: Terminal;
  machine: Machine;
  nonInteractive: boolean;
  /** Waits for browser sign-ins although it asks nothing, as hedge setup --chat does. */
  chat?: boolean;
  /** Counts a wait for the person in the setup timings. */
  waited?(): void;
  plan: AiPlan;
  models: ModelRow[];
  /** The profile's clone URL and the engine ref it pins, so the box runs what this machine runs. */
  profile(): Promise<{ url: string; engineRef: string }>;
  rerun?: string;
  engineRoot?: string;
  leftForYou?(steps: LeftStep[]): void;
  runtime?: AgentRuntime;
};

export function onboardingContext(machine: Machine, terminal: Terminal, rerun: string): OnboardingContext {
  return { here: machine, on: (host) => overSsh(machine, host), print: (line) => terminal.print(line), rerun };
}

export const linksItself = (runtime: AgentRuntime | undefined) => `${runtime?.title ?? "Your runtime"} links your machines itself, so Hedge does not link them.`;

/** The runtimes that these packs bring, by name. A runtime that does not load is left out. */
/** The profile's clone URL as stored, and the engine ref the profile pins. */
export async function profileForBox(machine: Machine, profileDir: string | undefined) {
  if (!profileDir) throw new Error("no profile yet");
  const origin = await machine.exec(["git", "-C", profileDir, "config", "--get", "remote.origin.url"]);
  if (origin.code !== 0) throw new Error(`${profileDir} has no origin to clone on the devbox`);
  const { engine } = await loadProfile(profileDir);
  return { url: origin.output.trim(), engineRef: engine.channel === "track" ? "main" : engine.ref };
}

/** Asks which SSH host is the devbox, or takes it from --devbox. Skipping leaves a plan for this machine only. */
export function devboxQuestion(context: { terminal: Terminal; home: string; flag?: string; nonInteractive: boolean; answer(host: string | undefined): Promise<void> }): Step {
  return {
    id: "devbox",
    title: "Your devbox",
    minutes: 1,
    kind: "question",
    async run(): Promise<StepOutcome> {
      const { terminal } = context;
      const chosen = async (host: string | undefined) => {
        await context.answer(host);
        terminal.print(host ? `  ✓ ${host}` : "  ✓ No devbox for now. Add one later with hedge devbox add <host>.");
      };
      if (context.flag) return chosen(context.flag === skipDevbox ? undefined : context.flag);
      const hosts = sshHosts(context.home).filter(canBeDevbox);
      if (context.nonInteractive || !hosts.length) return chosen(undefined);
      terminal.print("? Which SSH host is your devbox?");
      terminal.print("  Hedge installs itself there over SSH, signs it in, and links it with this machine.");
      hosts.forEach((host, index) => terminal.print(`  ${index + 1}) ${host}`));
      for (;;) {
        const reply = await terminal.ask("Press ↵ to skip, or type a number: ");
        if (reply === "") return chosen(undefined);
        const host = hosts[Number(reply) - 1];
        if (Number.isInteger(Number(reply)) && host) return chosen(host);
      }
    },
  };
}

const again = (context: DevboxContext) => context.rerun ?? "hedge setup";

/** The steps that make an SSH host a devbox: install, sign in, apply the profile, and link the runtime both ways. */
export function devboxSteps(host: string, context: DevboxContext): Step[] {
  const box = overSsh(context.machine, host);
  const human: HumanContext = { terminal: context.terminal, machine: box, nonInteractive: context.nonInteractive, chat: context.chat, waited: context.waited, rerun: context.rerun };
  const on = (signIn: SignIn): SignIn => Object.assign(Object.create(signIn) as SignIn, { id: `devbox:${host}:${signIn.id}`, title: `${signIn.title} on ${host}` });
  const chatgpt = chatgptSignIn(box, context.models);
  const onboarding = context.runtime?.onboarding?.();
  const nodeSignIn = onboarding?.nodeSignIn?.(host, box);
  return [
    auto(host, "install", `Install Hedge on ${host}`, 4, context.terminal, () => install(box, host, context)),
    ...(host.startsWith(coderPrefix) && context.machine.has("coder") ? [auto(host, "coder", `Sign in to Coder on ${host}`, 1, context.terminal, () => coderOnBox(host, box, context))] : []),
    humanStep(on(githubSignIn(box, async () => {})), human),
    auto(host, "profile", `Apply your profile on ${host}`, 3, context.terminal, () => applyProfile(box, host, context)),
    ...(context.plan === "codex" ? [] : [claudeOnBox(host, box, context)]),
    ...(context.plan === "claude" ? [] : [humanStep(on(chatgpt), human)]),
    ...(nodeSignIn ? [humanStep({ ...nodeSignIn, id: `devbox:${host}:${nodeSignIn.id}`, minutes: 1 }, human)] : []),
    onboarding
      ? auto(host, "link", `Link ${context.runtime!.title} here and on ${host}`, 1, context.terminal, () => onboarding.link(host, onboardingContext(context.machine, context.terminal, again(context))))
      : auto(host, "link", `Link ${host} with this machine`, 1, context.terminal, async () => `  · ${linksItself(context.runtime)}`),
  ];
}

function auto(host: string, id: string, title: string, minutes: number, terminal: Terminal, work: () => Promise<string | void>): Step {
  return {
    id: `devbox:${host}:${id}`,
    title,
    minutes,
    kind: "auto",
    async run() {
      terminal.print(`▶ ${title}`);
      terminal.print((await work()) ?? `  ✓ ${title}: done`);
    },
  };
}

/** Installs Hedge on the devbox and names it by the SSH host this machine reaches it by, the name the profile lists it by. */
async function install(box: Machine, host: string, context: DevboxContext) {
  const { engineRef } = await context.profile();
  const getSh = `https://raw.githubusercontent.com/${engineRepo}/${engineRef}/get.sh`;
  await nameBox(box, host);
  const hedgeOnly = `{ grep -qF '/.local/share/hedge/engine' "$installer" || { rm -f "$installer"; exit ${refused}; }; }`;
  const download = `installer=$(mktemp) && { curl -fsSL ${quote(getSh)} -o "$installer" && ${hedgeOnly} && sh "$installer" --ref ${quote(engineRef)} --install-only; s=$?; rm -f "$installer"; exit $s; }`;
  const code = await box.run(["sh", "-c", download]);
  if (code === refused) throw new Error(`Your profile pins the engine at ${engineRef}, from before Fleet became Hedge, so Hedge does not install it on ${host}. Set engine.ref in your profile to a Hedge release, then run hedge devbox add ${host} again.`);
  if (code !== 0) throw new Error(`Hedge did not install on the devbox. Fix what it says above, then run ${again(context)} again.`);
}

const roleFolder = `"$HOME/.config/hedge"`;
const roleFile = `"$HOME/.config/hedge/machine.json"`;

const refused = 86;
const linked = `{ [ ! -L ${roleFolder} ] && [ ! -L ${roleFile} ] || exit ${refused}; }`;

export async function nameBox(box: Machine, host: string) {
  const read = await box.exec(["sh", "-c", `${linked} && { [ ! -f ${roleFile} ] || cat ${roleFile}; }`]);
  if (read.code === refused) throw new Error(`~/.config/hedge or its machine.json on ${host} is a link, so Hedge does not write through it. Move the link away, then run hedge devbox add ${host} again.`);
  if (read.code !== 0) throw new Error(`Hedge could not reach ${host} over SSH: ${read.output.trim()}`);
  const saved = read.stdout.trim() ? roleOf(host, read.stdout) : undefined;
  if (saved?.name === host) return;
  if (saved?.name !== undefined) throw new Error(`${host} already calls itself ${String(saved.name)} in ~/.config/hedge/machine.json. Run hedge devbox add ${String(saved.name)} to keep that name, or set its name there to ${host} and run hedge devbox add ${host} again.`);
  const named = { schema: 1, role: "devbox", ...saved, name: host };
  const written = await box.exec(["sh", "-c", `${linked} && mkdir -p ${roleFolder} && ${linked} && cat > ${roleFile}`], { input: `${JSON.stringify(named)}\n` });
  if (written.code !== 0) throw new Error(`Hedge could not write the role file on ${host}: ${written.output.trim()}`);
}

function roleOf(host: string, text: string): Record<string, unknown> {
  const unreadable = new Error(`Hedge cannot read ~/.config/hedge/machine.json on ${host}. Fix or remove it, then run hedge devbox add ${host} again.`);
  try {
    const role: unknown = JSON.parse(text);
    if (typeof role !== "object" || role === null || Array.isArray(role)) throw unreadable;
    return role as Record<string, unknown>;
  } catch {
    throw unreadable;
  }
}

const coderPrefix = "coder.";

/** The Coder address in what coder whoami prints: "Coder is running at <address>, You're authenticated as <user> !". */
export function coderAddress(whoami: string): string | undefined {
  const address = whoami.match(/Coder is running at (https?:\/\/[^\s,]+)/)?.[1];
  return address?.replace(/\/+$/, "");
}

type CoderSession = { address: string; userId?: string };

/** Who a machine is signed in to Coder as. A deployment can answer at another address on another network, so its user ID tells two sessions apart, and the address does so only for a Coder CLI too old to print the ID. */
async function coderSession(machine: Machine): Promise<CoderSession | undefined> {
  const json = await machine.exec(["coder", "whoami", "-o", "json"]);
  if (json.code === 0) {
    try {
      const [session] = JSON.parse(json.stdout) as Array<{ url?: unknown; user_id?: unknown }>;
      if (typeof session?.url === "string" && typeof session.user_id === "string" && session.user_id) return { address: session.url.replace(/\/+$/, ""), userId: session.user_id };
    } catch {}
  }
  const text = await machine.exec(["coder", "whoami"]);
  const address = text.code === 0 ? coderAddress(text.output) : undefined;
  return address ? { address } : undefined;
}

const sameCoderUser = (here: CoderSession, box: CoderSession | undefined) => box !== undefined && (here.userId && box.userId ? here.userId === box.userId : here.address === box.address);

const coderConfig = `"\${CODER_CONFIG_DIR:-\${XDG_CONFIG_HOME:-$HOME/.config}/coderv2}"`;

async function coderOnBox(host: string, box: Machine, context: DevboxContext) {
  const session = await coderSession(context.machine);
  if (!session) throw new Error(`Coder is not signed in on this machine. Run coder login <your Coder address> here, then hedge devbox add ${host} again.`);
  const state = await box.exec(["sh", "-c", `${signInState(session.address)} :`]);
  if (![0, otherSignIn, savedElsewhere].includes(state.code)) throw new Error(`Hedge could not read the Coder sign-in on ${host}: ${state.output.trim()}`);
  if (state.code !== otherSignIn && sameCoderUser(session, await coderSession(box))) return configSsh(host, box);
  if (state.code !== 0) return await leaveSignIn(host, box, session.address, state.stdout.split("\n").filter(Boolean), context), `  · Coder on ${host} is signed in another way, so Hedge leaves that sign-in alone and lists the sign-in to ${session.address} at the end.`;
  await signInBox(host, box, context, session.address);
}

async function configSsh(host: string, box: Machine) {
  const ssh = await box.exec(["coder", "config-ssh", "--yes"]);
  if (ssh.code !== 0) throw new Error(`coder config-ssh failed on ${host}: ${ssh.output.trim()}`);
}

const signInLimitSeconds = 120;
const hubSignInLimitMs = (signInLimitSeconds + 30) * 1000;
const killedAtDeadline = 137;
const tokenRemoveLimitSeconds = 60;
const otherSignIn = 87;
const savedElsewhere = 88;

const signInState = (address: string) => `d=${coderConfig} a=${quote(address)} o=; for f in "$d/url" "$d/session"; do if [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; }; then printf '%s\\n' "$f"; o=1; fi; done; [ -z "$CODER_URL" ] || { echo CODER_URL; o=1; }; [ -z "$CODER_SESSION_TOKEN" ] || { echo CODER_SESSION_TOKEN; o=1; }; [ -z "$o" ] || exit ${otherSignIn}; { [ ! -e "$d/url" ] && [ ! -e "$d/session" ]; } || [ "$(cat "$d/url" 2>/dev/null)" = "$a" ] || exit ${savedElsewhere};`;

async function signInBox(host: string, box: Machine, context: DevboxContext, address: string) {
  const here = context.machine;
  if (!(await reachesOverHttps(box, address))) throw new Error(`${host} does not reach Coder at ${address} over HTTPS, so Hedge makes no Coder token for it and sends none. Sign ${host} in to Coder yourself: install the Coder CLI there from your Coder deployment, run coder login there with an HTTPS address it reaches, and paste a token from ${address}/cli-auth. Then run hedge devbox add ${host} again.`);
  const failed = await installCoder(box, address);
  if (failed !== undefined) throw new Error(`Hedge could not install the Coder CLI on ${host} from ${address}: ${failed}`);
  const name = `hedge-${Date.now().toString(36)}`;
  const token = await here.exec(["coder", "tokens", "create", "--name", name]);
  if (token.code !== 0 || !token.output.trim()) throw new Error(`Coder made no token for ${host}: ${token.output.trim()}`);
  const login = `${signInState(address)} { [ ! -f "$d/session" ] || chmod 600 "$d/session"; } && IFS= read -r t && CODER_SESSION_TOKEN="$t" coder login --use-token-as-session "$a" && coder config-ssh --yes; s=$?; [ $s -ne ${killedAtDeadline} ] || s=1; exit $s`;
  const signedIn = await box.exec(["sh", "-c", `timeout -s KILL ${signInLimitSeconds} sh -c ${quote(login)}; exit $?`], { input: `${token.stdout.trim()}\n`, timeoutMs: hubSignInLimitMs });
  if (signedIn.code === 0) return;
  const removed = (await here.exec(["timeout", "-k", "10", String(tokenRemoveLimitSeconds), "coder", "tokens", "remove", name])).code === 0;
  const cleanup = removed ? "" : ` Hedge could not remove the token it made, ${name}. Remove it with coder tokens remove ${name}.`;
  const why = [otherSignIn, savedElsewhere].includes(signedIn.code) ? ", because it is signed in another way now" : signedIn.code === killedAtDeadline ? `: coder login and coder config-ssh did not finish within ${signInLimitSeconds / 60} minutes` : `: ${signedIn.output.trim()}`;
  throw new Error(`Hedge could not sign ${host} in to Coder${why}.${cleanup}`);
}

async function installCoder(box: Machine, address: string) {
  const download = `command -v coder >/dev/null || { case $(uname -m) in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) exit 1;; esac; b="$HOME/.local/bin" && mkdir -p "$b" && p=$(mktemp "$b/.coder.XXXXXX") && { c=$(curl -q --proto =https --max-redirs 0 -fsS --max-time 300 -w '%{http_code}' -o "$p" ${quote(`${address}/bin/coder-linux-`)}"$a") && [ "$c" = 200 ] && [ -s "$p" ] && chmod +x "$p" && "$p" version >/dev/null && mv -f "$p" "$b/coder"; s=$?; rm -f "$p"; [ $s = 0 ] || echo "the download answered HTTP $c and gave no Coder CLI" >&2; exit $s; }; }`;
  const installed = await box.exec(["sh", "-c", download]);
  return installed.code === 0 ? undefined : installed.output.trim();
}

async function leaveSignIn(host: string, box: Machine, address: string, found: string[], context: DevboxContext) {
  const https = address.startsWith("https://");
  const fetched = https && (await installCoder(box, address)) === undefined;
  const variables = found.filter((line) => ["CODER_URL", "CODER_SESSION_TOKEN"].includes(line));
  const paths = found.filter((line) => !variables.includes(line));
  const first = [paths.length ? `move ${paths.join(" and ")} aside` : "", variables.length ? `remove ${variables.join(" and ")} from the environment on ${host}` : ""].filter(Boolean);
  const sign = first.length ? ` First ${first.join(" and ")}, then sign` : " Sign";
  const left = `Coder on ${host} is signed in another way, so Hedge left that sign-in alone.`;
  const step: LeftStep = fetched
    ? { say: `${left}${sign} it in to ${address}, so it reaches the hub and the other nodes by their coder. names.`, command: `coder login ${quote(address)} && coder config-ssh --yes` }
    : https
      ? { say: `${left} Hedge could not fetch the Coder CLI from the hub's Coder address, ${address}, so install it on ${host} from your Coder deployment.${sign} it in to Coder over HTTPS, at ${address} or another address it reaches, and run coder config-ssh --yes.` }
      : { say: `${left}${sign} it in to Coder over HTTPS, at an address it reaches. The hub's Coder address, ${address}, is plain HTTP, so Hedge prints no sign-in command for it.` };
  if (!context.leftForYou) throw new Error(`${step.say}${step.command ? ` Run on ${host}: ${step.command}.` : ""} Then run ${again(context)} again.`);
  context.leftForYou([step]);
}

const reachesOverHttps = async (box: Machine, address: string) => address.startsWith("https://") && (await box.exec(["curl", "-q", "--proto", "=https", "--max-redirs", "0", "-sS", "--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}", `${address}/api/v2/buildinfo`])).stdout.trim() === "200";

async function engineCurrent(box: Machine, context: DevboxContext) {
  const here = context.engineRoot && (await context.machine.exec(["git", "-C", context.engineRoot, "rev-parse", "HEAD"]));
  const commit = here && here.code === 0 ? here.stdout.trim() : "";
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return false;
  return (await box.exec(["sh", "-c", `"$HOME/.local/bin/hedge" help >/dev/null 2>&1 && [ "$(git -C "${boxEngine}" rev-parse HEAD)" = ${commit} ]`])).code === 0;
}

const userBus = `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";`;

export type LeftStep = { say: string; command?: string };

async function applyProfile(box: Machine, host: string, context: DevboxContext) {
  const { url, engineRef } = await context.profile();
  const clone = `[ -d "${boxProfile}/.git" ] || gh repo clone ${quote(url)} "${boxProfile}" -- -q`;
  const withEngine = `sh "${boxEngine}/hedge" apply --profile "${boxProfile}"`;
  const apply = (await engineCurrent(box, context)) ? withEngine : `sh "${boxEngine}/get.sh" --ref ${quote(engineRef)} --profile "${boxProfile}"`;
  const applied = (await box.run(["sh", "-c", `${userBus} ${clone} && ${apply}`])) === 0;
  const node = await stepsLeft(box);
  if (applied && node === olderEngine) return context.terminal.print(`  · ${host} runs an older Hedge, which cannot list the steps left for you. Run hedge doctor on ${host} to see them.`);
  const left = node === olderEngine ? undefined : node;
  if (applied && left?.clean && !left.steps.length) return;
  if (applied && left?.clean && context.leftForYou) {
    context.leftForYou(left.steps);
    return context.terminal.print(`  · ${left.steps.length === 1 ? "One step is" : `${left.steps.length} steps are`} left for you on ${host}. Hedge lists ${left.steps.length === 1 ? "it" : "them"} at the end and runs none of them.`);
  }
  throw new Error(applyFailure(host, context, applied, left));
}

const yourSteps = (host: string, left: LeftStep[]) => left.map((step) => `  · ${step.say}${step.command ? ` Run: ssh -t ${host} ${quote(`${remotePath} ${step.command}`)}` : ""}`);

export function printLeftForYou(terminal: Terminal, host: string, left: LeftStep[]) {
  if (!left.length) return;
  terminal.print("");
  terminal.print(`Left for you on ${host}:`);
  for (const line of yourSteps(host, left)) terminal.print(line);
  terminal.print(`Do each one, then run hedge apply on ${host}.`);
}

const olderEngine = "older engine";

type NodeLeft = { steps: LeftStep[]; clean: boolean; said: string[] };

async function stepsLeft(box: Machine): Promise<NodeLeft | typeof olderEngine | undefined> {
  const listed = await box.exec(["sh", "-c", `${userBus} sh "${boxEngine}/hedge" doctor --profile "${boxProfile}" --to-do`]);
  if (listed.code !== 0 && listed.output.includes("hedge: unknown option --to-do")) return olderEngine;
  if (listed.code !== 0 && listed.code !== 1) return undefined;
  const lines = listed.stdout.trim().split("\n");
  try {
    const steps: unknown = JSON.parse(lines.at(-1) ?? "");
    return Array.isArray(steps) && steps.every(isLeftStep) ? { steps, clean: listed.code === 0, said: lines.slice(0, -1).filter(Boolean) } : undefined;
  } catch {
    return undefined;
  }
}

const isLeftStep = (step: unknown): step is LeftStep => typeof step === "object" && step !== null && "say" in step && typeof step.say === "string" && (!("command" in step) || typeof step.command === "string");

function applyFailure(host: string, context: DevboxContext, applied: boolean, left: NodeLeft | undefined) {
  const rerun = `then run ${again(context)} again.`;
  const steps = left?.steps ?? [];
  const said = left && !left.clean ? left.said.map((line) => `  ${line}`) : [];
  const failed = said.length ? "what it says above and what hedge doctor there finds below" : "what it says above";
  const intro = !applied
    ? steps.length ? `The devbox could not apply your profile. Do what is left for you on ${host}, and fix ${failed}, ${rerun}` : `The devbox could not apply your profile. Fix ${failed}, ${rerun}`
    : !left ? `Hedge could not read the steps left on ${host}. Run hedge doctor there and fix what it says, ${rerun}`
    : !left.clean ? `Your profile applied on ${host}, but hedge doctor there finds more than steps for you. Fix what it says, ${rerun}`
    : `Your profile applied on ${host}, but steps are left for you there. Do each one, ${rerun}`;
  return [intro, ...said, ...(steps.length ? ["Left for you:", ...yourSteps(host, steps)] : [])].join("\n");
}

/** Claude signs in on the box in an SSH terminal: its sign-in asks for a code that the person pastes. */
function claudeOnBox(host: string, box: Machine, context: DevboxContext): Step {
  const signIn = claudeSignIn(box, host);
  const title = `${signIn.title} on ${host}`;
  return {
    id: `devbox:${host}:claude`,
    title,
    minutes: 1,
    kind: "human",
    async run(): Promise<StepOutcome> {
      const { terminal } = context;
      if (await signIn.probe()) return terminal.print(`  ✓ ${title}: already done`);
      if (context.nonInteractive) return "unanswered";
      context.waited?.();
      terminal.print(`▶ ${title}  (step needs you, about 1 min)`);
      terminal.print("  Open the link it prints, sign in, then paste the code back here.");
      terminal.print(`  $ ssh -t ${host} claude auth login`);
      terminal.release?.();
      await box.run(["claude", "auth", "login"], { input: true });
      if (!(await signIn.probe())) throw new Error(`Claude is not signed in on ${host} yet. Run ${again(context)} again to try once more.`);
      terminal.print(`  ✓ ${title}: done`);
    },
  };
}

export type HubContext = { terminal: Terminal; machine: Machine; self?: string; runtime?: AgentRuntime };

const registerId = (host: string) => `devbox:${host}:register`;
const hubLinkId = (host: string) => `devbox:${host}:hub-link`;
const waitsOnHub = (host: string) => [registerId(host), `devbox:${host}:profile`, hubLinkId(host)];

export const notTakenByHub = (id: string, took: Map<string, boolean>) => [...took].some(([host, taken]) => !taken && waitsOnHub(host).includes(id));

export function hubSteps(host: string, context: HubContext & { profileDir: string | undefined; took: Map<string, boolean> }): { register: Step; link: Step } {
  const hubOf = async () => {
    const hub = context.profileDir ? (await loadProfile(context.profileDir)).hub : undefined;
    return hub && hub !== host ? hub : undefined;
  };
  const register: Step = {
    id: registerId(host),
    title: `List ${host} in your profile`,
    minutes: 1,
    kind: "auto",
    async run() {
      await nameBox(overSsh(context.machine, host), host);
      const listedHub = await listInProfile(context.profileDir, host);
      if (listedHub && listedHub !== host) context.took.set(host, await tellHub(context, listedHub, host));
    },
  };
  const link: Step = {
    id: hubLinkId(host),
    title: `Link ${host} from the hub`,
    minutes: 1,
    kind: "auto",
    async run() {
      const hub = await hubOf();
      if (hub) await linkFromHub(context, hub, host, context.took.get(host) ?? true);
    },
  };
  return { register, link };
}

const hubUpdateLimitMs = 15 * 60_000;
const sshFailed = 255;

/** Lists the devbox in the profile, so the hub and every node know it, and returns the hub the profile names. It pushes on every run, so a push that failed before reaches the remote now. */
export async function listInProfile(profileDir: string | undefined, host: string): Promise<string | undefined> {
  if (!profileDir) return undefined;
  await pullProfile(profileDir);
  const profile = await loadProfile(profileDir);
  const devboxes = profile.devboxes?.includes(host) ? profile.devboxes : [...(profile.devboxes ?? []), host];
  await saveAnswers(profileDir, { devboxes }, { push: true });
  return profile.hub;
}

/** Has the hub take the new node before the node applies its profile, so the hub serves the node's credentials, and its disk watch and tunnels include it. */
export async function tellHub({ machine, terminal }: HubContext, hub: string, host: string): Promise<boolean> {
  terminal.print(`▶ The hub, ${hub}, takes ${host} with hedge update there. This can take some minutes.`);
  const updated = await machine.exec(onHub(hub, ["update"]), { timeoutMs: hubUpdateLimitMs });
  const reason = updated.output.trim().split("\n").at(-1);
  if (updated.code === 0) terminal.print(`✓ The hub, ${hub}, took ${host}: its disk watch, tunnels and credentials include it now.`);
  else if (updated.code === sshFailed || !reason) terminal.print(`· The hub, ${hub}, did not answer. It takes ${host} at its next hedge update, or run hedge update there now.`);
  else terminal.print(`· The hub, ${hub}, could not update: ${reason} Fix that there and run hedge update there; it takes ${host} then.`);
  return updated.code === 0;
}

export async function linkFromHub({ machine, terminal, self, runtime }: HubContext, hub: string, host: string, hubTook: boolean) {
  const onboarding = runtime?.onboarding?.();
  if (!onboarding) return;
  await onboarding.linkFromHub(host, hub, { ...onboardingContext(machine, terminal, `hedge devbox add ${host}`), hubIsHere: self === hub, hubTook });
}
