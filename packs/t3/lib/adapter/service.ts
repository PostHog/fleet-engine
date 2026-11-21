import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkParents } from "../../../../src/files/install.ts";
import { writePrivateFile } from "../../../../src/files/private.ts";
import type { Finding } from "../../../../src/pack/types.ts";
import type { AdapterResult } from "../../../../src/reconciler/apply.ts";
import type { CommandRunner } from "../../../../src/adapters/run.ts";

export type Wait = (ms: number) => Promise<void>;
export type Environment = Record<string, string | undefined>;

const bounded = ["--connect-timeout", "20", "--speed-limit", "1024", "--speed-time", "60"];
const releasesFeed = "https://github.com/pingdotgg/t3code/releases.atom";
const nightlyTag = /\/releases\/tag\/v([0-9][0-9.]*-nightly\.[0-9]+\.[0-9]+)"/;
const installScript = `installer=$(mktemp) && curl -fsSL ${bounded.join(" ")} https://t3.codes/install.sh -o "$installer" && T3CODE_CHANNEL=nightly sh "$installer"; code=$?; rm -f "$installer"; exit $code`;
const tries = 3;

const installT3 = (version: string) => ["env", `T3CODE_VERSION=${version}`, "/bin/sh", "-c", installScript];

async function retried(attempt: () => ReturnType<CommandRunner>, wait: Wait) {
  for (let tried = 1; ; tried++) {
    const result = await attempt();
    if (result.code === 0 || tried === tries) return result;
    await wait(tried * 1000);
  }
}

async function newestNightly(run: CommandRunner, wait: Wait) {
  const feed = await retried(() => run(["curl", "-fsSL", ...bounded, releasesFeed]), wait);
  return feed.code === 0 ? (feed.stdout.match(nightlyTag)?.[1] ?? "") : "";
}

const finding = (id: string, say: string, repair: Finding["repair"]): Finding => ({ id: `t3:${id}`, pack: "engine", say, repair });

const tokenFolder = ".config/claude-env";
const tokenFile = `${tokenFolder}/oauth.env`;
const pendingFile = `${tokenFolder}/restart-pending`;
const tokenDropIn = ".config/systemd/user/t3code.service.d/claude-token.conf";
const dropInText = `[Service]\nEnvironmentFile=%h/${tokenFile}\n`;
const tokenShape = /^[A-Za-z0-9._~+/=-]+$/;
const needsReload = "reload";
export const restartCommand = "systemctl --user restart t3code.service";

const tokenFinding = (say: string, repair: Finding["repair"] = "human") => finding("claude-token", say, repair);

const readOr = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Only a missing file reads as absent. Any other error throws, so a file Hedge cannot read is never taken for one it may write. */
const readIfThere = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const invocationId = /^[0-9a-f]{32}$/;

/** What the restart marker owes: nothing, a reload, or a restart of the T3 Code started under that invocation. A marker Hedge did not write owes a reload again, so a spoiled marker never drops the token. */
async function owedRestart(pending: string): Promise<string | undefined> {
  const marker = lstatSync(pending, { throwIfNoEntry: false });
  if (!marker) return undefined;
  const text = marker.isFile() ? readOr(pending) : undefined;
  if (text === needsReload || (text !== undefined && invocationId.test(text))) return text;
  rmSync(pending, { recursive: true, force: true });
  await writePrivateFile(pending, needsReload);
  return needsReload;
}

const privateMode = (path: string, mode: number) => (lstatSync(path, { throwIfNoEntry: false })?.mode ?? 0) % 0o1000 === mode;

async function realFolders(home: string, targets = [tokenFile, tokenDropIn]) {
  try {
    for (const target of targets) await checkParents(home, target);
    return true;
  } catch {
    return false;
  }
}

const insideT3 = (env: Environment) => Boolean(env.T3CODE_THREAD_ID || env.T3CODE_PORT);

async function invocation(run: CommandRunner) {
  const shown = await run(["systemctl", "--user", "show", "t3code.service", "--property=InvocationID", "--value"]);
  return shown.code === 0 ? shown.stdout.trim() : undefined;
}

