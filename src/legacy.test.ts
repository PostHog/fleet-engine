import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { jobsAdapter } from "./adapters/jobs/adapter.ts";
import type { CommandRunner } from "./adapters/run.ts";
import { main } from "./cli.ts";
import { legacyPaths } from "./legacy.ts";
import { filesAdapter, type Adapter } from "./reconciler/apply.ts";
import { fakeSystemd } from "./testing/systemd.ts";
import { cliFixtures, repoRoot } from "./testing/cli.ts";
import { tempDirs } from "./testing/git.ts";

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
  return { home, systemd, hedge: machineCommand(home, "linux", jobsAdapter({ run, engineRoot: repoRoot })) };
}

function macMachine(options: { launchdLabel?: string } = {}) {
  const home = temp.make("home-");
  const launchd = { loaded: new Set<string>(), disabled: new Set<string>(), calls: [] as string[][], bootstrapFails: false };
  const run: CommandRunner = async (command) => {
    launchd.calls.push(command);
    const [tool, verb, target, file] = command;
    if (tool !== "launchctl") return { code: 0, stdout: "" };
    if (verb === "print") return { code: launchd.loaded.has(target!) ? 0 : 113, stdout: "" };
    if (verb === "bootstrap") {
      if (launchd.bootstrapFails) return { code: 5, stdout: "" };
      launchd.loaded.add(`gui/501/${basename(file!, ".plist")}`);
    }
    if (verb === "bootout") launchd.loaded.delete(target!);
    if (verb === "disable") launchd.disabled.add(target!);
    return { code: 0, stdout: "" };
  };
  return { home, launchd, hedge: machineCommand(home, "darwin", jobsAdapter({ run, engineRoot: repoRoot, uid: 501, ...options })) };
}

