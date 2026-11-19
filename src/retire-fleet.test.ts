import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fleetAdapter, scheduledTasks, type FleetOptions } from "./adapters/fleet/adapter.ts";
import type { T3Server } from "./adapters/t3/port.ts";
import { jobsAdapter } from "./adapters/jobs/adapter.ts";
import { main } from "./cli.ts";
import { filesAdapter, type Adapter } from "./reconciler/apply.ts";
import { cliFixtures, repoRoot } from "./testing/cli.ts";
import { tempDirs } from "./testing/git.ts";
import { fakeCrontab, fakeDocker, fakeLaunchd, fakeTasks, runners } from "./testing/old-fleet.ts";
import { fakeSystemd } from "./testing/systemd.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const { profileDir } = cliFixtures(temp);

function oldInstall(home = temp.make("home-")) {
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ role: "devbox" }));
  return home;
}

/** An engine whose watcher pack runs one service, so apply starts a hedge-watch unit or a dev.hedge.watch agent. */
function engineWithService() {
  const root = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(root, "packs/base"), { recursive: true });
  mkdirSync(join(root, "packs/watcher"), { recursive: true });
  writeFileSync(join(root, "packs/watcher/pack.json"), JSON.stringify({ schema: 1, name: "watcher", summary: "Watches.", jobs: [{ id: "watch", command: ["true"], schedule: { every: "always" } }] }));
  return root;
}

/** T3 Code's state store, as T3 Code leaves it when its server stops. */
function savedT3Tasks(home: string, tasks: Array<{ id: string; enabled: boolean }>) {
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  const store = new Database(join(home, ".t3/userdata/statev2.sqlite"));
  store.exec("pragma journal_mode=wal; create table scheduled_tasks (task_id text primary key, title text not null, enabled integer not null)");
  for (const task of tasks) store.query("insert into scheduled_tasks values (?, ?, ?)").run(task.id, task.id, task.enabled ? 1 : 0);
  store.close();
}

const stoppedT3: T3Server = { answering: async () => false, session: async () => Promise.reject(new Error("T3 Code is not running")) };

function machine(platform: NodeJS.Platform, home = oldInstall(), tasks?: FleetOptions["tasks"]) {
  const systemd = fakeSystemd();
  const launchd = fakeLaunchd();
  const docker = fakeDocker();
  const t3 = fakeTasks();
  const cron = fakeCrontab();
  const run = runners(cron.run, systemd.run, launchd.run, docker.run);
  const fleet = fleetAdapter({ run, uid: 501, accountHome: async () => home, tasks: tasks ?? (async () => t3.client) });
  const adapters = (): Adapter[] => [fleet, filesAdapter, jobsAdapter({ run, engineRoot: repoRoot, uid: 501, accountHome: async () => home })];
  const engine = engineWithService();
  const hedge = async (args: string[]) => {
    const lines: string[] = [];
    const code = await main(args, { home, engineRoot: engine, platform, env: {}, print: (line) => lines.push(line), run: async () => 0, adapters });
    return { code, output: lines.join("\n") };
  };
  return { home, systemd, launchd, docker, t3, cron, hedge };
}

