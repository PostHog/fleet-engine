import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fleetAdapter } from "./adapters/fleet/adapter.ts";
import { jobsAdapter } from "./adapters/jobs/adapter.ts";
import type { CommandRunner } from "./adapters/run.ts";
import { main } from "./cli.ts";
import { fleetIsHedge, legacyPaths, underLegacyPath } from "./legacy.ts";
import { saveAnswers, saveMachine } from "./profile/profile.ts";
import { secretCommand } from "../packs/hub/lib/secret-cli.ts";
import { filesAdapter, type Adapter } from "./reconciler/apply.ts";
import { fakeLaunchd } from "./testing/old-fleet.ts";
import { fakeSystemd } from "./testing/systemd.ts";
import { cliFixtures, repoRoot } from "./testing/cli.ts";
import { git, tempDirs } from "./testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const { profileDir, hedge } = cliFixtures(temp);

type Machine = { home: string; hedge(args: string[]): Promise<{ code: number; output: string }> };

function linuxMachine(home = temp.make("home-")) {
  const systemd = fakeSystemd();
  const cron = { text: "" };
  const run: CommandRunner = async (command, options) => {
    if (command.join(" ") === "crontab -l") return { code: 0, stdout: cron.text };
    if (command.join(" ") === "crontab -") return (cron.text = options?.input ?? ""), { code: 0, stdout: "" };
    return systemd.run(command, options);
  };
  return { home, systemd, hedge: machineCommand(home, "linux", run) };
}

function macMachine() {
  const home = temp.make("home-");
  const launchd = fakeLaunchd();
  return { home, launchd, hedge: machineCommand(home, "darwin", launchd.run) };
}

function machineCommand(home: string, platform: NodeJS.Platform, run: CommandRunner) {
  const adapters = (): Adapter[] => [fleetAdapter({ run, uid: 501, accountHome: async () => home, tasks: async () => undefined }), filesAdapter, jobsAdapter({ run, engineRoot: repoRoot, uid: 501, accountHome: async () => home })];
  return async (args: string[]) => {
    const lines: string[] = [];
    const code = await main(args, { home, engineRoot: repoRoot, platform, env: {}, print: (line) => lines.push(line), run: async () => 0, adapters });
    return { code, output: lines.join("\n") };
  };
}

function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (path: string, key: string) => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return;
    const mode = (info.mode & 0o7777).toString(8);
    if (info.isSymbolicLink()) entries[key] = `link ${readlinkSync(path)}`;
    else if (info.isFile()) entries[key] = `file ${mode} ${readFileSync(path, "utf8")}`;
    else {
      entries[key] = `folder ${mode}`;
      for (const name of readdirSync(path).sort()) walk(join(path, name), `${key}/${name}`);
    }
  };
  walk(root, ".");
  return entries;
}

const oldTree = (home: string) => Object.fromEntries(legacyPaths.map(([before]) => [before, tree(join(home, before))]));
const underOldPaths = (target: string) => legacyPaths.some(([before]) => target === before || target.startsWith(`${before}/`));
const stateOf = (home: string) => JSON.parse(readFileSync(join(home, ".local/state/hedge/state.json"), "utf8")) as { groups: Record<string, Record<string, unknown>> };
const oldId = (id: string) => id.replace(/^hedge-/, "fleet-");
const toOld = (path: string) => legacyPaths.reduce((value, [before, after]) => (value === after || value.startsWith(`${after}/`) ? `${before}${value.slice(after.length)}` : value), path);