async function loadToken(run: CommandRunner, env: Environment, pending: string, result: AdapterResult) {
  let loadedAt = await owedRestart(pending);
  if (loadedAt === needsReload) {
    if ((await run(["systemctl", "--user", "daemon-reload"])).code !== 0) return void result.findings.push(tokenFinding(`systemd did not reload T3 Code's service, so T3 Code runs without the Claude token. Run hedge apply again, or run: systemctl --user daemon-reload && ${restartCommand}`));
    loadedAt = await invocation(run);
    if (loadedAt !== undefined && invocationId.test(loadedAt)) await writePrivateFile(pending, loadedAt);
  } else if (loadedAt !== undefined) {
    const now = await invocation(run);
    if (now !== undefined && now !== loadedAt) return void rmSync(pending, { force: true });
  }
  if (insideT3(env)) return void result.findings.push(tokenFinding(`T3 Code picks up the Claude token at its next restart. Hedge did not restart it, because this apply runs inside T3 Code and the restart would end it. From a shell outside T3 Code, run: ${restartCommand}`));
  if ((await run(["systemctl", "--user", "try-restart", "t3code.service"])).code !== 0) return void result.findings.push(tokenFinding(`T3 Code did not restart with the new Claude token. Run hedge apply again, or run: ${restartCommand}`));
  rmSync(pending, { force: true });
}