function machineCommand(home: string, platform: NodeJS.Platform, jobs: Adapter) {
  return async (args: string[]) => {
    const lines: string[] = [];
    const code = await main(args, { home, engineRoot: repoRoot, platform, env: {}, print: (line) => lines.push(line), run: async () => 0, adapters: () => [filesAdapter, jobs] });
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
  const agents = join(home, "Library/LaunchAgents");
  for (const name of existsSync(agents) ? readdirSync(agents) : []) {
    const id = name.slice("dev.hedge.".length, -".plist".length);
    const old = readFileSync(join(agents, name), "utf8").replaceAll(".local/state/hedge/", ".local/state/fleet/").replaceAll(`dev.hedge.${id}<`, `dev.fleet.${oldId(id)}<`).replaceAll(`/${id}.`, `/${oldId(id)}.`);
    rmSync(join(agents, name));
    writeFileSync(join(agents, `dev.fleet.${oldId(id)}.plist`), old);
    writeFileSync(join(home, `.local/state/hedge/jobs/${id}.plist`), old);
    renameSync(join(home, `.local/state/hedge/jobs/${id}.plist`), join(home, `.local/state/hedge/jobs/${oldId(id)}.plist`));
    renameSync(join(home, `.local/state/hedge/jobs/${id}.sh`), join(home, `.local/state/hedge/jobs/${oldId(id)}.sh`));
    launchd?.loaded.delete(`gui/501/dev.hedge.${id}`);
    launchd?.loaded.add(`gui/501/dev.fleet.${oldId(id)}`);
  }
  for (const [before, after] of legacyPaths) if (existsSync(join(home, after))) renameSync(join(home, after), join(home, before));
  const statePath = join(home, ".local/state/fleet/state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { version: number; groups: Record<string, Record<string, unknown>> };
  writeFileSync(statePath, JSON.stringify({ version: state.version, groups: { fleet: Object.fromEntries(Object.entries(state.groups.hedge!).map(([target, entry]) => [toOld(target), entry])) } }));
  const machinePath = join(home, ".config/fleet/machine.json");
  const saved = JSON.parse(readFileSync(machinePath, "utf8")) as { profileDir: string };
  writeFileSync(machinePath, JSON.stringify({ ...saved, profileDir: join(home, ".local/share/fleet/profile") }));
}

describe("hedge apply on a machine from before the rename", () => {
  test("copies each old path to its new name, leaves the old tree as it was, turns the old jobs off, and does nothing more on a second run", async () => {
    const machine = linuxMachine();
    const { home, systemd } = machine;
    await beforeTheRename(machine);
    writeFileSync(join(home, ".config/fleet/kept.txt"), "mine\n");
    writeFileSync(join(home, "outside.txt"), "outside\n");
    symlinkSync(join(home, "outside.txt"), join(home, ".config/fleet/elsewhere"));
    mkdirSync(join(home, ".ssh"), { mode: 0o700 });
    writeFileSync(join(home, ".ssh/fleet_ed25519"), "private key\n", { mode: 0o600 });
    const unit = "[Unit]\nDescription=Fleet: watch\n";
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    mkdirSync(join(home, ".local/state/fleet/jobs"), { recursive: true });
    writeFileSync(join(home, ".config/systemd/user/fleet-watch.service"), unit);
    writeFileSync(join(home, ".local/state/fleet/jobs/watch.service"), unit);
    systemd.units.set("fleet-watch.service", { active: true, enabled: true });
    const before = oldTree(home);

    const first = await machine.hedge(["apply"]);

    expect(first.code).toBe(0);
    expect(first.output).toContain("copied ~/.config/fleet to ~/.config/hedge");
    expect(oldTree(home)).toEqual(before);
    expect(readFileSync(join(home, ".config/systemd/user/fleet-watch.service"), "utf8")).toBe(unit);
    expect(readFileSync(join(home, ".config/hedge/kept.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(home, ".config/hedge/elsewhere"))).toBe(false);
    expect(readFileSync(join(home, "outside.txt"), "utf8")).toBe("outside\n");
    expect(readFileSync(join(home, ".ssh/hedge_ed25519"), "utf8")).toBe("private key\n");
    expect(lstatSync(join(home, ".ssh/hedge_ed25519")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, ".local/share/hedge/profile/fleet.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8")).profileDir).toBe(join(home, ".local/share/hedge/profile"));
    expect(systemd.units.get("fleet-watch.service")).toEqual({ active: false, enabled: false });
    const state = stateOf(home);
    expect(Object.keys(state.groups)).toEqual(["hedge"]);
    expect(Object.keys(state.groups.hedge!).filter(underOldPaths)).toEqual([]);
    expect(Object.keys(state.groups.hedge!)).toContain(".config/hedge/hooks/run.sh");

    systemd.calls.length = 0;
    const second = await machine.hedge(["apply"]);

    expect(second.code).toBe(0);
    expect(second.output).not.toContain("copied");
    expect(second.output).toContain("Applied 0 changes.");
    expect(systemd.calls.filter((call) => call.at(-1) === "fleet-watch.service" && call[2] !== "show")).toEqual([]);
    expect(oldTree(home)).toEqual(before);
    expect(stateOf(home)).toEqual(state);
  });

  test("after get.sh copied the old paths, apply takes over the records of the copies and owns nothing in the old tree", async () => {
    const machine = linuxMachine();
    const { home } = machine;
    await beforeTheRename(machine);
    for (const [before, after] of legacyPaths) if (existsSync(join(home, before))) cpSync(join(home, before), join(home, after), { recursive: true, filter: (path) => !lstatSync(path).isSymbolicLink() });
    const before = oldTree(home);

    const result = await machine.hedge(["apply"]);

    expect(result.code).toBe(0);
    expect(result.output).not.toContain("copied");
    expect(oldTree(home)).toEqual(before);
    expect(Object.keys(stateOf(home).groups)).toEqual(["hedge"]);
    expect(Object.keys(stateOf(home).groups.hedge!).filter(underOldPaths)).toEqual([]);
  });

  test("when the old and the new folder are both there, the old one stays as it is and Hedge owns nothing in it", async () => {
    const machine = linuxMachine();
    const { home } = machine;
    await beforeTheRename(machine);
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/new.txt"), "new\n");
    const before = oldTree(home);
    const profile = ["--profile", join(home, ".local/share/hedge/profile")];

    const result = await machine.hedge(["apply", ...profile]);

    expect(result.code).toBe(0);
    expect(result.output).not.toContain("copied ~/.config/fleet");
    expect(oldTree(home)).toEqual(before);
    expect(readFileSync(join(home, ".config/hedge/new.txt"), "utf8")).toBe("new\n");
    expect(Object.keys(stateOf(home).groups.hedge!).filter(underOldPaths)).toEqual([]);
    expect((await machine.hedge(["apply", ...profile])).code).toBe(0);
    expect(oldTree(home)).toEqual(before);
  });

  test("never writes through a link in the old tree, such as one beside an old job's copy", async () => {
    const machine = macMachine();
    await beforeTheRename(machine, machine.launchd);
    const victim = join(machine.home, "victim.txt");
    writeFileSync(victim, "not Hedge's\n");
    symlinkSync(victim, join(machine.home, ".local/state/fleet/jobs/worktree-prune.plist.fleet"));
    const before = oldTree(machine.home);

    expect((await machine.hedge(["apply"])).code).toBe(0);

    expect(readFileSync(victim, "utf8")).toBe("not Hedge's\n");
    expect(oldTree(machine.home)).toEqual(before);
    expect(machine.launchd.loaded.has("gui/501/dev.fleet.worktree-prune")).toBe(false);
    expect(machine.launchd.disabled.has("gui/501/dev.fleet.worktree-prune")).toBe(true);
    expect(existsSync(join(machine.home, "Library/LaunchAgents/dev.fleet.worktree-prune.plist"))).toBe(true);
    expect(machine.launchd.loaded.has("gui/501/dev.hedge.worktree-prune")).toBe(true);
  });

  test("when the old update job runs the apply and the new one does not load, the old one keeps its launcher and stays loaded", async () => {
    const machine = macMachine({ launchdLabel: "dev.fleet.fleet-update" });
    await beforeTheRename(machine, machine.launchd);
    const launcher = join(machine.home, ".local/state/fleet/jobs/fleet-update.sh");
    const script = readFileSync(launcher, "utf8");
    machine.launchd.bootstrapFails = true;

    await machine.hedge(["apply"]);

    expect(readFileSync(launcher, "utf8")).toBe(script);
    expect(machine.launchd.loaded.has("gui/501/dev.fleet.fleet-update")).toBe(true);
    expect(existsSync(join(machine.home, "Library/LaunchAgents/dev.fleet.fleet-update.plist"))).toBe(true);
  });

  test("adds the hedge command beside the fleet command that get.sh wrote before the rename, and leaves another fleet alone", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/fleet"), "#!/bin/sh\n# Fleet\nexec sh '/old/engine/fleet' \"$@\"\n");
    const result = await hedge(["apply", "--profile", profileDir()], home);
    expect(result.output).toContain("added ~/.local/bin/hedge");
    expect(readFileSync(join(home, ".local/bin/hedge"), "utf8")).toBe(`#!/bin/sh\n# Hedge\nexec sh '${join(repoRoot, "hedge")}' "$@"\n`);
    expect(lstatSync(join(home, ".local/bin/hedge")).mode & 0o777).toBe(0o755);

    const other = temp.make("home-");
    mkdirSync(join(other, ".local/bin"), { recursive: true });
    writeFileSync(join(other, ".local/bin/fleet"), "#!/bin/sh\necho another fleet\n");
    expect((await hedge(["apply", "--profile", profileDir()], other)).output).not.toContain("added ~/.local/bin/hedge");
    expect(existsSync(join(other, ".local/bin/hedge"))).toBe(false);
  });

  test("on a machine set up after the rename, copies nothing and makes no old names", async () => {
    const home = temp.make("home-");
    const result = await hedge(["apply", "--profile", profileDir()], home);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("copied");
    for (const [before] of legacyPaths) expect(existsSync(join(home, before))).toBe(false);
  });

  test("a dry run copies nothing", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    await hedge(["apply", "--profile", profileDir(), "--dry-run"], home);
    expect(existsSync(join(home, ".config/hedge"))).toBe(false);
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
