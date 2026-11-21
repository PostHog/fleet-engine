import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import { cachedSource, fetchSource } from "../pack/sources.ts";
import type { AvailableSource, FetchedSource, MachineFile, Plan, Preset, Profile, SetupProgress, SourceRef } from "../pack/types.ts";
import { divergedFromOrigin, loadMachine, loadProfile, saveMachine, thisMachine } from "../profile/profile.ts";
import { resolve } from "../reconciler/resolve.ts";
import { defaultSources, engineRepo, makesOwnDevbox } from "./defaults.ts";
import { FlagError, hasPicks, parseSetupFlags, type SetupFlags } from "./flags.ts";
import { answered, packList, packsStep, picksFrom, title, plansStep, settingSteps, settingsFrom, waitsForTeams, type Catalog, type Draft, type QuestionContext } from "./questions.ts";
import { realMachine, type Machine } from "./commands.ts";
import { humanStep, optionalStep, packSignIn, type HumanContext, type SignIn } from "./human.ts";
import { devboxQuestion, devboxSteps, hubSteps, notTakenByHub, profileForBox, type DevboxContext } from "./devbox.ts";
import { packRuntimes } from "../runtime/load.ts";
import type { AgentRuntime } from "../sdk/runtime.ts";
import { doneScreen, finalCheck, repoName, runsByItself } from "./done.ts";
import { readTimings, usableSeconds } from "../commands/triage-record.ts";
import { existingProfile, fetchOrigin, profileStep, saveSettings, takeFetched } from "./profile.ts";
import { runSteps, type Step } from "./runner.ts";
import { chatgptSignIn, claudeSignIn, githubSignIn, memberSources } from "./signins.ts";
import { Stopped, type Terminal } from "./terminal.ts";
import { openTimings } from "./timings.ts";

export type SetupOptions = {
  home: string;
  engineRoot: string;
  platform: NodeJS.Platform;
  terminal: Terminal;
  machine?: Partial<Machine>;
  fetchSource?: (ref: SourceRef, cacheRoot: string) => Promise<FetchedSource>;
  /** Runs hedge apply with this profile, leaving the skipped steps (pack/id) for a later apply, and prints its report. */
  apply?: (profileDir: string, skip?: string[]) => Promise<number>;
  /** Runs hedge doctor with this profile and prints its report. */
  doctor?: (profileDir: string) => Promise<number>;
  /** This machine's IANA time zone, which picks a setting's time-zone default. */
  timeZone?: string;
  /** The environment the standalone check reads, and that tells a Coder workspace apart. */
  env?: Record<string, string | undefined>;
  clock?: { now(): number };
};

/** Steps that run again when the command changes an answer: the profile saves it, apply puts it on this machine, and the check confirms it. */
const answersChanged = ["profile", "apply", "apply-codex", "check"];

const checked = (done: string[] = []) => done.some((id) => id === "check" || id.startsWith("check:"));

export const sourceCache = (home: string) => join(home, ".local", "share", "hedge", "sources");

