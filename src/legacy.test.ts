import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { jobsAdapter } from "./adapters/jobs/adapter.ts";
import type { CommandRunner } from "./adapters/run.ts";
import { main } from "./cli.ts";
import { fleetIsHedge, legacyPaths } from "./legacy.ts";
import { filesAdapter, type Adapter } from "./reconciler/apply.ts";
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
  return { home, systemd, hedge: machineCommand(home, "linux", jobsAdapter({ run, engineRoot: repoRoot })) };
}

function macMachine() {
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
  return { home, launchd, hedge: machineCommand(home, "darwin", jobsAdapter({ run, engineRoot: repoRoot, uid: 501 })) };
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

const bothTrees = (home: string) => Object.fromEntries(legacyPaths.flatMap((pair) => pair).map((path) => [path, tree(join(home, path))]));
const oldRoot = (home: string) => join(home, ".local/share/fleet/engine");

/** A checkout of this engine at the path the engine had before the rename, as the old updater leaves it once it pulled Hedge. */
function oldCheckout(home: string) {
  const root = oldRoot(home);
  for (const path of ["hedge", "fleet", "src", "packs", "package.json"]) cpSync(join(repoRoot, path), join(root, path), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
  return root;
}

const quiet = (home: string) => ({ HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });

describe("an engine in a Fleet path from before the rename", () => {
  test("apply, update, setup and prune change nothing in either tree, print the notice, and exit 0", async () => {
    const machine = linuxMachine();
    await beforeTheRename(machine);
    mkdirSync(join(machine.home, ".config/hedge"), { recursive: true });
    writeFileSync(join(machine.home, ".config/hedge/new.txt"), "new\n");
    const before = bothTrees(machine.home);

    for (const args of [["apply"], ["update"], ["setup"], ["prune", "--auto"], ["import-fleet"]]) {
      const lines: string[] = [];
      const code = await main(args, { home: machine.home, engineRoot: oldRoot(machine.home), platform: "linux", env: {}, print: (line) => lines.push(line), run: async () => 0 });
      expect({ args, code, lines }).toEqual({ args, code: 0, lines: [fleetIsHedge] });
    }

    expect(bothTrees(machine.home)).toEqual(before);
    expect(machine.systemd.calls).toEqual([]);
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

  test("an old hook that runs the old checkout's hook runner exits 0 with the notice and answers nothing", () => {
    const home = temp.make("home-");
    const root = oldCheckout(home);
    mkdirSync(join(home, ".config/fleet/hooks"), { recursive: true });
    symlinkSync(join(root, "packs/base/hooks/run.sh"), join(home, ".config/fleet/hooks/run.sh"));
    const before = bothTrees(home);

    const hook = Bun.spawnSync(["sh", join(home, ".config/fleet/hooks/run.sh"), "claude", "UserPromptSubmit"], { env: quiet(home), stdin: new TextEncoder().encode("{}") });

    expect([hook.exitCode, hook.stdout.toString(), hook.stderr.toString()]).toEqual([0, "", `${fleetIsHedge}\n`]);
    expect(bothTrees(home)).toEqual(before);
  });
});

describe("hedge import-fleet, which get.sh runs once the new engine is in place", () => {
  test("copies the machine file, the profile, the config folder and the SSH keys with their modes, leaves the old tree as it was, and then apply turns the old jobs off", async () => {
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
    const applied = await machine.hedge(["apply"]);

    expect(imported.output).toContain("Hedge: copied ~/.config/fleet to ~/.config/hedge.");
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

    systemd.calls.length = 0;
    const again = await machine.hedge(["import-fleet"]);
    const second = await machine.hedge(["apply"]);

    expect(again.output).toBe("");
    expect(second.output).toContain("Applied 0 changes.");
    expect(systemd.calls.filter((call) => call.at(-1) === "fleet-watch.service" && call[2] !== "show")).toEqual([]);
    expect(oldTree(home)).toEqual(before);
    expect(stateOf(home)).toEqual(state);
  });

  test("on a Mac, apply after the import turns the old launchd jobs off and loads the new ones, and keeps the old plists", async () => {
    const machine = macMachine();
    const { home, launchd } = machine;
    await beforeTheRename(machine, launchd);
    const old = [...launchd.loaded].filter((label) => label.startsWith("gui/501/dev.fleet."));
    const plists = tree(join(home, "Library/LaunchAgents"));

    await machine.hedge(["import-fleet"]);
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
    writeFileSync(join(home, ".local/state/fleet/state.json"), JSON.stringify({ version: 1, groups: { fleet: { ".agents/AGENTS.md": record("old"), ".config/fleet/hooks/run.sh": record("hook") }, hedge: { ".agents/AGENTS.md": record("new"), ".local/share/fleet/x": record("x") } } }));

    await hedge(["import-fleet"], home);

    expect(stateOf(home)).toEqual({ version: 1, groups: { hedge: { ".agents/AGENTS.md": record("new") } } } as never);
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
