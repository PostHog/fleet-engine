import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fleetAdapter, procProcesses, scheduledTasks, type FleetOptions } from "./adapters/fleet/adapter.ts";
import { spawnRunner, type CommandRunner } from "./adapters/run.ts";
import type { T3Server } from "./adapters/t3/port.ts";
import { jobsAdapter } from "./adapters/jobs/adapter.ts";
import { main } from "./cli.ts";
import { filesAdapter, type Adapter } from "./reconciler/apply.ts";
import { cliFixtures, repoRoot } from "./testing/cli.ts";
import { tempDirs } from "./testing/git.ts";
import { fakeCrontab, fakeDocker, fakeLaunchd, fakeProcesses, fakeTasks, runners } from "./testing/old-fleet.ts";
import { git } from "./testing/git.ts";
import { holdLock } from "./lock.ts";
import { fakeSystemd } from "./testing/systemd.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const { profileDir } = cliFixtures(temp);

function oldInstall(home = temp.make("home-")) {
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ role: "devbox" }));
  return home;
}

function engineWithService() {
  const root = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(root, "packs/base"), { recursive: true });
  mkdirSync(join(root, "packs/watcher"), { recursive: true });
  writeFileSync(join(root, "packs/watcher/pack.json"), JSON.stringify({ schema: 1, name: "watcher", summary: "Watches.", jobs: [{ id: "watch", command: ["true"], schedule: { every: "always" } }] }));
  return root;
}

function savedT3Tasks(home: string, tasks: Array<{ id: string; enabled: boolean }> | "no table") {
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  const store = new Database(join(home, ".t3/userdata/statev2.sqlite"));
  store.exec("pragma journal_mode=wal; create table projects (id text primary key)");
  if (tasks === "no table") return store.close();
  store.exec("create table scheduled_tasks (task_id text primary key, title text not null, enabled integer not null)");
  for (const task of tasks) store.query("insert into scheduled_tasks values (?, ?, ?)").run(task.id, task.id, task.enabled ? 1 : 0);
  store.close();
}

const stoppedT3: T3Server = { answering: async () => false, session: async () => Promise.reject(new Error("T3 Code is not running")) };

type LiveProcesses = { run: CommandRunner; uid: number; sleep: () => Promise<void>; processes?: FleetOptions["processes"] };

function machine(platform: NodeJS.Platform, home = oldInstall(), tasks?: FleetOptions["tasks"], live?: LiveProcesses) {
  const systemd = fakeSystemd();
  const launchd = fakeLaunchd();
  const docker = fakeDocker();
  const t3 = fakeTasks();
  const cron = fakeCrontab();
  const processes = fakeProcesses();
  const run = runners(cron.run, systemd.run, launchd.run, docker.run, live?.run ?? processes.run);
  const fleet = fleetAdapter({ run, uid: live?.uid ?? 501, accountHome: async () => home, tasks: tasks ?? (async () => t3.client), sleep: live?.sleep ?? (async () => {}), processes: live ? live.processes : processes.list });
  const adapters = (): Adapter[] => [fleet, filesAdapter, jobsAdapter({ run, engineRoot: repoRoot, uid: 501, accountHome: async () => home })];
  const engine = engineWithService();
  const clock = { now: Date.now, sleep: async (_ms: number) => {} };
  const hedge = async (args: string[]) => {
    const lines: string[] = [];
    const code = await main(args, { home, engineRoot: engine, platform, env: {}, print: (line) => lines.push(line), run: async () => 0, adapters, clock: { now: () => clock.now(), sleep: (ms) => clock.sleep(ms) } });
    return { code, output: lines.join("\n") };
  };
  return { home, systemd, launchd, docker, t3, cron, processes, clock, hedge, fleet };
}