export async function setup(args: string[], options: SetupOptions): Promise<number> {
  const clock = options.clock ?? Date;
  let waits = 0;
  const terminal: Terminal = { ...options.terminal, ask: (prompt) => (waits++, options.terminal.ask(prompt)) };
  let flags: SetupFlags;
  const machine: MachineFile = thisMachine(await loadMachine(options.home), options.platform, options.env ?? process.env);
  const unfinished = Boolean(machine.setup?.done.length) && !checked(machine.setup?.done);
  const box: Machine = { ...realMachine, ...options.machine };
  if (machine.profileDir) await fastForward(box, options.home, machine.profileDir, terminal.print);
  const progress = { done: machine.setup?.done ?? [], draft: machine.profileDir ? profileDraft(await loadProfile(machine.profileDir)) : withInferred(machine.setup ?? { done: [] }) };
  const catalog = await loadCatalog(options.engineRoot, teamRefs(progress.draft), options.home);
  const runtimes = await packRuntimes(catalog.packs);
  const remember = () => saveMachine(options.home, { ...machine, setup: machine.profileDir ? { done: progress.done } : { done: progress.done, ...withoutInferred(progress.draft) } });
  const fetchTeam = (ref: SourceRef) => (options.fetchSource ?? fetchSource)(ref, sourceCache(options.home));
  if (progress.done.includes("github")) {
    catalog.teamsKnown = true;
    for (const ref of teamRefs(progress.draft)) {
      if (catalog.sources.some((source) => source.ref.name === ref.name)) continue;
      const fetched = await fetchTeam(ref);
      if ("error" in fetched) terminal.print(`  · The ${ref.name} pack could not be fetched (${fetched.error}). Setup goes on without it.`);
      else catalog.add(fetched);
    }
  }
  try {
    flags = parseSetupFlags(args);
    const saved = progress.draft;
    const picked = picksFrom(flags, catalog, saved);
    const fromFlags = settingsFrom(flags, catalog);
    const reopened = [
      ...(hasPicks(flags) && JSON.stringify(picked) !== JSON.stringify({ packs: saved.packs, workflows: saved.workflows ?? {} }) ? ["packs"] : []),
      ...(flags.plan && flags.plan !== saved.plan ? ["plans"] : []),
    ];
    if (reopened.length || Object.entries(fromFlags).some(([key, value]) => saved.settings?.[key] !== value)) reopened.push(...answersChanged);
    progress.done = progress.done.filter((id) => !reopened.some((step) => id === step || id.startsWith(`${step}:`)));
    if (Object.keys(fromFlags).length && !waitsForTeams(flags, catalog)) {
      Object.assign(progress.draft, answered(progress.draft, fromFlags));
      await remember();
    }
  } catch (error) {
    if (!(error instanceof FlagError)) throw error;
    terminal.print(`hedge setup: ${error.message}`);
    return 2;
  }
  const appliedWhole = checked(progress.done) && !progress.done.includes("apply-codex");
  const context: QuestionContext = {
    terminal,
    flags,
    catalog,
    draft: progress.draft,
    timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    draftMayBeBehind: Boolean(machine.profileDir),
    async answer(fields) {
      Object.assign(progress.draft, fields);
      await remember();
    },
  };
  const human: HumanContext = { terminal, machine: box, nonInteractive: flags.nonInteractive, chat: flags.chat, waited: () => void waits++ };
  const addTeamSources = async () => {
    for (const ref of await memberSources(box)) {
      if (catalog.sources.some((source) => source.ref.name === ref.name)) continue;
      const fetched = await fetchTeam(ref);
      if ("error" in fetched) {
        terminal.print(`  · You are in the ${ref.repo.split("/")[0]} org, but its pack could not be fetched (${fetched.error}). Setup goes on without it.`);
        continue;
      }
      catalog.add(fetched);
      const ticked = fetched.packs.map((pack) => pack.manifest.name).filter((name) => !flags.remove.includes(name));
      const picked = progress.draft.packs ? { packs: [...new Set([...progress.draft.packs, ...ticked])] } : {};
      await context.answer({ sources: [...(progress.draft.sources ?? defaultSources), ref], ...picked });
      terminal.print(`  ✓ You are in the ${ref.repo.split("/")[0]} org, so the ${packList(fetched.packs.map((pack) => pack.manifest.name), catalog)} pack is ticked`);
    }
    catalog.teamsKnown = true;
    if (!machine.profileDir) await startFromExisting();
    picksFrom(flags, catalog, progress.draft);
    const fromFlags = settingsFrom(flags, catalog);
    if (Object.keys(fromFlags).length) await context.answer(answered(progress.draft, fromFlags));
  };
  const startFromExisting = async () => {
    const existing = await existingProfile(box, options.home, catalog.packs.map((pack) => pack.manifest), progress.draft.packs ?? catalog.teamPacks);
    if (!existing) return;
    const saved = profileDraft(existing);
    const sources = [...existing.sources, ...(progress.draft.sources ?? []).filter((ref) => !existing.sources.some((kept) => kept.name === ref.name))];
    await context.answer({ ...saved, ...(hasPicks(flags) ? picksFrom(flags, catalog, saved) : {}), plan: flags.plan ?? progress.draft.plan ?? saved.plan, sources, settings: { ...existing.settings, ...progress.draft.settings } });
  };
  const profile = profileStep({
    terminal,
    machine: box,
    home: options.home,
    engineRoot: options.engineRoot,
    nonInteractive: flags.nonInteractive,
    draft: progress.draft,
    ...(machine.profileDir ? { current: machine.profileDir } : {}),
    packs: () => catalog.packs.map((pack) => pack.manifest),
    async saved(dir) {
      machine.profileDir = dir;
      await remember();
    },
  });
  const applyProfile = async (skip: string[]) => {
    if (!machine.profileDir || !options.apply) throw new Error("no profile to apply yet");
    if ((await options.apply(machine.profileDir, skip)) !== 0) throw new Error("hedge apply could not set up this machine. Fix what it says above, then run hedge setup again.");
    const applied = await loadMachine(options.home);
    if (applied) Object.assign(machine, { role: applied.role }, applied.name ? { name: applied.name } : {});
  };
  const applySteps = (codexOnly: string[]): Step[] => {
    const title = machine.role === "mac" ? "Set up this Mac" : "Set up this machine";
    const first: Step = {
      id: "apply",
      title,
      minutes: 3,
      kind: "auto",
      async run() {
        terminal.print(`▶ ${title}: hedge apply installs your packs`);
        await applyProfile(codexOnly);
      },
    };
    const codex: Step = {
      id: "apply-codex",
      title: "Install Codex",
      minutes: 1,
      kind: "auto",
      async run() {
        terminal.print("▶ Install Codex: hedge apply installs what only Codex needs");
        await applyProfile([]);
      },
    };
    return codexOnly.length ? [first, later(codex)] : [first];
  };
  const question = devboxQuestion({
    terminal,
    home: options.home,
    flag: flags.devbox,
    nonInteractive: flags.nonInteractive,
    async answer(host) {
      machine.devboxes = host ? [host] : [];
      await remember();
    },
  });
  const hubTook = new Map<string, boolean>();
  const devbox: Devbox = {
    question,
    runtime: (name) => (name === undefined ? undefined : runtimes.get(name)),
    pushed: (step) => ({
      ...step,
      async run() {
        const outcome = await step.run();
        if (outcome !== "unanswered" && machine.profileDir) await saveSettings(box, machine.profileDir, progress.draft.settings ?? {});
        return outcome;
      },
    }),
    steps: (host, plan) => {
      const runtime = devbox.runtime(plan.runtime);
      const hub = hubSteps(host, { terminal, machine: box, profileDir: machine.profileDir, took: hubTook, runtime });
      return [hub.register, ...devboxSteps(host, { terminal, machine: box, nonInteractive: flags.nonInteractive, chat: flags.chat, waited: human.waited, plan: plan.ai, models: plan.models, profile: () => profileForBox(box, machine.profileDir), runtime }), hub.link];
    },
  };
  const check = () =>
    finalCheck({
      terminal,
      machine: box,
      home: options.home,
      env: options.env ?? process.env,
      devboxes: machine.devboxes ?? [],
      doctor: () => (machine.profileDir && options.doctor ? options.doctor(machine.profileDir) : Promise.resolve(1)),
    });
  const steps = () => [...setupSteps(context, machine, options, human, addTeamSources, (codexOnly) => [profile, ...applySteps(appliedWhole ? [] : codexOnly)], devbox), later(check())];
  const timings = openTimings(options.home, clock.now(), unfinished);
  try {
    const result = await runSteps(steps, {
      terminal,
      clock,
      waits: () => waits,
      record: (step) => timings.record(step),
      async usable(later) {
        await timings.usable(clock.now());
        const runtime = devbox.runtime(planFor(context, machine).plan.runtime);
        if (later.length) terminal.print(`\n✓ Ready to use. Start a new thread${runtime ? ` in ${runtime.title}` : ""} now. Setup goes on with: ${later.join(", ")}.`);
      },
      done: progress.done,
      async save(done) {
        progress.done = done.filter((id) => !notTakenByHub(id, hubTook));
        await remember();
      },
    });
    if (result.unanswered.length) return printNeeds(terminal, steps(), result.unanswered), 2;
    const { plan } = planFor(context, machine);
    const summary = {
      role: machine.role,
      ...(devbox.runtime(plan.runtime) ? { runtime: devbox.runtime(plan.runtime)!.title } : {}),
      packs: plan.packs.filter((pack) => pack.available && pack.name !== "base").map((pack) => title(pack.name, catalog.packs)),
      devboxes: machine.devboxes ?? [],
      profileRepo: repoName((await profileForBox(box, machine.profileDir)).url),
      runsByItself: runsByItself(
        plan,
        catalog.packs.map((pack) => pack.manifest),
        (machine.devboxes ?? []).map((host) => ({ host, plan: planFor(context, { ...machine, role: "devbox" }).plan })),
      ),
      usableSeconds: usableSeconds(readTimings(options.home)),
    };
    for (const line of doneScreen(summary)) terminal.print(line);
    return 0;
  } catch (error) {
    if (error instanceof FlagError) {
      terminal.print(`hedge setup: ${error.message}`);
      return 2;
    }
    if (!(error instanceof Stopped)) throw error;
    const next = steps().find((step) => !progress.done.includes(step.id));
    terminal.print("");
    terminal.print(`Stopped. Run hedge setup again to pick up${next ? ` at ${next.title}` : ""}.`);
    return 130;
  }
}