/** T3 Code's user service does not inherit the session, so a Claude token that the session gets from its environment reaches T3 through a file. A drop-in that Hedge did not write stays. */
export async function reconcileClaudeToken(run: CommandRunner, home: string, env: Environment, dryRun: boolean, result: AdapterResult) {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return;
  if (!tokenShape.test(token)) return void result.findings.push(tokenFinding("CLAUDE_CODE_OAUTH_TOKEN in this session has characters that a Claude token does not use, so Hedge did not give it to T3 Code. Set it again from claude setup-token, then run hedge apply."));
  if (!(await realFolders(home))) return void result.findings.push(tokenFinding(`Hedge did not give the Claude token to T3 Code, because a folder on the way to ~/${tokenFile} or ~/${tokenDropIn} is a link or not a folder. Make them plain folders in your home, then run hedge apply.`));
  const file = join(home, tokenFile);
  const dropIn = join(home, tokenDropIn);
  const pending = join(home, pendingFile);
  let present: string | undefined;
  try {
    present = readIfThere(dropIn);
  } catch {
    return void result.findings.push(tokenFinding(`Hedge cannot read ~/${tokenDropIn}, so it leaves that file alone and does not give the Claude token to T3 Code. Make the file readable, or remove it if Hedge wrote it, then run hedge apply.`));
  }
  if (present !== undefined && present !== dropInText) return;
  const wanted = `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
  const written = present === dropInText && readOr(file) === wanted && privateMode(file, 0o600) && privateMode(join(home, tokenFolder), 0o700);
  if (written && lstatSync(pending, { throwIfNoEntry: false }) === undefined) return;
  if (dryRun) return void result.findings.push(tokenFinding("T3 Code's service needs the Claude token that this session has.", "apply"));
  if (!written) {
    mkdirSync(join(home, tokenFolder), { recursive: true, mode: 0o700 });
    chmodSync(join(home, tokenFolder), 0o700);
    await writePrivateFile(pending, needsReload);
    await writePrivateFile(file, wanted);
    mkdirSync(dirname(dropIn), { recursive: true });
    await writePrivateFile(dropIn, dropInText);
    result.actions.push({ target: "t3 claude token", operation: present === undefined ? "create" : "replace" });
  }
  await loadToken(run, env, pending, result);
}

export async function reconcileService(run: CommandRunner, wait: Wait, user: string, dryRun: boolean, result: AdapterResult) {
  const present = async () => (await run(["t3", "--version"])).code === 0;
  let cli = await present();
  if (!cli && dryRun) result.findings.push(finding("cli", "T3 Code needs to be installed from the nightly channel.", "apply"));
  else if (!cli) {
    const version = await newestNightly(run, wait);
    const installed = await retried(() => run(installT3(version)), wait);
    if (installed.code !== 0) return void result.findings.push(finding("cli", `T3 Code did not install (exit ${installed.code}). Run hedge apply again.`, "apply"));
    if (!(await present())) return void result.findings.push(finding("cli", "T3 Code installed, but t3 is not on your PATH. Add ~/.local/bin to PATH, then run hedge apply.", "human"));
    cli = true;
    result.actions.push({ target: "t3", operation: "create", reason: "nightly channel" });
  }
  const manager = await userManager(run, wait, user, dryRun, result);
  if (manager !== "answers") {
    const lingerOn = typeof manager === "object" ? ` Hedge could not turn on lingering for ${user}: sudo -n loginctl enable-linger ${user} failed: ${manager.refused}. Run: sudo loginctl enable-linger ${user}, then run hedge apply. Without sudo,` : "";
    return void result.findings.push(finding("service", `T3 Code cannot run as a service: systemd's user manager does not answer (systemctl --user).${lingerOn}${lingerOn ? " log" : " Log"} in to this machine in a normal session, or install your system's systemd user-session support, then run hedge apply.`, "human"));
  }
  const linger = (await run(["loginctl", "show-user", user, "--property=Linger", "--value"])).stdout.trim();
  if (linger === "no" && !dryRun && (await run(["sudo", "-n", "loginctl", "enable-linger", user])).code === 0) result.actions.push({ target: "t3 linger", operation: "create" });
  else if (linger === "no") result.findings.push(finding("linger", `T3 Code stops when you log out, because lingering is off for ${user}. Run: sudo loginctl enable-linger ${user}`, "human"));
  else if (linger !== "yes") result.findings.push(finding("linger", `Hedge cannot tell whether T3 Code keeps running after you log out. Check with: loginctl show-user ${user} --property=Linger`, "human"));
  if (!cli) return void result.findings.push(finding("service", "T3 Code's service needs to be installed.", "apply"));
  const status = await run(["t3", "service", "status"]);
  if (status.code !== 0) return void result.findings.push(finding("service", `Hedge could not read the T3 Code service status (exit ${status.code}). Run t3 service status to see why.`, "human"));
  if (/Status: installed/.test(status.stdout)) return;
  if (/Status: unavailable/.test(status.stdout)) return void result.findings.push(finding("service", "T3 Code says it cannot run as a service on this machine. It needs Linux with systemd.", "human"));
  if (dryRun) return void result.findings.push(finding("service", "T3 Code's service needs to be installed.", "apply"));
  const installed = await run(["t3", "service", "install"]);
  if (installed.code !== 0) return void ((result.failed = true), result.findings.push(finding("service", `t3 service install failed (exit ${installed.code}). Run it yourself to see why, then run hedge apply.`, "apply")));
  result.actions.push({ target: "t3 service", operation: "create" });
}

const needsUserBus = (command: string[]) => (command[0] === "systemctl" && command[1] === "--user") || (command[0] === "t3" && command[1] === "service");

export function onUserBus(run: CommandRunner, env: Environment, uid: number): CommandRunner {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const bus = env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`;
  return (command, options) => run(needsUserBus(command) ? ["env", `XDG_RUNTIME_DIR=${runtime}`, `DBUS_SESSION_BUS_ADDRESS=${bus}`, ...command] : command, options);
}

const managerStartMs = 1000;
const managerStartTries = 10;

async function userManager(run: CommandRunner, wait: Wait, user: string, dryRun: boolean, result: AdapterResult) {
  const answers = async () => (await run(["systemctl", "--user", "show-environment"])).code === 0;
  if (await answers()) return "answers";
  if (dryRun) return "silent";
  const linger = await run(["sudo", "-n", "loginctl", "enable-linger", user]);
  if (linger.code !== 0) return { refused: lastLine(`${linger.stderr ?? ""}\n${linger.stdout}`) || `exit ${linger.code}` };
  result.actions.push({ target: "t3 linger", operation: "create", reason: "systemd's user manager starts only for a lingering user over SSH" });
  for (let tries = 0; tries < managerStartTries; tries++) {
    await wait(managerStartMs);
    if (await answers()) return "answers";
  }
  return "silent";
}

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