/** Turns a machine that Hedge set up into the same machine as the engine from before the rename left it. */
async function beforeTheRename(machine: Machine, launchd?: ReturnType<typeof macMachine>["launchd"]) {
  const { home } = machine;
  const profile = join(home, ".local/share/hedge/profile");
  cpSync(profileDir(), profile, { recursive: true });
  expect((await machine.hedge(["apply", "--profile", profile])).code).toBe(0);
  renameSync(join(profile, "hedge.json"), join(profile, "fleet.json"));
  git(profile, "init", "-q");
  git(profile, "add", ".");
  git(profile, "commit", "-q", "-m", "profile");
  const agents = join(home, "Library/LaunchAgents");
  for (const name of existsSync(agents) ? readdirSync(agents) : []) {
    const id = name.slice("dev.hedge.".length, -".plist".length);
    const old = readFileSync(join(agents, name), "utf8").replaceAll(".local/state/hedge/", ".local/state/fleet/").replaceAll(`dev.hedge.${id}<`, `dev.fleet.${oldId(id)}<`).replaceAll(`/${id}.`, `/${oldId(id)}.`);
    rmSync(join(agents, name));
    writeFileSync(join(agents, `dev.fleet.${oldId(id)}.plist`), old);
    writeFileSync(join(home, `.local/state/hedge/jobs/${id}.plist`), old);
    renameSync(join(home, `.local/state/hedge/jobs/${id}.plist`), join(home, `.local/state/hedge/jobs/${oldId(id)}.plist`));
    renameSync(join(home, `.local/state/hedge/jobs/${id}.sh`), join(home, `.local/state/hedge/jobs/${oldId(id)}.sh`));
    launchd?.loaded.delete(`dev.hedge.${id}`);
    launchd?.loaded.add(`dev.fleet.${oldId(id)}`);
  }
  for (const [before, after] of legacyPaths) if (existsSync(join(home, after))) renameSync(join(home, after), join(home, before));
  const statePath = join(home, ".local/state/fleet/state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { version: number; groups: Record<string, Record<string, unknown>> };
  writeFileSync(statePath, JSON.stringify({ version: state.version, groups: { fleet: Object.fromEntries(Object.entries(state.groups.hedge!).map(([target, entry]) => [toOld(target), entry])) } }));
  const machinePath = join(home, ".config/fleet/machine.json");
  const saved = JSON.parse(readFileSync(machinePath, "utf8")) as { profileDir: string };
  writeFileSync(machinePath, JSON.stringify({ ...saved, profileDir: join(home, ".local/share/fleet/profile") }));
}

const bothTrees = (home: string) => Object.fromEntries(legacyPaths.flatMap((pair) => pair).map((path) => [path, tree(join(home, path))]));
const oldRoot = (home: string) => join(home, ".local/share/fleet/engine");

/** A checkout of this engine at the path the engine had before the rename, as the old updater leaves it once it pulled Hedge. */
function oldCheckout(home: string, root = oldRoot(home)) {
  for (const path of ["hedge", "fleet", "src", "packs", "package.json"]) cpSync(join(repoRoot, path), join(root, path), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
  return root;
}

const quiet = (home: string) => ({ HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });

describe("an engine in a Fleet path from before the rename", () => {
  test("an old job's command exits 0 and every other command exits 1, each with the notice, and neither changes either tree", async () => {
    const machine = linuxMachine();
    await beforeTheRename(machine);
    mkdirSync(join(machine.home, ".config/hedge"), { recursive: true });
    writeFileSync(join(machine.home, ".config/hedge/new.txt"), "new\n");
    const before = bothTrees(machine.home);
    const jobs = [["nightly", "fleet-update", "--", "fleet", "update"], ["prune", "--auto"], ["refresh"], ["run", "slack/slack-trigger"]];
    const others = [["apply"], ["update"], ["setup"], ["prune"], ["import-fleet"], ["retire-fleet"], ["help"], []];

    for (const args of [...jobs, ...others]) {
      const lines: string[] = [];
      const code = await main(args, { home: machine.home, engineRoot: oldRoot(machine.home), platform: "linux", env: {}, print: (line) => lines.push(line), run: async () => 0 });
      expect({ args, code, lines }).toEqual({ args, code: jobs.includes(args) ? 0 : 1, lines: [fleetIsHedge] });
    }

    expect(bothTrees(machine.home)).toEqual(before);
    expect(machine.systemd.calls).toEqual([]);
  });

  test("the launcher is inert when the path it was run by, or the path it resolves to, is a Fleet path", () => {
    const byName = temp.make("home-");
    mkdirSync(join(byName, ".local/share/fleet"), { recursive: true });
    symlinkSync(oldCheckout(byName, join(byName, "checkout")), oldRoot(byName));
    const byTarget = temp.make("home-");
    symlinkSync(oldCheckout(byTarget), join(byTarget, "engine"));
    const run = (home: string, launcher: string, ...args: string[]) => {
      const done = Bun.spawnSync(["sh", launcher, ...args], { env: quiet(home) });
      return [done.exitCode, done.stderr.toString()];
    };

    expect(run(byName, join(oldRoot(byName), "hedge"), "apply")).toEqual([1, `${fleetIsHedge}\n`]);
    expect(run(byName, join(oldRoot(byName), "fleet"), "prune", "--auto")).toEqual([0, `${fleetIsHedge}\n`]);
    expect(run(byTarget, join(byTarget, "engine/hedge"), "apply")).toEqual([1, `${fleetIsHedge}\n`]);
  });

  test("an old scheduled job that runs the old checkout's fleet changes nothing and exits 0", () => {
    const home = temp.make("home-");
    const root = oldCheckout(home);
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ role: "devbox" }));
    mkdirSync(join(home, ".local/state/fleet/jobs"), { recursive: true });
    writeFileSync(join(home, ".local/state/fleet/jobs/prune.sh"), `#!/bin/sh\nexec '/bin/sh' '${root}/fleet' 'prune' '--auto'\n`);
    const before = bothTrees(home);

    const job = Bun.spawnSync(["/bin/sh", join(home, ".local/state/fleet/jobs/prune.sh")], { env: quiet(home) });

    expect(job.exitCode).toBe(0);
    expect(job.stderr.toString()).toBe(`${fleetIsHedge}\n`);
    expect(bothTrees(home)).toEqual(before);
  });

  test("an old hook that runs the old checkout's hook runner blocks each guard event with the notice, lets other events pass, and answers nothing", () => {
    const home = temp.make("home-");
    const root = oldCheckout(home);
    mkdirSync(join(home, ".config/fleet/hooks"), { recursive: true });
    symlinkSync(join(root, "packs/base/hooks/run.sh"), join(home, ".config/fleet/hooks/run.sh"));
    const before = bothTrees(home);
    const hook = (agent: string, event: string) => {
      const done = Bun.spawnSync(["sh", join(home, ".config/fleet/hooks/run.sh"), agent, event], { env: quiet(home), stdin: new TextEncoder().encode("{}") });
      return [done.exitCode, done.stdout.toString(), done.stderr.toString()];
    };

    for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit"]) {
      expect(hook("claude", event)).toEqual([2, "", `${fleetIsHedge}\n`]);
      expect(hook("codex", event)).toEqual([2, "", `${fleetIsHedge}\n`]);
    }
    for (const event of ["SessionStart", "Stop"]) expect(hook("claude", event)).toEqual([0, "", `${fleetIsHedge}\n`]);
    expect(bothTrees(home)).toEqual(before);
  });

  test("a hook runner whose folder or file resolves into a Fleet path blocks a guard event with the notice", () => {
    const home = temp.make("home-");
    const root = oldCheckout(home);
    mkdirSync(join(home, ".config/fleet/hooks"), { recursive: true });
    cpSync(join(root, "packs/base/hooks/run.sh"), join(home, ".config/fleet/hooks/run.sh"));
    symlinkSync(join(home, ".config/fleet"), join(home, ".config/hedge"));
    const other = temp.make("home-");
    const otherRoot = oldCheckout(other);
    mkdirSync(join(other, ".config/hedge/hooks"), { recursive: true });
    symlinkSync(join(otherRoot, "packs/base/hooks/run.sh"), join(other, ".config/hedge/hooks/run.sh"));
    const hook = (at: string, runner: string) => {
      const done = Bun.spawnSync(["sh", runner, "claude", "UserPromptSubmit"], { env: quiet(at), stdin: new TextEncoder().encode("{}") });
      return [done.exitCode, done.stdout.toString(), done.stderr.toString()];
    };

    expect(hook(home, join(home, ".config/hedge/hooks/run.sh"))).toEqual([2, "", `${fleetIsHedge}\n`]);
    expect(hook(other, join(other, ".config/hedge/hooks/run.sh"))).toEqual([2, "", `${fleetIsHedge}\n`]);
  });
});