type Devbox = { question: Step; runtime(name: string | undefined): AgentRuntime | undefined; pushed(step: Step): Step; steps(host: string, plan: { ai: DevboxContext["plan"]; models: DevboxContext["models"]; runtime?: string }): Step[] };

function planFor(context: QuestionContext, machine: MachineFile) {
  const draft = context.draft.packs ? context.draft : { ...context.draft, ...picksFrom(context.flags, context.catalog) };
  const profile = draftProfile(draft);
  const fetched = new Set(context.catalog.sources.map((source) => source.ref.name));
  return { profile, plan: resolve(profile, machine, [...context.catalog.sources, ...profile.sources.filter((ref) => !fetched.has(ref.name)).map(notFetched)]) };
}

function setupSteps(context: QuestionContext, machine: MachineFile, options: SetupOptions, human: HumanContext, signedIn: () => Promise<void>, machineSteps: (codexOnly: string[]) => Step[], devbox: Devbox): Step[] {
  const { profile, plan } = planFor(context, machine);
  const box = human.machine;
  const sshDevbox = !makesOwnDevbox(profile.packs) && (machine.role === "mac" || machine.role === "linux");
  const waitsForSignIns = !human.nonInteractive || human.chat === true;
  const devboxAsked = !sshDevbox || machine.devboxes !== undefined || context.flags.devbox !== undefined;
  const codexOnly = plan.ai === "both" && waitsForSignIns ? plan.steps.filter((step) => step.plans && !step.plans.includes("claude")).map((step) => `${step.pack}/${step.id}`) : [];
  const devboxAsk = sshDevbox && machine.devboxes?.length ? planFor(context, { ...machine, role: "devbox" }).plan.ask.filter((setting) => !plan.ask.some((asked) => asked.key === setting.key)) : [];
  return [
    bootstrapStep(context.terminal, box.has, devbox.runtime(plan.runtime)),
    humanStep(githubSignIn(box, signedIn), human),
    packsStep(context),
    plansStep(context),
    ...settingSteps(context, plan.ask),
    ...machineSteps(codexOnly),
    ...plan.human.map((step) => humanStep(packSignIn(step, plan.steps, human, plan.engineRoot), human)).map((step) => (devboxAsked ? later(step) : step)),
    ...(sshDevbox ? [devbox.question] : []),
    ...settingSteps(context, devboxAsk).map(devbox.pushed),
    ...(plan.ai === "codex" ? [] : [humanStep(claudeSignIn(box), human)]),
    ...(plan.ai === "claude" ? [] : [chatgptStep(chatgptSignIn(box, plan.models), human, plan)].map((step) => (plan.ai === "both" ? later(step) : step))),
    ...(sshDevbox ? (machine.devboxes ?? []).flatMap((host) => devbox.steps(host, plan)).map(later) : []),
  ];
}