export const timeZoneSetting = "base.t3TimeZone";
const timeZoneDropIn = ".config/systemd/user/t3code.service.d/hedge-timezone.conf";
const timeZoneRecord = ".config/hedge/t3-timezone.conf";
const timeZoneText = (zone: string) => `[Service]\nEnvironment=TZ=${zone}\n`;
const zoneName = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/;
const timeZoneFinding = (say: string, repair?: Finding["repair"]) => ({ id: "t3:timezone", pack: "engine", say, ...(repair ? { repair } : {}) });

/** Bun's list misses valid names such as Etc/UTC and GMT, so a name also counts when the system's zone files hold it with the exact case. */
function knownZone(zone: string, zoneInfo: string) {
  if (!zoneName.test(zone)) return false;
  if (Intl.supportedValuesOf("timeZone").includes(zone)) return true;
  let path = zoneInfo;
  for (const part of zone.split("/")) {
    try {
      if (!readdirSync(path).includes(part)) return false;
    } catch {
      return false;
    }
    path = join(path, part);
  }
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

async function restore(path: string, text: string | undefined) {
  if (text === undefined) rmSync(path, { force: true });
  else await writePrivateFile(path, text);
}

/** Hedge changes or removes the drop-in only while it matches what Hedge recorded writing. Any other drop-in, such as one an older Hedge or you wrote, stays as it is. */
export async function reconcileTimeZone(run: CommandRunner, home: string, zone: string, dryRun: boolean, result: AdapterResult, zoneInfo = "/usr/share/zoneinfo") {
  if (zone && !knownZone(zone, zoneInfo)) return void result.findings.push(timeZoneFinding(`${timeZoneSetting} is ${zone}, which is not a time zone. Use an IANA name, such as Europe/Berlin, or leave it empty for the machine's zone.`, "human"));
  const dropIn = join(home, timeZoneDropIn);
  const record = join(home, timeZoneRecord);
  let present: string | undefined;
  let recorded: string | undefined;
  try {
    present = readIfThere(dropIn);
    recorded = readIfThere(record);
  } catch {
    return void result.findings.push(timeZoneFinding(`Hedge cannot read ~/${timeZoneDropIn} or ~/${timeZoneRecord}, so it leaves T3 Code's time zone alone. Make the files readable, then run hedge apply.`, "human"));
  }
  const wanted = zone ? timeZoneText(zone) : undefined;
  if (present !== undefined && present !== recorded) {
    if (wanted && present !== wanted) result.findings.push(timeZoneFinding(`~/${timeZoneDropIn} is not Hedge's, so Hedge does not set T3 Code's time zone to ${zone}. Remove the file, then run hedge apply.`, "human"));
    return;
  }
  if (present === wanted) {
    if (!dryRun && present === undefined && recorded !== undefined) rmSync(record, { force: true });
    return;
  }
  if (dryRun) return void result.findings.push(timeZoneFinding(zone ? `T3 Code's service needs to run in ${zone}.` : "T3 Code's service needs to return to the machine's time zone.", "apply"));
  if (!(await realFolders(home, [timeZoneDropIn, timeZoneRecord]))) return void result.findings.push(timeZoneFinding(`Hedge did not set T3 Code's time zone, because a folder on the way to ~/${timeZoneDropIn} or ~/${timeZoneRecord} is a link or not a folder. Make them plain folders in your home, then run hedge apply.`, "human"));
  if (wanted) {
    mkdirSync(dirname(record), { recursive: true });
    await writePrivateFile(record, wanted);
    mkdirSync(dirname(dropIn), { recursive: true });
    await writePrivateFile(dropIn, wanted);
  } else {
    rmSync(dropIn, { force: true });
    rmSync(record, { force: true });
  }
  result.actions.push({ target: "t3 time zone", operation: wanted ? (present === undefined ? "create" : "replace") : "remove" });
  if ((await run(["systemctl", "--user", "daemon-reload"])).code !== 0) {
    await restore(dropIn, present);
    await restore(record, recorded);
    result.actions.pop();
    return void result.findings.push(timeZoneFinding("systemd did not reload T3 Code's service, so Hedge left its time zone as it was. Run hedge apply again.", "apply"));
  }
  result.findings.push(timeZoneFinding(`T3 Code runs in ${zone || "the machine's time zone"} from its next restart, such as the nightly update. Hedge does not restart it now, because a restart ends running agent turns. To switch now, run: ${restartCommand}`));
}