describe("hedge import-fleet, which get.sh runs once the new engine is in place", () => {
  test("copies the machine file, the profile, the config folder and the SSH keys with their modes, leaves the old tree as it was, and after retire-fleet, apply runs", async () => {
    const machine = linuxMachine();
    const { home, systemd } = machine;
    await beforeTheRename(machine);
    writeFileSync(join(home, ".config/fleet/kept.txt"), "mine\n");
    mkdirSync(join(home, ".config/fleet/secrets/hub"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".config/fleet/secrets/hub/credential.box"), "secret\n", { mode: 0o600 });
    writeFileSync(join(home, "outside.txt"), "outside\n");
    symlinkSync(join(home, "outside.txt"), join(home, ".config/fleet/elsewhere"));
    mkdirSync(join(home, ".ssh"), { mode: 0o700 });
    writeFileSync(join(home, ".ssh/fleet_ed25519"), "private key\n", { mode: 0o600 });
    mkdirSync(join(home, ".local/share/fleet-mcphub/data/logs"), { recursive: true });
    writeFileSync(join(home, ".local/share/fleet-mcphub/data/auth.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(home, ".local/share/fleet-mcphub/data/logs/today.log"), "log\n");
    mkdirSync(join(home, ".local/state/fleet/lock"));
    const unit = "[Unit]\nDescription=Fleet: watch\n";
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    mkdirSync(join(home, ".local/state/fleet/jobs"), { recursive: true });
    writeFileSync(join(home, ".config/systemd/user/fleet-watch.service"), unit);
    writeFileSync(join(home, ".local/state/fleet/jobs/watch.service"), unit);
    systemd.units.set("fleet-watch.service", { active: true, enabled: true });
    const before = oldTree(home);

    const imported = await machine.hedge(["import-fleet"]);
    const retired = await machine.hedge(["retire-fleet"]);
    const applied = await machine.hedge(["apply"]);

    expect(imported.output).toContain("Hedge: copied ~/.config/fleet to ~/.config/hedge.");
    expect(retired.output).toContain("Hedge: stopped and turned off the systemd unit fleet-watch.service from before the rename, and kept its files.");
    expect(applied.code).toBe(0);
    expect(oldTree(home)).toEqual(before);
    expect(tree(join(home, ".config/hedge/secrets"))).toEqual(tree(join(home, ".config/fleet/secrets")));
    expect(readFileSync(join(home, ".config/hedge/kept.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(home, ".config/hedge/elsewhere"))).toBe(false);
    expect(lstatSync(join(home, ".ssh/hedge_ed25519")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, ".local/share/hedge-mcphub/data/auth.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(home, ".local/share/hedge-mcphub/data/logs"))).toBe(false);
    expect(existsSync(join(home, ".local/state/hedge/lock"))).toBe(false);
    expect(existsSync(join(home, ".local/share/hedge/engine"))).toBe(false);
    expect(existsSync(join(home, ".local/share/hedge/profile/fleet.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8")).profileDir).toBe(join(home, ".local/share/hedge/profile"));
    expect(systemd.units.get("fleet-watch.service")).toEqual({ active: false, enabled: false });
    const state = stateOf(home);
    expect(Object.keys(state.groups)).toEqual(["hedge"]);
    expect(Object.keys(state.groups.hedge!).filter(underOldPaths)).toEqual([]);
    expect(Object.keys(state.groups.hedge!)).toContain(".config/hedge/hooks/run.sh");

    const again = await machine.hedge(["import-fleet"]);
    const second = await machine.hedge(["apply"]);

    expect(again.output).toBe("");
    expect(second.output).toContain("Applied 0 changes.");
    expect(systemd.units.get("fleet-watch.service")).toEqual({ active: false, enabled: false });
    expect(oldTree(home)).toEqual(before);
    expect(stateOf(home)).toEqual(state);
  });

  test("on a Mac, retire-fleet after the import turns the old launchd jobs off, apply loads the new ones, and the old plists stay", async () => {
    const machine = macMachine();
    const { home, launchd } = machine;
    await beforeTheRename(machine, launchd);
    const old = [...launchd.loaded].filter((label) => label.startsWith("dev.fleet."));
    const plists = tree(join(home, "Library/LaunchAgents"));

    await machine.hedge(["import-fleet"]);
    expect((await machine.hedge(["apply"])).code).toBe(1);
    expect((await machine.hedge(["retire-fleet"])).code).toBe(0);
    expect((await machine.hedge(["apply"])).code).toBe(0);

    expect(old.length).toBeGreaterThan(0);
    expect(old.filter((label) => launchd.loaded.has(label) || !launchd.disabled.has(label))).toEqual([]);
    expect(old.map((label) => launchd.loaded.has(label.replace("dev.fleet.", "dev.hedge.").replace(".fleet-", ".hedge-")))).toEqual(old.map(() => true));
    expect(Object.entries(plists).filter(([path]) => path.includes("dev.fleet.")).every(([path, entry]) => tree(join(home, "Library/LaunchAgents"))[path] === entry)).toBe(true);
  });

  test("points the machine file at the profile copy only when it is the same repository at the same commit", async () => {
    const home = temp.make("home-");
    const profile = join(home, ".local/share/fleet/profile");
    cpSync(profileDir(), profile, { recursive: true });
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ role: "devbox", profileDir: profile }));

    await hedge(["import-fleet"], home);

    expect(existsSync(join(home, ".local/share/hedge/profile/hedge.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8"))).toEqual({ role: "devbox" });

    const checkout = temp.make("home-");
    const repo = join(checkout, ".local/share/fleet/profile");
    cpSync(profileDir(), repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "profile");
    mkdirSync(join(checkout, ".config/fleet"), { recursive: true });
    writeFileSync(join(checkout, ".config/fleet/machine.json"), JSON.stringify({ role: "devbox", profileDir: repo }));

    await hedge(["import-fleet"], checkout);

    expect(JSON.parse(readFileSync(join(checkout, ".config/hedge/machine.json"), "utf8")).profileDir).toBe(join(checkout, ".local/share/hedge/profile"));
    expect(git(join(checkout, ".local/share/hedge/profile"), "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
  });

  test("keeps the hedge owner of a file that the fleet group also names", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    const record = (hash: string) => ({ kind: "file", hash });
    writeFileSync(join(home, ".local/state/fleet/state.json"), JSON.stringify({ version: 1, groups: { fleet: { ".agents/AGENTS.md": record("old"), ".config/fleet/hooks/run.sh": record("hook"), ".config/systemd/user/fleet-heavy.slice": record("slice") }, hedge: { ".agents/AGENTS.md": record("new"), ".local/share/fleet/x": record("x") } } }));

    await hedge(["import-fleet"], home);

    expect(stateOf(home)).toEqual({ version: 1, groups: { hedge: { ".agents/AGENTS.md": record("new") } } } as never);
  });

  test("after an import that stopped part way, the next import copies each file that is still missing, replaces none, and leaves a new data folder it did not make alone", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet/hooks"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/kept.txt"), "mine\n");
    writeFileSync(join(home, ".config/fleet/hooks/notes.md"), "notes\n", { mode: 0 });
    mkdirSync(join(home, ".local/share/fleet-mcphub"), { recursive: true });
    writeFileSync(join(home, ".local/share/fleet-mcphub/auth.json"), "{}\n");

    const stopped = await hedge(["import-fleet"], home);
    chmodSync(join(home, ".config/fleet/hooks/notes.md"), 0o600);
    writeFileSync(join(home, ".config/hedge/kept.txt"), "changed since\n");
    mkdirSync(join(home, ".local/share/hedge-mcphub"), { recursive: true });
    const resumed = await hedge(["import-fleet"], home);
    rmSync(join(home, ".config/hedge/hooks/notes.md"));
    const again = await hedge(["import-fleet"], home);

    expect(stopped.code).toBe(1);
    expect(resumed.code).toBe(0);
    expect(resumed.output).toContain("Hedge: copied ~/.config/fleet to ~/.config/hedge.");
    expect(readFileSync(join(home, ".config/hedge/kept.txt"), "utf8")).toBe("changed since\n");
    expect(readdirSync(join(home, ".local/share/hedge-mcphub"))).toEqual([]);
    expect(again.output).toBe("");
    expect([...readdirSync(join(home, ".config/hedge")), ...readdirSync(join(home, ".config/hedge/hooks"))].filter((name) => name.includes(".partial"))).toEqual([]);
    expect(existsSync(join(home, ".config/hedge/hooks/notes.md"))).toBe(false);
  });

  test("an import that another Hedge operation's live lock holds back runs once that process is gone, though it ended without letting go", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/kept.txt"), "mine\n");
    const holder = join(temp.make("holder-"), "hold.ts");
    writeFileSync(holder, `import { withLock } from ${JSON.stringify(join(import.meta.dir, "adapters/provider-config/store.ts"))};\nawait withLock(process.argv[2]!, async () => { console.log("held"); await new Promise(() => {}); });\n`);
    const child = Bun.spawn([process.execPath, holder, home], { stdout: "pipe", stderr: "ignore" });
    const reader = child.stdout.getReader();
    let said = "";
    while (!said.includes("held")) said += new TextDecoder().decode((await reader.read()).value);

    const held = await hedge(["import-fleet"], home);
    child.kill("SIGKILL");
    await child.exited;
    const resumed = await hedge(["import-fleet"], home);

    expect(held.code).toBe(1);
    expect(held.output).toContain("Another Hedge operation holds");
    expect(resumed.code).toBe(0);
    expect(readFileSync(join(home, ".config/hedge/kept.txt"), "utf8")).toBe("mine\n");
  });

  test("does not point the machine file at a profile copy whose profile file was a link", async () => {
    const home = temp.make("home-");
    const repo = join(home, ".local/share/fleet/profile");
    cpSync(profileDir(), repo, { recursive: true });
    const outside = join(temp.make("outside-"), "hedge.json");
    renameSync(join(repo, "hedge.json"), outside);
    symlinkSync(outside, join(repo, "hedge.json"));
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "profile");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ role: "devbox", profileDir: repo }));

    await hedge(["import-fleet"], home);

    expect(existsSync(join(home, ".local/share/hedge/profile/hedge.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8"))).toEqual({ role: "devbox" });
  });

  test("copies the undo ledger with the ownership records when it is a Hedge step ledger, and leaves one that is not behind", async () => {
    const ledger = { version: 1, steps: [{ pack: "base", id: "tool", check: ["fleet", "check"], undo: ["fleet", "undo"] }], human: [] };
    const homes = [ledger, { version: 1, steps: [{ pack: "base" }] }].map((value) => {
      const home = temp.make("home-");
      mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
      writeFileSync(join(home, ".local/state/fleet/state.json"), JSON.stringify({ version: 1, groups: {} }));
      writeFileSync(join(home, ".local/state/fleet/steps.json"), JSON.stringify(value));
      return home;
    });

    const results = await Promise.all(homes.map((home) => hedge(["import-fleet"], home)));

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(JSON.parse(readFileSync(join(homes[0]!, ".local/state/hedge/steps.json"), "utf8"))).toEqual(ledger);
    expect(existsSync(join(homes[1]!, ".local/state/hedge/steps.json"))).toBe(false);
    expect(results[1]!.output).toContain("Hedge: left ~/.local/state/fleet/steps.json behind, because it is not a Hedge step ledger.");
  });

  test("copies the secret store's event log with its values, so hedge secret run serves a stored value and a store that was off stays off", async () => {
    const put = { type: "put", id: "p1", name: "slack", at: "2026-11-01T00:00:00.000Z", why: "intake", machine: "hub" };
    const off = { type: "off", id: "o1", reason: "leaked", at: "2026-11-02T00:00:00.000Z", machine: "hub" };
    const [on, offHome] = [[put], [put, off]].map((events) => {
      const home = temp.make("home-");
      mkdirSync(join(home, ".config/fleet/secrets"), { recursive: true });
      writeFileSync(join(home, ".config/fleet/secrets/slack.p1"), "SLACK_TOKEN=xoxb-test\n", { mode: 0o600 });
      mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
      writeFileSync(join(home, ".local/state/fleet/secrets.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
      return home;
    }) as [string, string];
    const served = async (home: string) => {
      const shown: string[] = [];
      const show = (text: string | Uint8Array) => void shown.push(typeof text === "string" ? text : Buffer.from(text).toString("utf8"));
      const rows = [{ name: "slack", provider: { name: "slack" }, scope: "the test workspace", settings: "https://example.com/apps", env: ["SLACK_TOKEN"] }];
      const code = await secretCommand(["run", "slack", "--", "sh", "-c", 'test "$SLACK_TOKEN" = xoxb-test && echo served'], { home, env: { HEDGE_SETTINGS: "{}" }, out: show, err: show, rows, now: () => new Date("2026-11-03T00:00:00Z") });
      return { code, output: shown.join("") };
    };

    const imported = await Promise.all([on, offHome].map((home) => hedge(["import-fleet"], home)));

    expect(imported.map((result) => result.code)).toEqual([0, 0]);
    expect(imported[0]!.output).toContain("Hedge: copied the secret store's log ~/.local/state/fleet/secrets.jsonl.");
    expect(lstatSync(join(on, ".local/state/hedge/secrets.jsonl")).mode & 0o777).toBe(0o600);
    expect(await served(on)).toEqual({ code: 0, output: "served\n" });
    const refused = await served(offHome);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("The store is off since 2026-11-02T00:00Z (leaked).");
    expect(refused.output).not.toContain("served");
  });

  test("copies each old config file into a ~/.config/hedge that hedge devbox add made first, and keeps the files there", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet/secrets"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ role: "devbox", name: "box-old" }));
    writeFileSync(join(home, ".config/fleet/provider-fields.json"), "{}\n");
    writeFileSync(join(home, ".config/fleet/secrets/slack.p1"), "SLACK_TOKEN=xoxb-test\n");
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "devbox", name: "box-2" }));

    expect((await hedge(["import-fleet"], home)).code).toBe(0);

    expect(readFileSync(join(home, ".config/hedge/provider-fields.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(home, ".config/hedge/secrets/slack.p1"), "utf8")).toBe("SLACK_TOKEN=xoxb-test\n");
    expect(JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8"))).toEqual({ schema: 1, role: "devbox", name: "box-2" });
  });

  test("follows a saved profileDir that is a link into a Fleet path to its copy, and starts setup again when the profile cannot be copied", async () => {
    const home = temp.make("home-");
    const repo = join(home, ".local/share/fleet/profile");
    cpSync(profileDir(), repo, { recursive: true });
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"], ["add", "."], ["commit", "-q", "-m", "profile"]]) git(repo, ...args);
    symlinkSync(repo, join(home, "my-profile"));
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ role: "devbox", profileDir: join(home, "my-profile"), setup: { done: ["github", "profile", "apply"] } }));
    const broken = temp.make("home-");
    mkdirSync(join(broken, ".local/share/fleet/profile"), { recursive: true });
    writeFileSync(join(broken, ".local/share/fleet/profile/hedge.json"), "{}\n");
    mkdirSync(join(broken, ".config/fleet"), { recursive: true });
    writeFileSync(join(broken, ".config/fleet/machine.json"), JSON.stringify({ role: "devbox", profileDir: join(broken, ".local/share/fleet/profile"), setup: { done: ["github", "profile", "apply"] } }));

    await hedge(["import-fleet"], home);
    await hedge(["import-fleet"], broken);

    expect(JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8"))).toEqual({ role: "devbox", profileDir: join(home, ".local/share/hedge/profile"), setup: { done: ["github", "profile", "apply"] } });
    expect(git(join(home, ".local/share/hedge/profile"), "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(JSON.parse(readFileSync(join(broken, ".config/hedge/machine.json"), "utf8"))).toEqual({ role: "devbox" });
  });

  test("refuses to copy through a link on the way to a new path, and writes nothing there", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/kept.txt"), "mine\n");
    const elsewhere = temp.make("elsewhere-");
    symlinkSync(elsewhere, join(home, ".config/hedge"));

    const result = await hedge(["import-fleet"], home);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`${join(home, ".config/hedge")} is a link or a file, so Hedge did not bring the Fleet copy to ~/.config/hedge.`);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("a profile from before the rename", () => {
  test("applies from fleet.json when hedge.json is not there", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    renameSync(join(profile, "hedge.json"), join(profile, "fleet.json"));
    expect((await hedge(["apply", "--profile", profile], home)).code).toBe(0);
    expect(existsSync(join(home, ".config/hedge/hooks/run.sh"))).toBe(true);
  });

  test("reads hedge.json when both are there", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    writeFileSync(join(profile, "fleet.json"), "not json");
    expect((await hedge(["apply", "--profile", profile], home)).code).toBe(0);
  });
});