describe("hedge retire-fleet", () => {
  test("stops and turns off every old systemd unit, the old MCPHub container and each fleet: task, found by name, keeps their files, and runs again safely", async () => {
    const linux = machine("linux");
    const edited = join(linux.home, ".config/systemd/user/fleet-slack-trigger.service");
    mkdirSync(join(linux.home, ".config/systemd/user"), { recursive: true });
    writeFileSync(edited, "[Service]\nExecStart=/bin/true # changed by hand\n");
    for (const unit of ["fleet-slack-trigger.service", "fleet-cli-proxy.service", "fleet-ssh-hub.service"]) linux.systemd.units.set(unit, { active: true, enabled: true });
    linux.systemd.fileless.add("fleet-cli-proxy.service");
    linux.systemd.units.set("other.service", { active: true, enabled: true });
    linux.docker.containers.set("fleet-mcphub", { running: true, restart: "unless-stopped", label: "mcphub" });
    linux.docker.containers.set("mine", { running: true, restart: "always" });
    for (const task of [{ id: "fleet:pr-digest", enabled: true }, { id: "hedge:pr-digest", enabled: true }, { id: "my-task", enabled: true }]) linux.t3.items.set(task.id, task);

    const retired = await linux.hedge(["retire-fleet"]);

    expect(retired.code).toBe(0);
    expect(retired.output).toContain("Hedge: stopped and turned off the systemd unit fleet-cli-proxy.service from before the rename, and kept its files.");
    expect(retired.output).toContain("Hedge: stopped and turned off the Docker container fleet-mcphub from before the rename, and kept its files.");
    expect(retired.output).toContain("Hedge: stopped and turned off the T3 Code task fleet:pr-digest from before the rename, and kept its files.");
    expect(Object.fromEntries(linux.systemd.units)).toEqual({ "fleet-slack-trigger.service": { active: false, enabled: false }, "fleet-cli-proxy.service": { active: false, enabled: false }, "fleet-ssh-hub.service": { active: false, enabled: false }, "other.service": { active: true, enabled: true } });
    expect(Object.fromEntries(linux.docker.containers)).toEqual({ "fleet-mcphub": { running: false, restart: "no", label: "mcphub" }, mine: { running: true, restart: "always" } });
    expect([...linux.t3.items.values()].map((task) => [task.id, task.enabled])).toEqual([["fleet:pr-digest", false], ["hedge:pr-digest", true], ["my-task", true]]);
    expect(readFileSync(edited, "utf8")).toBe("[Service]\nExecStart=/bin/true # changed by hand\n");

    const again = await linux.hedge(["retire-fleet"]);

    expect(again).toEqual({ code: 0, output: "Hedge: nothing from before the rename runs." });
  });

  test("a unit that stays deactivating or enabled-runtime, or shows no state, counts as not stopped, and retire exits 1 and names each one", async () => {
    const linux = machine("linux");
    for (const unit of ["fleet-a.service", "fleet-b.service", "fleet-c.service"]) linux.systemd.units.set(unit, { active: true, enabled: true });
    linux.systemd.shown.set("fleet-a.service", "LoadState=loaded\nActiveState=deactivating\nUnitFileState=disabled\n");
    linux.systemd.shown.set("fleet-b.service", "LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled-runtime\n");
    linux.systemd.shown.set("fleet-c.service", "LoadState=loaded\nUnitFileState=disabled\n");

    const retired = await linux.hedge(["retire-fleet"]);

    expect(retired.code).toBe(1);
    expect(retired.output).toContain("Hedge: systemd unit fleet-a.service: it is deactivating. Hedge could not verify that it stopped.");
    expect(retired.output).toContain("Hedge: systemd unit fleet-b.service: it is enabled-runtime. Hedge could not verify that it stopped.");
    expect(retired.output).toContain("Hedge: systemd unit fleet-c.service: systemd did not show its state. Hedge could not verify that it stopped.");
    expect(retired.output).toContain("Hedge: stop each one by hand, then run hedge retire-fleet again. Hedge starts nothing while Fleet still runs.");
  });

  test("on a Mac, boots out and turns off each dev.fleet and com.fleet agent, found by its plist or by launchctl list, and keeps the plists", async () => {
    const mac = machine("darwin");
    const agents = join(mac.home, "Library/LaunchAgents");
    mkdirSync(agents, { recursive: true });
    for (const name of ["dev.fleet.fleet-update", "com.fleet.hub-tunnel", "dev.fleet.prune"]) writeFileSync(join(agents, `${name}.plist`), `<plist>${name}</plist>\n`);
    for (const name of ["dev.fleet.fleet-update", "com.fleet.hub-tunnel", "dev.fleet.recover", "com.example.other"]) mac.launchd.loaded.add(name);

    const retired = await mac.hedge(["retire-fleet"]);

    expect(retired.code).toBe(0);
    expect([...mac.launchd.loaded]).toEqual(["com.example.other"]);
    expect([...mac.launchd.disabled].sort()).toEqual(["com.fleet.hub-tunnel", "dev.fleet.fleet-update", "dev.fleet.prune", "dev.fleet.recover"]);
    expect(readFileSync(join(agents, "dev.fleet.prune.plist"), "utf8")).toBe("<plist>dev.fleet.prune</plist>\n");
  });

  test("an agent that unloads but stays enabled, and a container that keeps its restart policy, each fail retire", async () => {
    const mac = machine("darwin");
    mac.launchd.loaded.add("dev.fleet.recover");
    mac.launchd.pinned.add("dev.fleet.recover");
    mac.docker.containers.set("fleet-mcphub", { running: true, restart: "unless-stopped", pinned: true });

    const retired = await mac.hedge(["retire-fleet"]);

    expect(retired.code).toBe(1);
    expect(retired.output).toContain("Hedge: launchd agent dev.fleet.recover: launchd still has it enabled, so it starts again at the next login. Hedge could not verify that it stopped.");
    expect(retired.output).toContain("Hedge: Docker container fleet-mcphub: Docker starts it again, because its restart policy is unless-stopped. Hedge could not verify that it stopped.");
  });

  test("removes each # fleet: crontab entry, keeps the other entries and the old launchers, and fails when the crontab cannot be written", async () => {
    const linux = machine("linux");
    const launcher = join(linux.home, ".local/state/fleet/jobs/nightly.sh");
    mkdirSync(join(linux.home, ".local/state/fleet/jobs"), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\n");
    linux.cron.table.text = `MAILTO=""\n0 3 * * * /bin/sh '${launcher}' # fleet:nightly\n*/5 * * * * my-own-job\n0 4 * * * /bin/sh '/x/prune.sh' # hedge:prune\n`;
    const broken = machine("linux");
    broken.cron.table.text = "0 3 * * * /bin/sh /x/nightly.sh # fleet:nightly\n";
    broken.cron.table.refuse = true;

    const retired = await linux.hedge(["retire-fleet"]);
    const refused = await broken.hedge(["retire-fleet"]);

    expect(retired.code).toBe(0);
    expect(retired.output).toContain("Hedge: stopped and turned off the cron job nightly from before the rename, and kept its files.");
    expect(linux.cron.table.text).toBe(`MAILTO=""\n*/5 * * * * my-own-job\n0 4 * * * /bin/sh '/x/prune.sh' # hedge:prune\n`);
    expect(existsSync(launcher)).toBe(true);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("Hedge: cron job nightly: it is still in your crontab. Hedge could not verify that it stopped.");
  });

  test("an agent that does not stop, a task that stays on, and Docker that does not answer while old MCPHub data is there each fail retire", async () => {
    const mac = machine("darwin");
    mac.launchd.loaded.add("dev.fleet.recover");
    mac.launchd.stuck.add("dev.fleet.recover");
    mac.t3.items.set("fleet:pr-digest", { id: "fleet:pr-digest", enabled: true });
    mac.t3.state.refuse = true;
    mkdirSync(join(mac.home, ".local/share/fleet-mcphub"), { recursive: true });
    mac.docker.state.down = true;

    const retired = await mac.hedge(["retire-fleet"]);

    expect(retired.code).toBe(1);
    expect(retired.output).toContain("Hedge: launchd agent dev.fleet.recover: it is still loaded.");
    expect(retired.output).toContain("Hedge: T3 Code task fleet:pr-digest: it is still on.");
    expect(retired.output).toContain("Hedge: Docker did not answer (Cannot connect to the Docker daemon), so Hedge could not check the fleet-mcphub container.");
  });

  test("while T3 Code is stopped, reads the tasks it saved, and fails retire and apply while a fleet: task there is on", async () => {
    const home = oldInstall();
    savedT3Tasks(home, [{ id: "fleet:pr-digest", enabled: true }, { id: "fleet:off", enabled: false }, { id: "my-task", enabled: true }]);
    const linux = machine("linux", home, scheduledTasks(stoppedT3));

    const retired = await linux.hedge(["retire-fleet"]);
    const applied = await linux.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(retired.code).toBe(1);
    expect(retired.output).toContain("Hedge: T3 Code task fleet:pr-digest: it is on in T3 Code, which is stopped. Start T3 Code so Hedge can turn it off. Hedge could not verify that it stopped.");
    expect(retired.output).not.toContain("fleet:off");
    expect(applied.code).toBe(1);
    expect(applied.output).toContain("The T3 Code task fleet:pr-digest from before the rename still runs (it is on in T3 Code, which is stopped. Start T3 Code so Hedge can turn it off), so Hedge started nothing.");
    expect(linux.systemd.units.has("hedge-watch.service")).toBe(false);
  });

  test("on a machine without Fleet, or with a HOME that is not the account's, stops nothing", async () => {
    const fresh = machine("linux", temp.make("home-"));
    fresh.systemd.units.set("fleet-own.service", { active: true, enabled: true });
    expect(await fresh.hedge(["retire-fleet"])).toEqual({ code: 0, output: "Hedge: nothing from before the rename runs." });
    expect(fresh.systemd.units.get("fleet-own.service")).toEqual({ active: true, enabled: true });

    const other = machine("linux");
    other.systemd.units.set("fleet-own.service", { active: true, enabled: true });
    const lines: string[] = [];
    const code = await main(["retire-fleet"], { home: other.home, engineRoot: repoRoot, platform: "linux", env: {}, print: (line) => lines.push(line), adapters: () => [fleetAdapter({ run: other.systemd.run, accountHome: async () => "/home/someone" })] });
    expect([code, lines]).toEqual([0, [`Hedge: left the jobs from before the rename alone, because ${other.home} is not your account's home folder.`]]);
    expect(other.systemd.units.get("fleet-own.service")).toEqual({ active: true, enabled: true });
  });
});

describe("hedge apply while Fleet still runs", () => {
  const nothingWritten = (home: string) => !existsSync(join(home, ".local/state/hedge/state.json"));

  test("on Linux, exits 1, writes and starts nothing, and names hedge retire-fleet; after retire, it starts the new unit", async () => {
    const linux = machine("linux");
    linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });
    const profile = profileDir(["watcher"]);

    const held = await linux.hedge(["apply", "--profile", profile]);

    expect(held.code).toBe(1);
    expect(held.output).toContain("The systemd unit fleet-watch.service from before the rename still runs (it is active), so Hedge started nothing. Run hedge retire-fleet, then hedge apply.");
    expect(linux.systemd.units.has("hedge-watch.service")).toBe(false);
    expect(nothingWritten(linux.home)).toBe(true);

    expect((await linux.hedge(["retire-fleet"])).code).toBe(0);
    expect((await linux.hedge(["apply", "--profile", profile])).code).toBe(0);
    expect(linux.systemd.units.get("hedge-watch.service")).toEqual({ active: true, enabled: true });
  });

  test("on Linux, exits 1 when the new unit does not start after retire, and the old unit stays off", async () => {
    const linux = machine("linux");
    linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });
    linux.systemd.failing.add("hedge-watch.service");
    expect((await linux.hedge(["retire-fleet"])).code).toBe(0);

    const applied = await linux.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(applied.code).toBe(1);
    expect(applied.output).toContain("systemd did not start the watch job (Job for hedge-watch.service failed because the control process exited with error code.).");
    expect(applied.output).toContain("Hedge could not apply your profile.");
    expect(linux.systemd.units.get("fleet-watch.service")).toEqual({ active: false, enabled: false });
  });

  test("on a Mac, exits 1 when the new agent does not load after retire, and the old agent stays off", async () => {
    const mac = machine("darwin");
    mac.launchd.loaded.add("dev.fleet.watch");
    mac.launchd.failing.add("dev.hedge.watch");
    expect((await mac.hedge(["retire-fleet"])).code).toBe(0);

    const applied = await mac.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(applied.code).toBe(1);
    expect(applied.output).toContain("launchd did not load the watch job.");
    expect([...mac.launchd.loaded].filter((label) => label.endsWith(".watch"))).toEqual([]);
  });

  test("on a Mac, exits 1 and loads no dev.hedge agent while the dev.fleet one is loaded", async () => {
    const mac = machine("darwin");
    mac.launchd.loaded.add("dev.fleet.watch");

    const held = await mac.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(held.code).toBe(1);
    expect(held.output).toContain("The launchd agent dev.fleet.watch from before the rename still runs (it is still loaded), so Hedge started nothing.");
    expect([...mac.launchd.loaded]).toEqual(["dev.fleet.watch"]);
  });

  test("exits 1 while a fleet: T3 task is on, or while launchctl cannot tell whether an old agent runs", async () => {
    const mac = machine("darwin");
    mac.t3.items.set("fleet:pr-digest", { id: "fleet:pr-digest", enabled: true });
    mac.launchd.loaded.add("com.fleet.hub-tunnel");
    mac.launchd.unclear.add("com.fleet.hub-tunnel");

    const held = await mac.hedge(["apply", "--profile", profileDir()]);

    expect(held.code).toBe(1);
    expect(held.output).toContain("The T3 Code task fleet:pr-digest from before the rename still runs (it is still on), so Hedge started nothing.");
    expect(held.output).toContain("The launchd agent com.fleet.hub-tunnel from before the rename still runs (launchctl print exit 127), so Hedge started nothing.");
    expect(nothingWritten(mac.home)).toBe(true);
  });
});