const later = (step: Step): Step => ({ ...step, later: true });

const proxyServesCodex = "With own-account balancing on, Codex goes through the proxy on the hub once it holds one of your ChatGPT subscriptions, so setup does not need this sign-in. Codex here needs it only until then.";

function chatgptStep(signIn: SignIn, human: HumanContext, plan: Plan): Step {
  const balanced = plan.workflows.some((workflow) => workflow.id === "own-account-balancing" && workflow.active);
  return balanced ? optionalStep(signIn, human, proxyServesCodex) : humanStep(signIn, human);
}

async function fastForward(box: Machine, home: string, dir: string, print: (line: string) => void) {
  const unreached = await fetchOrigin(box, home, dir);
  if (unreached !== undefined) return print(`  · Your profile's origin could not be reached (${unreached}). Setup goes on with the copy in ${dir}.`);
  const failed = await takeFetched(box, dir);
  if (failed && Number((await box.exec(["git", "-C", dir, "rev-list", "--count", "@{upstream}..HEAD"])).output.trim()) > 0) throw new Error(divergedFromOrigin(dir));
  if (failed) throw new Error(`could not take the new commits of your profile in ${dir}: ${failed.output.trim().split("\n").at(-1)}. Run git -C ${dir} pull, then run hedge setup again.`);
}