function packSource(home: string) {
  const repo = temp.make("source-");
  mkdirSync(join(repo, "packs/extra"), { recursive: true });
  writeFileSync(join(repo, "packs/extra/pack.json"), JSON.stringify({ schema: 1, name: "extra", summary: "Extra." }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "extra");
  const profile = profileDir(["watcher"]);
  const answers = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...answers, sources: [{ name: "extra", repo, ref: "main" }] }));
  const cacheLock = holdLock(join(home, ".local/share/hedge/sources/extra.lock"));
  return { profile, release: () => cacheLock.release() };
}

function sourceWithCommand() {
  const repo = temp.make("source-");
  const commit = (word: string) => {
    mkdirSync(join(repo, "packs/extra/commands"), { recursive: true });
    writeFileSync(join(repo, "packs/extra/pack.json"), JSON.stringify({ schema: 1, name: "extra", summary: "Extra." }));
    writeFileSync(join(repo, "packs/extra/commands/hello.ts"), `await Bun.write(Bun.env.HOME + "/hello.txt", ${JSON.stringify(word)});\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", word);
  };
  git(repo, "init", "-q", "-b", "main");
  commit("saved");
  git(repo, "checkout", "-q", "-b", "candidate");
  commit("candidate");
  git(repo, "checkout", "-q", "main");
  const profile = (ref: string, url = repo) => {
    const dir = profileDir(["extra"]);
    const answers = JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8"));
    writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...answers, sources: [{ name: "extra", repo: url, ref }] }));
    return dir;
  };
  return { repo, profile };
}

function startsFleetDuringFetch(linux: ReturnType<typeof machine>) {
  const { profile, release } = packSource(linux.home);
  linux.clock.sleep = async () => {
    linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });
    release();
  };
  return profile;
}

const oldLauncher = `#!/bin/sh
set -eu
fleet_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
exec bun "$fleet_root/src/cli.ts" "$@"
`;

const oldCliBecomesPackCommand = `import { join } from "node:path";
const [name = "", ...args] = Bun.argv.slice(2);
process.execve(Bun.which("bun"), ["bun", join(import.meta.dir, "../packs/base/commands", name + ".ts"), ...args], process.env);
`;

const oldNightlyRunsChildShell = `import { join } from "node:path";
const command = Bun.argv.slice(2).slice(3);
const once = ["/bin/sh", "-c", '"$@"\\ncode=$?\\nexit "$code"', "fleet-nightly", "/bin/sh", join(import.meta.dir, "../../../fleet"), ...command];
process.exit(await Bun.spawn(once, { stdio: ["inherit", "inherit", "inherit"] }).exited);
`;

const oldAgentUpdateRunsInstaller = `const installer = Bun.spawn(["/bin/sh", "-c", 'sh -c "echo installer \\\\$\\\\$; exec sleep 60"; exit'], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
console.log(\`working \${process.pid}\`);
await installer.exited;
`;

const parentOf = (pid: number) => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
};

function inTree(root: number, pid: number) {
  try {
    for (let at = pid; at > 1; at = parentOf(at)) if (at === root) return true;
  } catch {
    return false;
  }
  return false;
}

function running(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).length > 0;
  } catch {
    return false;
  }
}

async function untilClosed(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done);
}

async function firstLines(stream: ReadableStream<Uint8Array>, count: number) {
  const reader = stream.getReader();
  let text = "";
  while (text.split("\n").length <= count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n").slice(0, count);
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

  test("a T3 Code state store without a scheduled_tasks table holds no saved tasks, so retire and apply go on", async () => {
    const home = oldInstall();
    savedT3Tasks(home, "no table");
    const linux = machine("linux", home, scheduledTasks(stoppedT3));
    linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });

    const retired = await linux.hedge(["retire-fleet"]);
    const applied = await linux.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(retired.code).toBe(0);
    expect(applied.code).toBe(0);
    expect(linux.systemd.units.get("hedge-watch.service")).toEqual({ active: true, enabled: true });
  });

  test("when systemd does not list its unit files, retire exits 1 and apply starts nothing", async () => {
    const linux = machine("linux");
    linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });
    linux.systemd.broken.add("list-unit-files");

    const retired = await linux.hedge(["retire-fleet"]);
    const applied = await linux.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(retired.code).toBe(1);
    expect(retired.output).toContain("Hedge: systemd did not list its unit files (Failed to connect to bus: No such file or directory). Hedge could not verify that it stopped.");
    expect(applied.code).toBe(1);
    expect(applied.output).toContain("systemd did not list its unit files (Failed to connect to bus: No such file or directory), so Hedge cannot tell whether Fleet still runs, and started nothing.");
    expect(linux.systemd.units.has("hedge-watch.service")).toBe(false);
  });

  test("stops an old job's command that cron started before retire, and leaves the other commands from the old engine alone", async () => {
    const linux = machine("linux");
    const engine = join(linux.home, ".local/share/fleet/engine");
    linux.cron.table.text = `0 3 * * * /bin/sh '${linux.home}/.local/state/fleet/jobs/nightly.sh' # fleet:nightly\n`;
    linux.processes.table.set(4242, { args: `/home/bin/bun ${engine}/src/cli.ts nightly` });
    linux.processes.table.set(4243, { args: `/bin/sh ${engine}/fleet prune --auto` });
    linux.processes.table.set(4300, { args: `/home/bin/bun ${engine}/packs/context-library/mcp/main.ts` });
    linux.processes.table.set(4301, { args: `/home/bin/bun ${engine}/src/cli.ts heavy -- make test` });
    linux.processes.table.set(4302, { args: "/usr/bin/vim notes.md" });
    linux.processes.table.set(4244, { args: `/bin/sh ${linux.home}/.local/state/fleet/jobs/agent-update.sh` });
    linux.processes.table.set(4245, { args: `bun ${engine}/packs/base/commands/nightly.ts fleet-update -- fleet update` });

    const retired = await linux.hedge(["retire-fleet"]);

    expect(retired.code).toBe(0);
    expect(retired.output).toContain("Hedge: stopped and turned off the running command fleet nightly (process 4242) from before the rename, and kept its files.");
    expect(retired.output).toContain("Hedge: stopped and turned off the running command fleet prune --auto (process 4243) from before the rename, and kept its files.");
    expect(retired.output).toContain("Hedge: stopped and turned off the running command fleet job agent-update (process 4244) from before the rename, and kept its files.");
    expect(retired.output).toContain("Hedge: stopped and turned off the running command fleet nightly (process 4245) from before the rename, and kept its files.");
    expect([...linux.processes.table.keys()]).toEqual([4300, 4301, 4302]);
    expect(linux.cron.table.text).toBe("");
  });

  test("an old job's command that does not end fails retire, and apply starts nothing while it runs", async () => {
    const linux = machine("linux");
    linux.processes.table.set(4242, { args: `/home/bin/bun ${join(linux.home, ".local/share/fleet/engine")}/src/cli.ts nightly`, stubborn: true });

    const retired = await linux.hedge(["retire-fleet"]);
    const applied = await linux.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(retired.code).toBe(1);
    expect(retired.output).toContain("Hedge: running command fleet nightly (process 4242): it has not ended. Hedge could not verify that it stopped.");
    expect(applied.code).toBe(1);
    expect(applied.output).toContain("The running command fleet nightly (process 4242) from before the rename still runs (it has not ended), so Hedge started nothing.");
    expect(linux.systemd.units.has("hedge-watch.service")).toBe(false);
  });

  test.skipIf(process.platform !== "linux")("from a home path with a space, stops a live nightly job and the agent-update that its child shell runs, as the old launcher started them", async () => {
    const home = oldInstall(temp.make("home with space-"));
    const engine = join(home, ".local/share/fleet/engine");
    const bin = temp.make("bin-");
    symlinkSync(process.execPath, join(bin, "bun"));
    mkdirSync(join(engine, "src"), { recursive: true });
    mkdirSync(join(engine, "packs/base/commands"), { recursive: true });
    writeFileSync(join(engine, "fleet"), oldLauncher);
    writeFileSync(join(engine, "src/cli.ts"), oldCliBecomesPackCommand);
    writeFileSync(join(engine, "packs/base/commands/nightly.ts"), oldNightlyRunsChildShell);
    writeFileSync(join(engine, "packs/base/commands/agent-update.ts"), oldAgentUpdateRunsInstaller);
    const secret = ["token", "z".repeat(24)].join("-");
    const child = Bun.spawn(["/bin/sh", join(engine, "fleet"), "nightly", "agent-update", "--", "fleet", "agent-update", `--auth=${secret}`], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdin: "ignore", stdout: "pipe", stderr: "inherit",
    });
    try {
      const started = new Map((await firstLines(child.stdout, 2)).map((line) => line.split(" ") as [string, string]));
      const [worker, installer] = [Number(started.get("working")), Number(started.get("installer"))];
      const ended = untilClosed(child.stdout);
      const onlyThisTree: CommandRunner = async (command) => {
        if (command[0] !== "kill") return { code: 127, stdout: "" };
        const pids = command.slice(2).map(Number);
        if (!pids.every((pid) => inTree(child.pid, pid))) return { code: 1, stdout: "", stderr: "the test signals only its own processes\n" };
        for (const pid of pids) process.kill(pid, "SIGTERM");
        return { code: 0, stdout: "" };
      };
      const linux = machine("linux", home, undefined, { run: onlyThisTree, uid: process.getuid!(), sleep: () => ended });

      const retired = await linux.hedge(["retire-fleet"]);

      expect(retired.output).toContain(`Hedge: stopped and turned off the running command fleet nightly (process ${child.pid}) from before the rename, and kept its files.`);
      expect(retired.output).toContain(`Hedge: stopped and turned off the running command fleet agent-update (process ${worker}) from before the rename, and kept its files.`);
      expect(retired.output).not.toContain(secret);
      expect(retired.code).toBe(0);
      await ended;
      expect([worker, installer].filter(running)).toEqual([]);
      await child.exited;
      expect(child.signalCode).toBe("SIGTERM");
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("leaves alone a program whose arguments only name the old launcher, and a process ID that another program took after the scan", async () => {
    const linux = machine("linux");
    const engine = join(linux.home, ".local/share/fleet/engine");
    linux.processes.table.set(4242, { args: `/usr/bin/vim ${engine}/src/cli.ts nightly` });
    linux.processes.table.set(4243, { args: `/home/bin/bun /work/tool.ts ${engine}/src/cli.ts nightly` });
    linux.processes.table.set(4244, { args: `/home/bin/bun ${engine}/src/cli.ts nightly`, reusedBy: "/usr/bin/vim notes.md" });

    const retired = await linux.hedge(["retire-fleet"]);

    expect(retired.code).toBe(0);
    expect(linux.processes.killed).toEqual([]);
    expect([...linux.processes.table].map(([pid, item]) => `${pid} ${item.args}`)).toEqual([
      `4242 /usr/bin/vim ${engine}/src/cli.ts nightly`,
      `4243 /home/bin/bun /work/tool.ts ${engine}/src/cli.ts nightly`,
      "4244 /usr/bin/vim notes.md",
    ]);
  });

  test("when Hedge cannot read the running commands, retire exits 1 and apply starts nothing, since Hedge cannot tell whether an old job's command still runs", async () => {
    const linux = machine("linux");
    linux.processes.state.missing = true;

    const retired = await linux.hedge(["retire-fleet"]);
    const applied = await linux.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(retired.code).toBe(1);
    expect(retired.output).toContain("Hedge: /proc could not be read (ENOENT: no such file or directory). Hedge could not verify that it stopped.");
    expect(applied.code).toBe(1);
    expect(applied.output).toContain("/proc could not be read (ENOENT: no such file or directory), so Hedge cannot tell whether Fleet still runs, and started nothing.");
    expect(linux.systemd.units.has("hedge-watch.service")).toBe(false);
  });

  test("a process whose command Hedge cannot read for another reason than its end fails retire, and apply starts nothing", async () => {
    const proc = temp.make("proc-");
    mkdirSync(join(proc, "4242/cmdline"), { recursive: true });
    mkdirSync(join(proc, "4243"));
    const linux = machine("linux", oldInstall(), undefined, { run: fakeProcesses().run, uid: process.getuid!(), sleep: async () => {}, processes: procProcesses(process.getuid!(), proc) });

    const retired = await linux.hedge(["retire-fleet"]);
    const applied = await linux.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(retired.code).toBe(1);
    expect(retired.output).toContain("Hedge: process 4242 could not be read (EISDIR");
    expect(applied.code).toBe(1);
    expect(applied.output).toContain("so Hedge cannot tell whether Fleet still runs, and started nothing.");
    expect(linux.systemd.units.has("hedge-watch.service")).toBe(false);
  });

  test("after a retire fails on a Fleet installer that outlives its agent-update job, the next retire and apply still see the installer, and leave Hedge's own installer alone", async () => {
    const home = oldInstall();
    const fleetEngine = join(home, ".local/share/fleet/engine");
    const proc = temp.make("proc-");
    const listed = (pid: number, ppid: number, argv: string[], engine?: string) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
      writeFileSync(join(proc, String(pid), "stat"), `${pid} (${argv[0]}) S ${ppid} ${pid} ${pid} 0`);
      writeFileSync(join(proc, String(pid), "environ"), engine ? `HOME=${home}\0FLEET_ENGINE_DIR=${engine}\0` : `HOME=${home}\0`);
    };
    listed(4242, 1, ["/home/bin/bun", `${fleetEngine}/packs/base/commands/agent-update.ts`], fleetEngine);
    listed(4250, 4242, ["/usr/bin/node", "/home/bin/t3", "update", "--yes", "--channel", "nightly"], fleetEngine);
    listed(4260, 1, ["/usr/bin/node", "/home/bin/t3", "update", "--yes", "--channel", "nightly"], join(home, ".local/share/hedge/engine"));
    listed(4270, 1, ["/usr/bin/node", "/home/bin/t3", "update", "--yes", "--channel", "nightly"]);
    const signalled: number[][] = [];
    const jobEndsInstallerStays: CommandRunner = async (command) => {
      if (command[0] !== "kill") return { code: 127, stdout: "" };
      signalled.push(command.slice(2).map(Number));
      rmSync(join(proc, "4242"), { recursive: true, force: true });
      return { code: 0, stdout: "" };
    };
    const linux = machine("linux", home, undefined, { run: jobEndsInstallerStays, uid: process.getuid!(), sleep: async () => {}, processes: procProcesses(process.getuid!(), proc) });

    const first = await linux.hedge(["retire-fleet"]);
    const second = await linux.hedge(["retire-fleet"]);
    const applied = await linux.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(first.code).toBe(1);
    expect(second.code).toBe(1);
    expect(second.output).toContain("Hedge: running command fleet agent-update: t3 update (process 4250): it has not ended.");
    expect(applied.code).toBe(1);
    expect(applied.output).toContain("The running command fleet agent-update: t3 update (process 4250) from before the rename still runs (it has not ended), so Hedge started nothing.");
    expect(signalled.flat()).not.toContain(4260);
    expect(signalled.flat()).not.toContain(4270);
    expect(linux.systemd.units.has("hedge-watch.service")).toBe(false);
  });

  test("names an old job's command by its job and process only, so arguments that can hold a secret stay out of retire, apply and doctor", async () => {
    const linux = machine("linux");
    expect((await linux.hedge(["apply", "--profile", profileDir([])])).code).toBe(0);
    const secret = ["token", "z".repeat(24)].join("-");
    linux.processes.table.set(4242, { args: `/home/bin/bun ${join(linux.home, ".local/share/fleet/engine")}/src/cli.ts nightly agent-update -- sh -c curl -H Authorization:${secret}`, stubborn: true });

    const runs = [await linux.hedge(["retire-fleet"]), await linux.hedge(["apply"]), await linux.hedge(["doctor"])];

    expect(runs.map((run) => run.code)).toEqual([1, 1, 1]);
    for (const run of runs) {
      expect(run.output).toContain("fleet nightly (process 4242)");
      expect(run.output).not.toContain(secret);
    }
  });

  test("leaves the old heavy slice alone: systemd shows a slice static, and it runs nothing by itself", async () => {
    const linux = machine("linux");
    mkdirSync(join(linux.home, ".config/systemd/user"), { recursive: true });
    writeFileSync(join(linux.home, ".config/systemd/user/fleet-heavy.slice"), "[Slice]\nMemoryMax=50%\n");
    linux.systemd.units.set("fleet-heavy.slice", { active: false, enabled: false });
    linux.systemd.shown.set("fleet-heavy.slice", "LoadState=loaded\nActiveState=inactive\nUnitFileState=static\n");
    linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });

    const retired = await linux.hedge(["retire-fleet"]);
    const applied = await linux.hedge(["apply", "--profile", profileDir(["watcher"])]);

    expect(retired.code).toBe(0);
    expect(retired.output).toBe("Hedge: stopped and turned off the systemd unit fleet-watch.service from before the rename, and kept its files.");
    expect(applied.code).toBe(0);
    expect(linux.systemd.units.get("fleet-heavy.slice")).toEqual({ active: false, enabled: false });
    expect(linux.systemd.calls.filter((call) => call.includes("fleet-heavy.slice") && ["stop", "disable", "mask", "kill"].includes(call[2]!))).toEqual([]);
    expect(readFileSync(join(linux.home, ".config/systemd/user/fleet-heavy.slice"), "utf8")).toBe("[Slice]\nMemoryMax=50%\n");
  });

  test("on a machine without Fleet, neither retire nor apply needs the account's home folder", async () => {
    const home = temp.make("home-");
    const systemd = fakeSystemd();
    const adapters = (): Adapter[] => [fleetAdapter({ run: systemd.run, accountHome: async () => undefined }), filesAdapter];
    const hedge = async (args: string[]) => {
      const lines: string[] = [];
      const code = await main(args, { home, engineRoot: repoRoot, platform: "linux", env: {}, print: (line) => lines.push(line), run: async () => 0, adapters });
      return { code, output: lines.join("\n") };
    };

    expect(await hedge(["retire-fleet"])).toEqual({ code: 0, output: "Hedge: nothing from before the rename runs." });
    const applied = await hedge(["apply", "--profile", profileDir([])]);
    expect(applied.output).not.toContain("fleet:home");
    expect(applied.output).not.toContain("could not look up your account's home folder");
    expect(applied.code).toBe(0);
  });

  test("with --dry-run, names each piece that still runs and stops nothing", async () => {
    const linux = machine("linux");
    linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });

    expect(await linux.hedge(["retire-fleet", "--dry-run"])).toEqual({ code: 0, output: "Hedge: The systemd unit fleet-watch.service from before the rename still runs (it is active), so Hedge started nothing. Run hedge retire-fleet, then hedge apply." });
    expect(linux.systemd.units.get("fleet-watch.service")).toEqual({ active: true, enabled: true });
    expect(await linux.hedge(["retire-fleet", "--now"])).toEqual({ code: 2, output: "Usage: hedge retire-fleet [--dry-run]" });
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
  const nothingWritten = (home: string) => !existsSync(join(home, ".local/state/hedge/state.json")) && !existsSync(join(home, ".config/hedge/machine.json"));

  test("on Linux, exits 1, writes and starts nothing, and names hedge retire-fleet; after retire, it starts the new unit", async () => {
    const linux = machine("linux");
    linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });
    const { profile, release } = packSource(linux.home);
    release();

    const held = await linux.hedge(["apply", "--profile", profile]);

    expect(held.code).toBe(1);
    expect(held.output).toContain("The systemd unit fleet-watch.service from before the rename still runs (it is active), so Hedge started nothing. Run hedge retire-fleet, then hedge apply.");
    expect(linux.systemd.units.has("hedge-watch.service")).toBe(false);
    expect(nothingWritten(linux.home)).toBe(true);
    expect(readdirSync(join(linux.home, ".local/share/hedge/sources")).filter((name) => !name.endsWith(".lock"))).toEqual([]);

    expect((await linux.hedge(["retire-fleet"])).code).toBe(0);
    expect((await linux.hedge(["apply", "--profile", profile])).code).toBe(0);
    expect(linux.systemd.units.get("hedge-watch.service")).toEqual({ active: true, enabled: true });
  });

  test("on Linux, checks again before it starts anything, so a Fleet unit that starts while Hedge fetches a pack source stops the apply", async () => {
    const linux = machine("linux");
    const profile = startsFleetDuringFetch(linux);

    const applied = await linux.hedge(["apply", "--profile", profile]);

    expect(applied.code).toBe(1);
    expect(applied.output).toContain("The systemd unit fleet-watch.service from before the rename still runs (it is active), so Hedge started nothing. Run hedge retire-fleet, then hedge apply.");
    expect(linux.systemd.started("watch")).toBe(0);
    expect(linux.systemd.units.has("hedge-watch.service")).toBe(false);
  });

  test("on Linux, an apply --profile that a Fleet unit stops while Hedge fetches a pack source keeps the saved profile", async () => {
    const linux = machine("linux");
    const saved = profileDir([]);
    expect((await linux.hedge(["apply", "--profile", saved])).code).toBe(0);
    const profile = startsFleetDuringFetch(linux);

    const applied = await linux.hedge(["apply", "--profile", profile]);

    expect(applied.code).toBe(1);
    expect(applied.output).toContain("The systemd unit fleet-watch.service from before the rename still runs (it is active), so Hedge started nothing.");
    expect(JSON.parse(readFileSync(join(linux.home, ".config/hedge/machine.json"), "utf8")).profileDir).toBe(saved);
  });

  test("an apply --profile that a Fleet unit stops while Hedge fetches the same source at another ref leaves the saved profile's pack commands off that checkout", async () => {
    const linux = machine("linux");
    const source = sourceWithCommand();
    const hello = join(linux.home, "hello.txt");
    expect((await linux.hedge(["apply", "--profile", source.profile("main")])).code).toBe(0);
    const cacheLock = holdLock(join(linux.home, ".local/share/hedge/sources/extra.lock"));
    linux.clock.sleep = async () => {
      linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });
      cacheLock.release();
    };
    expect((await linux.hedge(["apply", "--profile", source.profile("candidate")])).code).toBe(1);

    const refused = await linux.hedge(["hello"]);

    expect(refused.code).not.toBe(0);
    expect(existsSync(hello)).toBe(false);
    expect(refused.output).toContain("The pack source extra at main did not load: the cached checkout is not main; run hedge apply.");
    expect((await linux.hedge(["retire-fleet"])).code).toBe(0);
    expect((await linux.hedge(["apply"])).code).toBe(0);
    expect((await linux.hedge(["hello"])).code).toBe(0);
    expect(readFileSync(hello, "utf8")).toBe("saved");
  });

  test("a pack command waits while an apply works in its source's cache, so it never loads the checkout that a refused apply left", async () => {
    const linux = machine("linux");
    const source = sourceWithCommand();
    const hello = join(linux.home, "hello.txt");
    expect((await linux.hedge(["apply", "--profile", source.profile("main")])).code).toBe(0);
    const cacheLock = holdLock(join(linux.home, ".local/share/hedge/sources/extra.lock"));
    let candidate: Awaited<ReturnType<typeof linux.hedge>> | undefined;
    let naps = 0;
    linux.clock.sleep = async () => {
      const nap = ++naps;
      if (nap === 1) candidate = await linux.hedge(["apply", "--profile", source.profile("candidate")]);
      if (nap === 2) {
        linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });
        cacheLock.release();
      }
    };

    const ran = await linux.hedge(["hello"]);

    expect(candidate?.code).toBe(1);
    expect(ran.code).not.toBe(0);
    expect(ran.output).toContain("The pack source extra at main did not load: the cached checkout is not main; run hedge apply.");
    expect(existsSync(hello)).toBe(false);
  });

  test("after an apply falls back to the last good checkout because the new ref does not fetch, the new profile's pack commands run that checkout", async () => {
    const linux = machine("linux");
    const source = sourceWithCommand();
    expect((await linux.hedge(["apply", "--profile", source.profile("main")])).code).toBe(0);

    const moved = await linux.hedge(["apply", "--profile", source.profile("gone")]);
    const ran = await linux.hedge(["hello"]);

    expect(moved.code).toBe(0);
    expect(moved.output).toContain("using main instead");
    expect(ran.code).toBe(0);
    expect(readFileSync(join(linux.home, "hello.txt"), "utf8")).toBe("saved");
  });

  test("a source URL with a token in it stays out of apply, refresh, and the unknown-command message", async () => {
    const linux = machine("linux");
    const source = sourceWithCommand();
    const saved = source.profile("main");
    expect((await linux.hedge(["apply", "--profile", saved])).code).toBe(0);
    const token = ["ghp", "q".repeat(30)].join("_");
    const secretUrl = `https://hedge:${token}@127.0.0.1:9/extra.git`;
    const profile = JSON.parse(readFileSync(join(saved, "hedge.json"), "utf8"));
    writeFileSync(join(saved, "hedge.json"), JSON.stringify({ ...profile, sources: [{ name: "extra", repo: secretUrl, ref: "main" }] }));

    const refreshed = await linux.hedge(["refresh"]);
    const applied = await linux.hedge(["apply", "--profile", source.profile("main", secretUrl)]);
    const unknown = await linux.hedge(["no-such-command"]);

    for (const output of [applied.output, unknown.output, refreshed.output]) expect(output).not.toContain(token);
    expect(unknown.output).toContain("The pack source extra at main did not load: the cached checkout is not main; run hedge apply.");
    expect(refreshed.output).toContain("https://127.0.0.1:9/extra.git");
  });

  test("hedge doctor with no profile yet, as get.sh leaves a machine where an old job still runs, names that job before it says the profile is missing", async () => {
    const linux = machine("linux");
    linux.processes.table.set(4242, { args: `/home/bin/bun ${join(linux.home, ".local/share/fleet/engine")}/src/cli.ts nightly` });

    const checked = await linux.hedge(["doctor"]);

    expect(checked.code).toBe(1);
    const held = checked.output.indexOf("To do: The running command fleet nightly (process 4242) from before the rename still runs");
    expect(held).toBeGreaterThanOrEqual(0);
    expect(checked.output.indexOf("hedge: no profile on this machine.")).toBeGreaterThan(held);
  });

  test("hedge doctor names each piece of Fleet that still runs and fails", async () => {
    const linux = machine("linux");
    expect((await linux.hedge(["apply", "--profile", profileDir([])])).code).toBe(0);
    linux.systemd.units.set("fleet-watch.service", { active: true, enabled: true });

    const checked = await linux.hedge(["doctor"]);

    expect(checked.code).toBe(1);
    expect(checked.output).toContain("To do: The systemd unit fleet-watch.service from before the rename still runs (it is active), so Hedge started nothing. Run hedge retire-fleet, then hedge apply.");
    expect(checked.output).toContain("Run hedge apply to fix what Hedge can fix.");
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