describe("a profile in a Fleet path from before the rename", () => {
  const oldProfile = (home: string) => {
    const old = join(home, ".local/share/fleet/profile");
    cpSync(profileDir(), old, { recursive: true });
    const remote = temp.make("remote-");
    git(remote, "init", "-q", "--bare");
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"], ["add", "."], ["commit", "-q", "-m", "profile"], ["remote", "add", "origin", remote], ["push", "-q", "-u", "origin", "main"]]) git(old, ...args);
    return old;
  };
  const machineFile = (home: string) => join(home, ".config/hedge/machine.json");

  test("apply --profile uses the Hedge copy of the profile and remembers the copy", async () => {
    const home = temp.make("home-");
    const old = oldProfile(home);
    cpSync(old, join(home, ".local/share/hedge/profile"), { recursive: true });
    const before = tree(old);

    const result = await hedge(["apply", "--profile", old], home);

    expect(result.code).toBe(0);
    expect(result.output).toContain(`Hedge: uses ${join(home, ".local/share/hedge/profile")}, the copy of ${old}, because ${old} is in a Fleet path from before the rename.`);
    expect(JSON.parse(readFileSync(machineFile(home), "utf8")).profileDir).toBe(join(home, ".local/share/hedge/profile"));
    expect(tree(old)).toEqual(before);
  });

  test("apply --profile refuses a profile in a Fleet path that has no copy, also through a link, and writes no machine file", async () => {
    const home = temp.make("home-");
    const old = oldProfile(home);
    symlinkSync(old, join(home, "my-profile"));

    const results = [await hedge(["apply", "--profile", old], home), await hedge(["apply", "--profile", join(home, "my-profile")], home)];

    expect(results.map((result) => result.code)).toEqual([1, 1]);
    for (const [result, given] of results.map((result, index) => [result, [old, join(home, "my-profile")][index]!] as const)) expect(result.output).toContain(`${given} is in a Fleet path from before the rename, so Hedge does not use it. Run get.sh to copy it, or pass --profile with a profile outside the Fleet paths.`);
    expect(existsSync(machineFile(home))).toBe(false);
  });

  test("apply --profile refuses a Hedge copy that is a link back into the Fleet path", async () => {
    const home = temp.make("home-");
    const old = oldProfile(home);
    mkdirSync(join(home, ".local/share/hedge"), { recursive: true });
    symlinkSync(old, join(home, ".local/share/hedge/profile"));

    const result = await hedge(["apply", "--profile", old], home);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`${old} is in a Fleet path from before the rename, so Hedge does not use it.`);
  });

  test("apply --profile refuses a Hedge copy whose profile file is a link back into the Fleet path, and writes no machine file", async () => {
    const home = temp.make("home-");
    const old = oldProfile(home);
    const copy = join(home, ".local/share/hedge/profile");
    cpSync(old, copy, { recursive: true });
    rmSync(join(copy, "hedge.json"));
    symlinkSync(join(old, "hedge.json"), join(copy, "hedge.json"));

    const result = await hedge(["apply", "--profile", old], home);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`${old} is in a Fleet path from before the rename, so Hedge does not use it.`);
    expect(existsSync(machineFile(home))).toBe(false);
  });

  test("hedge set on a machine whose machine file points into a Fleet path changes the Hedge copy, not the old profile", async () => {
    const home = temp.make("home-");
    const old = oldProfile(home);
    cpSync(old, join(home, ".local/share/hedge/profile"), { recursive: true });
    mkdirSync(dirname(machineFile(home)), { recursive: true });
    writeFileSync(machineFile(home), JSON.stringify({ schema: 1, role: "linux", profileDir: old }));
    const before = tree(old);

    const result = await hedge(["set", "base.heavySlots=3"], home);

    expect(result.output).toContain("Saved");
    expect(JSON.parse(readFileSync(join(home, ".local/share/hedge/profile/hedge.json"), "utf8")).settings).toEqual({ "base.heavySlots": 3 });
    expect(tree(old)).toEqual(before);
  });

  test("hedge set and apply refuse a checkout of another repository at the Hedge path, and push nothing there", async () => {
    const home = temp.make("home-");
    const old = oldProfile(home);
    const stranger = join(home, ".local/share/hedge/profile");
    cpSync(profileDir(), stranger, { recursive: true });
    const elsewhere = temp.make("remote-");
    git(elsewhere, "init", "-q", "--bare");
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"], ["add", "."], ["commit", "-q", "-m", "other"], ["remote", "add", "origin", elsewhere], ["push", "-q", "-u", "origin", "main"]]) git(stranger, ...args);
    mkdirSync(dirname(machineFile(home)), { recursive: true });
    writeFileSync(machineFile(home), JSON.stringify({ schema: 1, role: "linux", profileDir: old }));
    const before = git(elsewhere, "rev-parse", "main");
    const profileText = readFileSync(join(stranger, "hedge.json"), "utf8");

    const set = await hedge(["set", "base.heavySlots=3"], home);
    const applied = await hedge(["apply", "--profile", old], home);

    expect(set.code).toBe(1);
    expect(set.output).toContain(`${old} is in a Fleet path from before the rename, so Hedge does not use it.`);
    expect(applied.code).toBe(1);
    expect(readFileSync(join(stranger, "hedge.json"), "utf8")).toBe(profileText);
    expect(git(elsewhere, "rev-parse", "main")).toBe(before);
  });

  test("the profile writers refuse a folder in a Fleet path", async () => {
    const home = temp.make("home-");
    const old = oldProfile(home);
    const before = tree(old);

    await expect(saveAnswers(old, { plan: "claude" })).rejects.toThrow(`${old} is in a Fleet path from before the rename, so Hedge does not write there.`);
    await expect(saveMachine(home, { role: "linux", profileDir: old } as never)).rejects.toThrow(`${old} is in a Fleet path from before the rename, so Hedge does not write there.`);
    expect(tree(old)).toEqual(before);
    expect(existsSync(machineFile(home))).toBe(false);
  });

  test("the profile writers refuse a file that links into a Fleet path, though its folder is outside", async () => {
    const home = temp.make("home-");
    const old = oldProfile(home);
    const linked = profileDir();
    rmSync(join(linked, "hedge.json"));
    symlinkSync(join(old, "hedge.json"), join(linked, "hedge.json"));
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), "{}\n");
    symlinkSync(join(home, ".config/fleet"), join(home, ".config/hedge"));
    const before = tree(old);

    await expect(saveAnswers(linked, { plan: "claude" })).rejects.toThrow("is in a Fleet path from before the rename, so Hedge does not write there.");
    await expect(saveMachine(home, { role: "linux", profileDir: linked } as never)).rejects.toThrow("is in a Fleet path from before the rename, so Hedge does not write there.");
    expect(tree(old)).toEqual(before);
    expect(readFileSync(join(home, ".config/fleet/machine.json"), "utf8")).toBe("{}\n");
  });
});