function withInferred({ draft, inferred }: SetupProgress): Draft {
  if (!inferred) return { ...draft } as Draft;
  return { ...draft, settings: { ...inferred, ...draft?.settings }, inferred: Object.keys(inferred) };
}

function withoutInferred({ inferred, ...draft }: Draft): Pick<SetupProgress, "draft" | "inferred"> {
  if (!inferred?.length) return { draft };
  const settings = Object.entries(draft.settings ?? {});
  return { draft: { ...draft, settings: Object.fromEntries(settings.filter(([key]) => !inferred.includes(key))) }, inferred: Object.fromEntries(settings.filter(([key]) => inferred.includes(key))) };
}

function profileDraft(profile: Profile): Draft {
  return { packs: profile.packs, plan: profile.plan, settings: profile.settings, workflows: profile.workflows, sources: profile.sources };
}

function teamRefs(draft: Draft) {
  const skills = new Set(defaultSources.map((source) => source.name));
  return (draft.sources ?? []).filter((source) => !skills.has(source.name));
}

function bootstrapStep(terminal: Terminal, has: Machine["has"], runtime: AgentRuntime | undefined): Step {
  return {
    id: "bootstrap",
    title: "Install the basics",
    minutes: 4,
    kind: "auto",
    async run() {
      const tool = runtime?.onboarding?.().tool;
      const missing = ["git", "gh", "bun", ...(tool ? [tool] : [])].filter((name) => !has(name));
      if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Install them with get.sh, then run hedge setup again.`);
      terminal.print(tool ? `  ✓ Git, gh, Bun and ${runtime!.title} are installed` : "  ✓ Git, gh and Bun are installed");
    },
  };
}

export function draftProfile(draft: Draft, dir = ""): Profile {
  return {
    schema: 1,
    dir,
    engine: { repo: engineRepo, ref: "main", channel: "release" },
    sources: draft.sources ?? defaultSources,
    packs: draft.packs ?? [],
    plan: draft.plan ?? "both",
    settings: draft.settings ?? {},
    workflows: draft.workflows ?? {},
  };
}

function notFetched(ref: SourceRef): FetchedSource {
  return { ref, error: "not fetched during the questions" };
}

/** The engine's packs plus each team source this machine has fetched, such as an org's private pack. */
export async function loadCatalog(engineRoot: string, team: SourceRef[], home: string): Promise<Catalog> {
  const presets = (await Bun.file(join(engineRoot, "presets.json")).json()) as Preset[];
  const engine: AvailableSource = { ref: { name: "engine", repo: engineRepo, ref: "main" }, dir: engineRoot, packs: await loadPacks(engineRoot) };
  const catalog: Catalog = {
    presets,
    sources: [engine],
    packs: [...engine.packs],
    teamPacks: [],
    teamsKnown: false,
    add(source) {
      catalog.sources.push(source);
      catalog.packs.push(...source.packs);
      catalog.teamPacks.push(...source.packs.map((pack) => pack.manifest.name));
    },
  };
  for (const ref of team) {
    const cached = await cachedSource(ref, sourceCache(home));
    if (!("error" in cached)) catalog.add(cached);
  }
  return catalog;
}

function printNeeds(terminal: Terminal, steps: Step[], open: string[]) {
  terminal.print("");
  terminal.print("hedge setup --non-interactive needs these answers and sign-ins. Add the answers to the command and run it again:");
  for (const step of steps.filter((item) => open.includes(item.id))) {
    if (step.kind === "question") terminal.print(`  --set ${step.id.replace(/^setting:/, "")}=<value>   ${step.title}`);
    else terminal.print(`  ${step.title}: do it once in a terminal, then run hedge setup again`);
  }
}