describe("FLEET_ variables from before the rename", () => {
  test("hedge reads a FLEET_ variable when its HEDGE_ variable is unset, and the HEDGE_ one when both are set", async () => {
    const home = temp.make("home-");
    expect((await hedge(["apply", "--profile", profileDir([], "# Remembered\n")], home)).code).toBe(0);
    const old = profileDir([], "# Passed down\n");

    const fromOld = await hedge(["doctor"], home, repoRoot, { FLEET_PROFILE_DIR: old });
    const fromNew = await hedge(["doctor"], home, repoRoot, { FLEET_PROFILE_DIR: old, HEDGE_PROFILE_DIR: profileDir([], "# Remembered\n") });

    expect(fromOld.output).toContain(".agents/AGENTS.md needs to be updated.");
    expect(fromNew.output).not.toContain(".agents/AGENTS.md needs to be updated.");
  });
});

test("a path below a link into a Fleet path counts as a Fleet path, also when the path does not exist yet", () => {
  const home = temp.make("home-");
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  symlinkSync(join(home, ".config/fleet"), join(home, "elsewhere"));
  mkdirSync(join(home, "plain"));
  expect([join(home, "elsewhere/new/hedge.json"), join(home, "elsewhere"), join(home, "plain/new/hedge.json")].map((path) => underLegacyPath(home, path))).toEqual([true, true, false]);
});
