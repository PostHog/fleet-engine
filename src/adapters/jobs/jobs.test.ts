import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Owned, PackJob, Plan } from "../../pack/types.ts";
import { apply, check } from "../../reconciler/apply.ts";
import { tempDirs } from "../../testing/git.ts";
import { spawnAsync } from "../../testing/spawn.ts";
import type { CommandRunner } from "../run.ts";
import { jobsAdapter, type HedgeTask, type T3Tasks } from "./adapter.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const engine = "/opt/fleet-engine";

function plan(os: "darwin" | "linux", jobs: Array<PackJob & { pack?: string }>): Plan {
  return {
    machine: { schema: 1, role: os === "darwin" ? "mac" : "devbox" },
    os,
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [],
    config: [],
    owners: {},
    jobs: jobs.map((job) => ({ pack: "base", ...job }) as Owned<PackJob>),
    human: [],
    steps: [],
    checks: [],
    commands: {},
    handlers: {},
    settings: {},
    unanswered: [],
    ask: [],
    dropped: [],
    models: [],
  };
}

const prune: PackJob = { id: "prune", command: ["hedge", "prune", "--auto"], schedule: { every: "1d", at: "03:17" } };
const pull: PackJob = { id: "skills-pull", command: ["git", "-C", "/home/u/skills", "pull"], schedule: { every: "5m" } };

function crontab(initial: string | undefined) {
  const state = { text: initial, writes: 0 };
  const run: CommandRunner = async (command, options) => {
    if (command.join(" ") === "crontab -l") return state.text === undefined ? { code: 1, stdout: "", stderr: "no crontab for user\n" } : { code: 0, stdout: state.text };
    if (command.join(" ") === "crontab -") {
      state.text = options?.input;
      state.writes++;
      return { code: 0, stdout: "" };
    }
    return { code: 127, stdout: "" };
  };
  return { state, adapter: jobsAdapter({ run, engineRoot: engine }) };
}

const checkFails = { reason: "check base-ready does not pass", check: "base-ready" };
const outageHides = { reason: "workflow team-flow is off" };

function outageDropping(os: "darwin" | "linux", id: string, why: { reason: string; check?: string } = checkFails, jobs: PackJob[] = []): Plan {
  return { ...plan(os, jobs), packs: [{ name: "base", source: "engine", ref: "main", available: true }, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }], dropped: [{ pack: "base", item: `job ${id}`, ...why }] };
}

async function runDueLines(text: string | undefined, home: string) {
  for (const line of (text ?? "").split("\n").filter((entry) => entry && !entry.startsWith("#"))) {
    await spawnAsync(["/bin/sh", "-c", line.replace(/^(\S+\s+){5}/, "")], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
  }
  return existsSync(join(home, "ran")) ? readdirSync(join(home, "ran")).sort() : [];
}

const ping = (id: string): PackJob => ({ id, command: ["/bin/sh", "-c", `mkdir -p "$HOME/ran" && touch "$HOME/ran/${id}"`], schedule: { every: "5m" } });

describe("cron jobs on Linux", () => {
  test("adds marked lines that run launcher scripts, and keeps foreign lines", async () => {
    const home = temp.make("home-");
    const foreign = "MAILTO=me\n0 * * * * /usr/bin/backup # nightly backup\n";
    const cron = crontab(foreign);

    await apply(plan("linux", [prune, pull]), { home, adapters: [cron.adapter] });

    const jobs = `${home}/.local/state/hedge/jobs`;
    expect(cron.state.text).toBe(foreign + `17 3 * * * /bin/sh '${jobs}/prune.sh' # hedge:prune\n` + `*/5 * * * * /bin/sh '${jobs}/skills-pull.sh' # hedge:skills-pull\n`);
  });

  test("a launcher finds tools on Hedge's PATH and passes odd arguments through unchanged", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/echo-args"), '#!/bin/sh\nprintf "%s|" "$@"\n');
    chmodSync(join(home, ".local/bin/echo-args"), 0o755);
    const odd: PackJob = { id: "odd", command: ["echo-args", "50%", "a\\%b", "two\nlines", "it's"], schedule: { every: "15m" } };
    const cron = crontab("");

    await apply(plan("linux", [odd]), { home, adapters: [cron.adapter] });

    expect(cron.state.text).toBe(`*/15 * * * * /bin/sh '${home}/.local/state/hedge/jobs/odd.sh' # hedge:odd\n`);
    const ran = await spawnAsync(["/bin/sh", join(home, ".local/state/hedge/jobs/odd.sh")], { env: { PATH: "/nonexistent" } });
    expect(ran.exitCode).toBe(0);
    expect(readFileSync(join(home, ".local/state/hedge/jobs/odd.log"), "utf8")).toBe("50%|a\\%b|two\nlines|it's|");
  });

  test("replaces the crontab line that Hedge wrote before the rename, and keeps no second line for the job", async () => {
    const home = temp.make("home-");
    const job: PackJob = { id: "odd", command: ["true"], schedule: { every: "15m" } };
    const cron = crontab(`*/15 * * * * /bin/sh '${home}/.local/state/fleet/jobs/odd.sh' # fleet:odd\n0 * * * * /usr/bin/backup\n`);

    await apply(plan("linux", [job]), { home, adapters: [cron.adapter] });

    expect(cron.state.text).toBe(`*/15 * * * * /bin/sh '${home}/.local/state/hedge/jobs/odd.sh' # hedge:odd\n0 * * * * /usr/bin/backup\n`);
  });

  test("puts back a missing launcher folder, and doctor sees it first", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    rmSync(join(home, ".local/state/hedge/jobs"), { recursive: true });

    const report = await check(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(report.findings).toContainEqual({ id: "job:skills-pull", pack: "base", say: "The skills-pull job needs to be updated.", repair: "apply" });

    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(existsSync(join(home, ".local/state/hedge/jobs/skills-pull.sh"))).toBe(true);
    expect(cron.state.writes).toBe(1);
    expect((await check(plan("linux", [pull]), { home, adapters: [cron.adapter] })).ok).toBe(true);
  });

  test("a rerun changes nothing, and a dropped job loses only its own line", async () => {
    const home = temp.make("home-");
    const cron = crontab("0 * * * * /usr/bin/backup\n");
    await apply(plan("linux", [prune, pull]), { home, adapters: [cron.adapter] });
    await apply(plan("linux", [prune, pull]), { home, adapters: [cron.adapter] });
    expect(cron.state.writes).toBe(1);

    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });

    expect(cron.state.text).toStartWith("0 * * * * /usr/bin/backup\n*/5 * * * * ");
    expect(cron.state.text).not.toContain("hedge:prune");
    expect(existsSync(join(home, ".local/state/hedge/jobs/prune.sh"))).toBe(false);
  });

  test("a duplicate marked line goes, and the launcher of the line that stays is kept", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    const line = cron.state.text!;
    cron.state.text = line + line;

    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(cron.state.text).toBe(line);
    expect(existsSync(join(home, ".local/state/hedge/jobs/skills-pull.sh"))).toBe(true);

    cron.state.text = line + line;
    const offline = { ...plan("linux", []), packs: [{ name: "base", source: "engine", ref: "main", available: true }, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    await apply(offline, { home, adapters: [cron.adapter] });
    expect(cron.state.text).toBe(line);
    expect(existsSync(join(home, ".local/state/hedge/jobs/skills-pull.sh"))).toBe(true);
  });

  test("while a source is out, stops running a job whose check fails, and keeps the others running", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    await apply(plan("linux", [ping("gated"), ping("kept")]), { home, adapters: [cron.adapter] });
    await apply(outageDropping("linux", "gated", checkFails, [ping("kept")]), { home, adapters: [cron.adapter] });
    expect(await runDueLines(cron.state.text, home)).toEqual(["kept"]);
  });

  test("while a source is out, keeps running a job that leaves the plan only because of the outage", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    await apply(plan("linux", [ping("hidden"), ping("kept")]), { home, adapters: [cron.adapter] });
    await apply(outageDropping("linux", "hidden", outageHides, [ping("kept")]), { home, adapters: [cron.adapter] });
    expect(await runDueLines(cron.state.text, home)).toEqual(["hidden", "kept"]);
  });

  test("starts a crontab when the user has none, with no T3 precondition", async () => {
    const home = temp.make("home-");
    const cron = crontab(undefined);
    await apply(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(cron.state.text).toEndWith("# hedge:skills-pull\n");
    expect(existsSync(join(home, ".t3"))).toBe(false);
  });

  test("writes nothing when crontab cannot be read", async () => {
    const home = temp.make("home-");
    const run: CommandRunner = async (command) => (command[1] === "-l" ? { code: 1, stdout: "", stderr: "permission denied\n" } : { code: 0, stdout: "" });
    const writes: string[][] = [];
    const report = await apply(plan("linux", [pull]), { home, adapters: [jobsAdapter({ run: async (command, options) => (writes.push(command), run(command, options)), engineRoot: engine })] });
    expect(writes).toEqual([["crontab", "-l"]]);
    expect(report.findings).toContainEqual({ id: "jobs:cron", pack: "engine", say: "Could not read your crontab (permission denied), so jobs were not changed.", repair: "human" });
  });

  test("doctor reports a missing job without writing", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    const report = await check(plan("linux", [pull]), { home, adapters: [cron.adapter] });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({ id: "job:skills-pull", pack: "base", say: "The skills-pull job needs to be added.", repair: "apply" });
    expect(cron.state.writes).toBe(0);
  });
});

describe("a pack source that cannot be fetched", () => {
  test("keeps every hedge cron line, agent, and task until the source is back", async () => {
    const home = temp.make("home-");
    const cron = crontab("");
    await apply(plan("linux", [prune, pull]), { home, adapters: [cron.adapter] });
    const offline = { ...plan("linux", [pull]), packs: [{ name: "base", source: "engine", ref: "main", available: true }, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    await apply(offline, { home, adapters: [cron.adapter] });
    expect(cron.state.text).toContain("# hedge:prune");
  });
});

describe("launchd jobs on a Mac", () => {
  function launchctl(stuck = false, launchdLabel?: string) {
    const calls: string[][] = [];
    const loaded = new Set<string>();
    const disabled = new Set<string>();
    const mode = { stuck, printFails: false };
    const run: CommandRunner = async (command) => {
      calls.push(command);
      const [, verb, target] = command;
      if (verb === "disable") disabled.add(target!);
      if (verb === "print") return mode.printFails ? { code: 127, stdout: "" } : { code: loaded.has(target!) ? 0 : 113, stdout: "" };
      if (verb === "bootstrap") loaded.add(`gui/501/${command[3]!.split("/").at(-1)!.replace(/\.plist$/, "")}`);
      if (verb === "bootout") {
        if (mode.stuck) return { code: 5, stdout: "" };
        loaded.delete(target!);
      }
      return { code: 0, stdout: "" };
    };
    return { calls, loaded, disabled, mode, run, adapter: jobsAdapter({ run, engineRoot: engine, uid: 501, launchdLabel }) };
  }

  test("writes a dev.hedge plist that runs the launcher script, and loads it", async () => {
    const home = temp.make("home-");
    const mac = launchctl();

    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });

    const path = join(home, "Library/LaunchAgents/dev.hedge.prune.plist");
    expect(readFileSync(path, "utf8")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.hedge.prune</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${home}/.local/state/hedge/jobs/prune.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${home}/.local/state/hedge/jobs/prune.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/.local/state/hedge/jobs/prune.log</string>
</dict>
</plist>
`);
    expect(mac.loaded.has("gui/501/dev.hedge.prune")).toBe(true);
    expect(readFileSync(join(home, ".local/state/hedge/jobs/prune.sh"), "utf8")).toContain(`PATH='${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'`);
  });

  const beforeTheRename = async (mac: ReturnType<typeof launchctl>, home: string) => {
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    const agents = join(home, "Library/LaunchAgents");
    const old = readFileSync(join(agents, "dev.hedge.prune.plist"), "utf8").replaceAll("hedge", "fleet");
    rmSync(join(agents, "dev.hedge.prune.plist"));
    writeFileSync(join(agents, "dev.fleet.prune.plist"), old);
    mkdirSync(join(home, ".local/state/fleet/jobs"), { recursive: true });
    writeFileSync(join(home, ".local/state/fleet/jobs/prune.plist"), old);
    mac.loaded.delete("gui/501/dev.hedge.prune");
    mac.loaded.add("gui/501/dev.fleet.prune");
    return { path: join(agents, "dev.fleet.prune.plist"), old };
  };

  test("stops and turns off the dev.fleet job that Hedge wrote before the rename, keeps its file, and loads the dev.hedge one in its place", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    const legacy = await beforeTheRename(mac, home);

    const report = await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });

    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.old);
    expect(mac.loaded.has("gui/501/dev.fleet.prune")).toBe(false);
    expect(mac.disabled.has("gui/501/dev.fleet.prune")).toBe(true);
    expect(mac.loaded.has("gui/501/dev.hedge.prune")).toBe(true);
    expect(report.actions).toContainEqual({ target: "launchd job dev.fleet.prune", operation: "remove", reason: "turned off" });
    expect((await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] })).actions).toEqual([]);
  });

  test("leaves the dev.fleet job that runs this apply loaded, so the update does not stop itself, and loads the dev.hedge one", async () => {
    const home = temp.make("home-");
    const mac = launchctl(false, "dev.fleet.prune");
    const legacy = await beforeTheRename(mac, home);

    const report = await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });

    expect(mac.calls.some((call) => call[1] === "bootout" && call[2] === "gui/501/dev.fleet.prune")).toBe(false);
    expect(mac.loaded.has("gui/501/dev.hedge.prune")).toBe(true);
    expect(report.findings.map((finding) => finding.say)).toContain("The old dev.fleet.prune job runs this apply, so Hedge leaves it for the next apply to stop.");
    await apply(plan("darwin", [prune]), { home, adapters: [jobsAdapter({ run: mac.run, engineRoot: engine, uid: 501 })] });
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.old);
    expect(mac.loaded.has("gui/501/dev.fleet.prune")).toBe(false);
    expect(mac.disabled.has("gui/501/dev.fleet.prune")).toBe(true);
  });

  test("when the dev.fleet job does not stop, holds the dev.hedge one back and turns the old one off on a later apply", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    const legacy = await beforeTheRename(mac, home);
    mac.mode.stuck = true;

    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });

    expect(mac.loaded.has("gui/501/dev.hedge.prune")).toBe(false);
    expect(mac.loaded.has("gui/501/dev.fleet.prune")).toBe(true);
    mac.mode.stuck = false;
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.old);
    expect(mac.loaded.has("gui/501/dev.fleet.prune")).toBe(false);
    expect(mac.loaded.has("gui/501/dev.hedge.prune")).toBe(true);
  });

  test("leaves a dev.fleet plist alone that is not what Hedge wrote, such as the private Fleet's", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    const other = join(home, "Library/LaunchAgents/dev.fleet.prune.plist");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "<plist>someone else's</plist>\n");
    mac.loaded.add("gui/501/dev.fleet.prune");

    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });

    expect(readFileSync(other, "utf8")).toBe("<plist>someone else's</plist>\n");
    expect(mac.loaded.has("gui/501/dev.fleet.prune")).toBe(true);
  });

  test("escapes &, <, and > in the plist's paths, so a home with them still loads", async () => {
    const home = temp.make("home-a&b<c>-");
    const mac = launchctl();
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    const text = readFileSync(join(home, "Library/LaunchAgents/dev.hedge.prune.plist"), "utf8");
    const escaped = home.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    expect(text).toContain(`<string>${escaped}/.local/state/hedge/jobs/prune.sh</string>`);
    expect(text).toContain(`<string>${escaped}/.local/state/hedge/jobs/prune.log</string>`);
    expect(text).not.toContain(home);
    expect(mac.calls).toContainEqual(["launchctl", "bootstrap", "gui/501", join(home, "Library/LaunchAgents/dev.hedge.prune.plist")]);
  });

  test("reports a job that launchd does not load, and loads it on the next apply", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    const refuse: CommandRunner = async (command) => (command[1] === "bootstrap" ? { code: 5, stdout: "" } : { code: 113, stdout: "" });
    const refused = await apply(plan("darwin", [prune]), { home, adapters: [jobsAdapter({ run: refuse, engineRoot: engine, uid: 501 })] });
    expect(refused.findings).toContainEqual({ id: "job:prune", pack: "base", say: "launchd did not load the prune job.", repair: "apply" });
    expect(existsSync(join(home, "Library/LaunchAgents/dev.hedge.prune.plist"))).toBe(true);

    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    expect(mac.loaded.has("gui/501/dev.hedge.prune")).toBe(true);
  });

  test("keeps an agent that launchd does not stop", async () => {
    const home = temp.make("home-");
    const mac = launchctl(true);
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });

    const report = await apply(plan("darwin", []), { home, adapters: [mac.adapter] });

    expect(existsSync(join(home, "Library/LaunchAgents/dev.hedge.prune.plist"))).toBe(true);
    expect(report.findings).toContainEqual({ id: "job:prune", pack: "engine", say: "launchd did not stop the prune job, so Hedge left its agent as it is.", repair: "apply" });
  });

  test("keeps an agent and its launcher when launchd cannot say whether the agent stopped", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    mac.mode.stuck = true;
    mac.mode.printFails = true;

    const report = await apply(plan("darwin", []), { home, adapters: [mac.adapter] });

    expect(existsSync(join(home, "Library/LaunchAgents/dev.hedge.prune.plist"))).toBe(true);
    expect(existsSync(join(home, ".local/state/hedge/jobs/prune.sh"))).toBe(true);
    expect(report.actions).toEqual([]);
    expect(report.findings).toContainEqual({ id: "job:prune", pack: "engine", say: "Could not check that launchd stopped the prune job (launchctl print exit 127), so Hedge left its agent as it is.", repair: "apply" });
  });

  test("keeps the old launcher when launchd does not stop the agent it would update", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    const launcher = readFileSync(join(home, ".local/state/hedge/jobs/prune.sh"), "utf8");
    mac.mode.stuck = true;

    const report = await apply(plan("darwin", [{ ...prune, command: ["hedge", "prune"], schedule: { every: "5m" } }]), { home, adapters: [mac.adapter] });

    expect(readFileSync(join(home, ".local/state/hedge/jobs/prune.sh"), "utf8")).toBe(launcher);
    expect(report.findings.map((finding) => finding.say)).toContain("launchd did not stop the prune job, so Hedge left its agent as it is.");
  });

  test("leaves a dev.hedge plist that Hedge did not write alone", async () => {
    const home = temp.make("home-");
    const agents = join(home, "Library/LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const theirs = '<?xml version="1.0"?>\n<plist version="1.0"><dict>\n  <key>Label</key><string>dev.hedge.prune</string>\n  <key>Label</key><string>com.example.backup</string>\n</dict></plist>\n';
    writeFileSync(join(agents, "dev.hedge.prune.plist"), theirs);
    const mac = launchctl();

    const kept = await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    const left = await apply(plan("darwin", []), { home, adapters: [mac.adapter] });

    expect(readFileSync(join(agents, "dev.hedge.prune.plist"), "utf8")).toBe(theirs);
    expect(mac.calls).toEqual([]);
    const say = "Left Library/LaunchAgents/dev.hedge.prune.plist alone: Hedge did not write it, or it changed since. Move it away, then run hedge apply.";
    expect(kept.findings).toContainEqual({ id: "job:prune", pack: "base", say, repair: "human" });
    expect(left.findings).toContainEqual({ id: "job:prune", pack: "engine", say, repair: "human" });
  });

  test("leaves an agent alone once someone edits the plist Hedge wrote", async () => {
    const home = temp.make("home-");
    const file = join(home, "Library/LaunchAgents/dev.hedge.prune.plist");
    const mac = launchctl();
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    const edited = readFileSync(file, "utf8").replace("<dict>", "<dict>\n  <key>Disabled</key>\n  <true/>");
    writeFileSync(file, edited);
    const before = mac.calls.length;

    const report = await apply(plan("darwin", []), { home, adapters: [mac.adapter] });

    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(mac.calls.slice(before)).toEqual([]);
    expect(report.findings.map((finding) => finding.id)).toContain("job:prune");
  });

  test("saves its copy of an agent that already matches, so a later change still applies", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    rmSync(join(home, ".local/state/hedge/jobs/prune.plist"));
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    expect(existsSync(join(home, ".local/state/hedge/jobs/prune.plist"))).toBe(true);
    const changed = await apply(plan("darwin", [{ ...prune, schedule: { every: "5m" } }]), { home, adapters: [mac.adapter] });
    expect(changed.findings).toEqual([]);
    expect(readFileSync(join(home, "Library/LaunchAgents/dev.hedge.prune.plist"), "utf8")).toContain("<key>StartInterval</key>");
  });

  test("removes the copy and launcher of a dropped job whose agent is already gone", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    await apply(plan("darwin", [prune]), { home, adapters: [mac.adapter] });
    rmSync(join(home, "Library/LaunchAgents/dev.hedge.prune.plist"));
    await apply(plan("darwin", []), { home, adapters: [mac.adapter] });
    expect(existsSync(join(home, ".local/state/hedge/jobs/prune.plist"))).toBe(false);
    expect(existsSync(join(home, ".local/state/hedge/jobs/prune.sh"))).toBe(false);
  });

  test("keeps every agent, launcher, and copy until a pack source that cannot be fetched is back", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    await apply(plan("darwin", [prune, pull]), { home, adapters: [mac.adapter] });
    const offline = { ...plan("darwin", [pull]), packs: [{ name: "base", source: "engine", ref: "main", available: true }, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    await apply(offline, { home, adapters: [mac.adapter] });
    expect(mac.loaded.has("gui/501/dev.hedge.prune")).toBe(true);
    expect(existsSync(join(home, "Library/LaunchAgents/dev.hedge.prune.plist"))).toBe(true);
    expect(existsSync(join(home, ".local/state/hedge/jobs/prune.sh"))).toBe(true);
    expect(existsSync(join(home, ".local/state/hedge/jobs/prune.plist"))).toBe(true);
  });

  test("while a source is out, unloads an agent whose check fails and keeps one the outage hides", async () => {
    const home = temp.make("home-");
    const mac = launchctl();
    await apply(plan("darwin", [prune, pull]), { home, adapters: [mac.adapter] });
    await apply({ ...outageDropping("darwin", "prune", checkFails), dropped: [{ pack: "base", item: "job prune", ...checkFails }, { pack: "base", item: "job skills-pull", ...outageHides }] }, { home, adapters: [mac.adapter] });
    expect([mac.loaded.has("gui/501/dev.hedge.prune"), mac.loaded.has("gui/501/dev.hedge.skills-pull")]).toEqual([false, true]);
  });

  test("uses an interval for frequent jobs, reruns without reloading, and removes only its own agents", async () => {
    const home = temp.make("home-");
    const agents = join(home, "Library/LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "com.example.backup.plist"), "<plist/>");
    const mac = launchctl();

    await apply(plan("darwin", [pull, prune]), { home, adapters: [mac.adapter] });
    expect(readFileSync(join(agents, "dev.hedge.skills-pull.plist"), "utf8")).toContain("<key>StartInterval</key>\n  <integer>300</integer>");
    const before = mac.calls.length;
    await apply(plan("darwin", [pull, prune]), { home, adapters: [mac.adapter] });
    expect(mac.calls.slice(before).filter((call) => call[1] !== "print")).toEqual([]);

    await apply(plan("darwin", [pull]), { home, adapters: [mac.adapter] });
    expect(readdirSync(agents).sort()).toEqual(["com.example.backup.plist", "dev.hedge.skills-pull.plist"]);
    expect(mac.calls).toContainEqual(["launchctl", "bootout", "gui/501/dev.hedge.prune"]);
  });
});

describe("another home directory", () => {
  test("leaves the user's cron alone when HOME is not their home and no runner is given", async () => {
    const home = temp.make("home-");
    const report = await apply(plan("linux", [pull]), { home, adapters: [jobsAdapter({ engineRoot: engine })] });
    expect(report).toMatchObject({ actions: [], findings: [] });
  });
});

describe("T3 scheduled tasks", () => {
  const loop: PackJob = {
    id: "quality-loop",
    command: [],
    schedule: { every: "1d", at: "02:30" },
    runner: "t3",
    workflow: "quality-loop",
    task: { prompt: "Run the quality-loop skill.", projectSetting: "orchestration.loopProject", modelRole: "implementation", workspaceStrategy: "worktree", runtimeMode: "full-access", project: "/home/u/app" },
  };
  const wanted: HedgeTask = {
    id: "hedge:quality-loop",
    title: "Hedge: quality-loop",
    prompt: "Run the quality-loop skill.",
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "02:30" },
    project: "/home/u/app",
    modelRole: "implementation",
    workspaceStrategy: "worktree",
    runtimeMode: "full-access",
  };

  function server(initial: HedgeTask[] = []) {
    const tasks = new Map(initial.map((task) => [task.id, task]));
    const calls: string[] = [];
    const client: T3Tasks = {
      list: async () => [...tasks.values()],
      upsert: async (task) => void (calls.push(`upsert ${task.id}`), tasks.set(task.id, task)),
      setEnabled: async (id, enabled) => void (calls.push(`enable ${id} ${enabled}`), tasks.set(id, { ...tasks.get(id)!, enabled })),
    };
    return { tasks, calls, adapter: jobsAdapter({ run: async () => ({ code: 0, stdout: "" }), engineRoot: engine, t3: async () => client }) };
  }

  test("creates the task once through the T3 server", async () => {
    const home = temp.make("home-");
    const t3 = server();
    await apply(plan("linux", [loop]), { home, adapters: [t3.adapter] });
    await apply(plan("linux", [loop]), { home, adapters: [t3.adapter] });
    expect(t3.tasks.get("hedge:quality-loop")).toEqual(wanted);
    expect(t3.calls).toEqual(["upsert hedge:quality-loop"]);
  });

  test("disables a hedge task whose workflow is off, and leaves the user's tasks alone", async () => {
    const home = temp.make("home-");
    const mine = { ...wanted, id: "my-digest", title: "My digest" };
    const t3 = server([wanted, mine]);
    await apply(plan("linux", []), { home, adapters: [t3.adapter] });
    expect(t3.tasks.get("hedge:quality-loop")?.enabled).toBe(false);
    expect(t3.tasks.get("my-digest")?.enabled).toBe(true);
    expect(t3.calls).toEqual(["enable hedge:quality-loop false"]);
  });

  test("turns off the task that Hedge made before the rename, whose id starts with fleet:", async () => {
    const home = temp.make("home-");
    const t3 = server([{ ...wanted, id: "fleet:quality-loop" }]);
    await apply(plan("linux", []), { home, adapters: [t3.adapter] });
    expect(t3.tasks.get("fleet:quality-loop")?.enabled).toBe(false);
  });

  test("keeps the fleet: task on while T3 Code does not take its hedge: task", async () => {
    const home = temp.make("home-");
    const t3 = server([{ ...wanted, id: "fleet:quality-loop" }]);
    const client: T3Tasks = { list: async () => [...t3.tasks.values()], upsert: async () => Promise.reject(new Error("project not found")), setEnabled: async (id, enabled) => void t3.tasks.set(id, { ...t3.tasks.get(id)!, enabled }) };
    await apply(plan("linux", [loop]), { home, adapters: [jobsAdapter({ run: async () => ({ code: 0, stdout: "" }), engineRoot: engine, t3: async () => client })] });
    expect(t3.tasks.get("fleet:quality-loop")?.enabled).toBe(true);
    await apply(plan("linux", [loop]), { home, adapters: [t3.adapter] });
    expect(t3.tasks.get("fleet:quality-loop")?.enabled).toBe(false);
    expect(t3.tasks.get("hedge:quality-loop")?.enabled).toBe(true);
  });

  test("while a source is out, turns off a task the plan drops on purpose and keeps the others", async () => {
    const home = temp.make("home-");
    const other = { ...wanted, id: "hedge:digest" };
    const t3 = server([wanted, other]);
    await apply(outageDropping("linux", "quality-loop"), { home, adapters: [t3.adapter] });
    expect([t3.tasks.get("hedge:quality-loop")?.enabled, t3.tasks.get("hedge:digest")?.enabled]).toEqual([false, true]);
  });

  test("while a source is out, keeps a task that leaves the plan only because of the outage", async () => {
    const home = temp.make("home-");
    const t3 = server([wanted]);
    await apply(outageDropping("linux", "quality-loop", outageHides), { home, adapters: [t3.adapter] });
    expect(t3.tasks.get("hedge:quality-loop")?.enabled).toBe(true);
  });

  test("reports a task T3 refuses and still reconciles the others", async () => {
    const home = temp.make("home-");
    const other = { ...loop, id: "digest", workflow: "digest" };
    const dropped = { ...wanted, id: "hedge:old" };
    const t3 = server([dropped]);
    const refusing = jobsAdapter({
      run: async () => ({ code: 0, stdout: "" }),
      engineRoot: engine,
      t3: async () => ({
        list: async () => [...t3.tasks.values()],
        upsert: async (task) => {
          if (task.id === "hedge:quality-loop") throw new Error("T3 Code has no project at /home/u/app");
          t3.calls.push(`upsert ${task.id}`);
          t3.tasks.set(task.id, task);
        },
        setEnabled: async (id, enabled) => void (t3.calls.push(`enable ${id} ${enabled}`), t3.tasks.set(id, { ...t3.tasks.get(id)!, enabled })),
      }),
    });
    const report = await apply(plan("linux", [loop, other]), { home, adapters: [refusing] });
    expect(report.findings).toContainEqual({ id: "task:quality-loop", pack: "base", say: "Could not add the quality-loop task to T3 Code: T3 Code has no project at /home/u/app", repair: "apply" });
    expect(t3.calls).toEqual(["upsert hedge:digest", "enable hedge:old false"]);
  });

  test("reports a T3 server that cannot list its tasks without failing the apply", async () => {
    const home = temp.make("home-");
    const adapter = jobsAdapter({
      run: async () => ({ code: 0, stdout: "" }),
      engineRoot: engine,
      t3: async () => ({ list: async () => Promise.reject(new Error("T3 Code closed the connection")), upsert: async () => {}, setEnabled: async () => {} }),
    });
    const report = await apply(plan("linux", [loop]), { home, adapters: [adapter] });
    expect(report.findings).toContainEqual({ id: "tasks:t3", pack: "engine", say: "Could not read T3 Code's scheduled tasks: T3 Code closed the connection. Run hedge apply again.", repair: "apply" });
  });

  test("reports tasks as pending when no T3 server answers", async () => {
    const home = temp.make("home-");
    const adapter = jobsAdapter({ run: async () => ({ code: 0, stdout: "" }), engineRoot: engine, t3: async () => undefined });
    const report = await check(plan("linux", [loop]), { home, adapters: [adapter] });
    expect(report.findings).toContainEqual({ id: "task:quality-loop", pack: "base", say: "The quality-loop task waits for T3 Code to run. The next hedge apply after T3 Code starts adds it.", repair: "apply" });
  });
});

describe("service jobs", () => {
  const trigger: PackJob = { id: "slack-trigger", command: ["hedge", "slack-trigger", "run"], schedule: { every: "always" } };
  const unitPath = (home: string, id = "slack-trigger") => join(home, ".config/systemd/user", `hedge-${id}.service`);

  function systemd(options: { manager?: boolean; refuse?: string; crontab?: boolean } = {}) {
    const calls: string[][] = [];
    const units = new Map<string, { active: boolean; enabled: boolean }>();
    const cron = { text: "" };
    const manager = { stale: false };
    const run: CommandRunner = async (command, runOptions) => {
      calls.push(command);
      if (command.join(" ") === "crontab -l") return { code: 0, stdout: cron.text };
      if (command.join(" ") === "crontab -") return options.crontab === false ? { code: 1, stdout: "" } : ((cron.text = runOptions?.input ?? ""), { code: 0, stdout: "" });
      if (command[0] !== "systemctl" || command[1] !== "--user") return { code: 127, stdout: "" };
      if (options.manager === false) return { code: 1, stdout: "", stderr: "Failed to connect to bus\n" };
      const [verb, ...rest] = command.slice(2);
      const unit = rest.at(-1)!;
      if (verb === options.refuse) return { code: 1, stdout: "", stderr: `Failed to ${verb}\n` };
      const state = units.get(unit) ?? { active: false, enabled: false };
      if (verb === "show") return { code: 0, stdout: `ActiveState=${state.active ? "active" : "inactive"}\nUnitFileState=${state.enabled ? "enabled" : ""}\nNeedDaemonReload=${manager.stale ? "yes" : "no"}\n` };
      if (verb === "daemon-reload") manager.stale = false;
      if (verb === "enable") units.set(unit, { ...state, enabled: true });
      if (verb === "restart") units.set(unit, { ...state, active: true });
      if (verb === "disable") units.set(unit, { active: false, enabled: false });
      if (verb === "stop") units.set(unit, { ...state, active: false });
      return { code: 0, stdout: "" };
    };
    return { calls, units, cron, manager, adapter: jobsAdapter({ run, engineRoot: engine }) };
  }
  const changes = (calls: string[][]) => calls.filter((call) => call[0] === "systemctl" && call[2] !== "show");

  const beforeTheRename = async (linux: ReturnType<typeof systemd>, home: string) => {
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    const legacy = join(home, ".config/systemd/user/fleet-slack-trigger.service");
    renameSync(unitPath(home), legacy);
    mkdirSync(join(home, ".local/state/fleet/jobs"), { recursive: true });
    writeFileSync(join(home, ".local/state/fleet/jobs/slack-trigger.service"), readFileSync(legacy, "utf8"));
    linux.units.delete("hedge-slack-trigger.service");
    linux.units.set("fleet-slack-trigger.service", { active: true, enabled: true });
    return { path: legacy, old: readFileSync(legacy, "utf8") };
  };

  test("stops and disables the fleet- unit that Hedge wrote before the rename, keeps its file, and starts the hedge- unit in its place", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    const legacy = await beforeTheRename(linux, home);

    const report = await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });

    expect(report.ok).toBe(true);
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.old);
    expect(linux.units.get("fleet-slack-trigger.service")).toEqual({ active: false, enabled: false });
    expect(linux.units.get("hedge-slack-trigger.service")).toEqual({ active: true, enabled: true });
    expect(existsSync(unitPath(home))).toBe(true);
  });

  test("when the fleet- unit does not stop, does not start the hedge- unit beside it, and turns the old one off on a later apply", async () => {
    const home = temp.make("home-");
    const refusing = systemd({ refuse: "disable" });
    const legacy = await beforeTheRename(refusing, home);

    const report = await apply(plan("linux", [trigger]), { home, adapters: [refusing.adapter] });

    expect(report.findings.map((finding) => finding.say)).toContain("systemd did not stop the old fleet-slack-trigger.service job (Failed to disable), so Hedge left it as it is and did not start the new one.");
    expect(refusing.units.get("hedge-slack-trigger.service")).toBeUndefined();
    const linux = systemd();
    linux.units.set("fleet-slack-trigger.service", { active: true, enabled: true });
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.old);
    expect(linux.units.get("fleet-slack-trigger.service")).toEqual({ active: false, enabled: false });
    expect(linux.units.get("hedge-slack-trigger.service")).toEqual({ active: true, enabled: true });
  });

  test("leaves a fleet- unit alone that is not what Hedge wrote, such as the private Fleet's", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    const other = join(home, ".config/systemd/user/fleet-slack-trigger.service");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "[Service]\nExecStart=/bin/true\n");
    linux.units.set("fleet-slack-trigger.service", { active: true, enabled: true });

    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });

    expect(readFileSync(other, "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
    expect(linux.units.get("fleet-slack-trigger.service")).toEqual({ active: true, enabled: true });
  });

  test("writes a user unit that keeps the launcher running, enables it, and starts it, with no crontab line", async () => {
    const home = temp.make("home-");
    const linux = systemd();

    const report = await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });

    const jobs = `${home}/.local/state/hedge/jobs`;
    expect(readFileSync(unitPath(home), "utf8")).toBe(`[Unit]
Description=Hedge: slack-trigger
After=network-online.target

[Service]
ExecStart=/bin/sh "${jobs}/slack-trigger.sh"
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`);
    expect(readFileSync(join(jobs, "slack-trigger.sh"), "utf8")).toContain(`exec '/bin/sh' '${engine}/hedge' 'slack-trigger' 'run' >>'${jobs}/slack-trigger.log' 2>&1`);
    expect(changes(linux.calls)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "hedge-slack-trigger.service"],
      ["systemctl", "--user", "restart", "hedge-slack-trigger.service"],
    ]);
    expect(linux.calls.some((call) => call.join(" ") === "crontab -")).toBe(false);
    expect(report.actions).toContainEqual({ target: ".config/systemd/user/hedge-slack-trigger.service", operation: "create" });
  });

  test("a second apply changes nothing", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    const before = linux.calls.length;

    const report = await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });

    expect(changes(linux.calls.slice(before))).toEqual([]);
    expect(report.actions).toEqual([]);
    expect((await check(plan("linux", [trigger]), { home, adapters: [linux.adapter] })).ok).toBe(true);
  });

  test("restarts the service when its command changes", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    const before = linux.calls.length;
    const changed = { ...trigger, command: ["hedge", "slack-trigger", "run", "--verbose"] };

    expect((await check(plan("linux", [changed]), { home, adapters: [linux.adapter] })).findings).toContainEqual({ id: "job:slack-trigger", pack: "base", say: "The slack-trigger job needs to be updated.", repair: "apply" });
    await apply(plan("linux", [changed]), { home, adapters: [linux.adapter] });

    expect(readFileSync(join(home, ".local/state/hedge/jobs/slack-trigger.sh"), "utf8")).toContain("'--verbose'");
    expect(changes(linux.calls.slice(before))).toEqual([["systemctl", "--user", "restart", "hedge-slack-trigger.service"]]);
  });

  test("restarts the service when a setting of its pack changes, and not when another pack's setting changes", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    const withSettings = (settings: Plan["settings"]) => ({ ...plan("linux", [trigger]), settings });
    await apply(withSettings({ "base.emoji": "t3code", "other.size": 1 }), { home, adapters: [linux.adapter] });
    const before = linux.calls.length;

    await apply(withSettings({ "base.emoji": "t3code", "other.size": 2 }), { home, adapters: [linux.adapter] });
    expect(changes(linux.calls.slice(before))).toEqual([]);
    await apply(withSettings({ "base.emoji": "eye", "other.size": 2 }), { home, adapters: [linux.adapter] });

    expect(changes(linux.calls.slice(before))).toEqual([["systemctl", "--user", "restart", "hedge-slack-trigger.service"]]);
  });

  test("starts a service that stopped, and enables one that was disabled", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    linux.units.set("hedge-slack-trigger.service", { active: false, enabled: false });
    const before = linux.calls.length;

    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });

    expect(changes(linux.calls.slice(before))).toEqual([
      ["systemctl", "--user", "enable", "hedge-slack-trigger.service"],
      ["systemctl", "--user", "restart", "hedge-slack-trigger.service"],
    ]);
  });

  test("reloads and restarts a unit that systemd did not load after Hedge wrote it", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    linux.manager.stale = true;
    const before = linux.calls.length;

    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });

    expect(changes(linux.calls.slice(before))).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "restart", "hedge-slack-trigger.service"],
    ]);
  });

  test("turning the workflow off stops the service and removes its unit, launcher, and copy", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    const before = linux.calls.length;

    expect((await check(plan("linux", []), { home, adapters: [linux.adapter] })).findings).toContainEqual({ id: "job:slack-trigger", pack: "engine", say: "The slack-trigger job needs to be removed.", repair: "apply" });
    const report = await apply(plan("linux", []), { home, adapters: [linux.adapter] });

    expect(changes(linux.calls.slice(before))).toEqual([
      ["systemctl", "--user", "disable", "--now", "hedge-slack-trigger.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(existsSync(unitPath(home))).toBe(false);
    expect(readdirSync(join(home, ".local/state/hedge/jobs")).filter((name) => name.startsWith("slack-trigger.") && name !== "slack-trigger.log")).toEqual([]);
    expect(report.actions).toContainEqual({ target: ".config/systemd/user/hedge-slack-trigger.service", operation: "remove" });
  });

  test("keeps the unit when systemd does not stop it", async () => {
    const home = temp.make("home-");
    await apply(plan("linux", [trigger]), { home, adapters: [systemd().adapter] });

    const report = await apply(plan("linux", []), { home, adapters: [systemd({ refuse: "disable" }).adapter] });

    expect(existsSync(unitPath(home))).toBe(true);
    expect(report.findings).toContainEqual({ id: "job:slack-trigger", pack: "engine", say: "systemd did not stop the slack-trigger job (Failed to disable), so Hedge left its unit as it is.", repair: "apply" });
  });

  test("leaves an unmanaged unit with the same name alone", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    writeFileSync(unitPath(home), "[Service]\nExecStart=/opt/mine\n");
    const linux = systemd();

    const report = await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });

    expect(readFileSync(unitPath(home), "utf8")).toBe("[Service]\nExecStart=/opt/mine\n");
    expect(changes(linux.calls)).toEqual([]);
    expect(report.findings).toContainEqual({ id: "job:slack-trigger", pack: "base", say: "Left .config/systemd/user/hedge-slack-trigger.service alone: Hedge did not write it, or it changed since. Move it away, then run hedge apply.", repair: "human" });

    await apply(plan("linux", []), { home, adapters: [linux.adapter] });
    expect(readFileSync(unitPath(home), "utf8")).toBe("[Service]\nExecStart=/opt/mine\n");
    expect(changes(linux.calls)).toEqual([]);
  });

  test("leaves a unit alone once someone edits the one Hedge wrote, also when its job goes", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    writeFileSync(unitPath(home), readFileSync(unitPath(home), "utf8") + "Nice=5\n");
    const before = linux.calls.length;

    const kept = await apply(plan("linux", []), { home, adapters: [linux.adapter] });

    expect(readFileSync(unitPath(home), "utf8")).toEndWith("Nice=5\n");
    expect(changes(linux.calls.slice(before))).toEqual([]);
    expect(kept.findings.map((finding) => finding.id)).toContain("job:slack-trigger");
  });

  test("reports a systemd user manager that does not answer, and writes nothing", async () => {
    const home = temp.make("home-");
    const report = await apply(plan("linux", [trigger]), { home, adapters: [systemd({ manager: false }).adapter] });
    expect(existsSync(unitPath(home))).toBe(false);
    expect(report.findings).toContainEqual({ id: "jobs:systemd", pack: "engine", say: "Could not reach systemd's user manager (Failed to connect to bus), so services were not changed. Log in to this machine in a normal session, then run hedge apply.", repair: "human" });
  });

  test("doctor reports a missing service without writing", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    const report = await check(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    expect(report.findings).toContainEqual({ id: "job:slack-trigger", pack: "base", say: "The slack-trigger job needs to be added.", repair: "apply" });
    expect(changes(linux.calls)).toEqual([]);
    expect(existsSync(unitPath(home))).toBe(false);
  });

  test("keeps a service while a pack source cannot be fetched", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    const offline = { ...plan("linux", []), packs: [{ name: "base", source: "engine", ref: "main", available: true }, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    const before = linux.calls.length;
    await apply(offline, { home, adapters: [linux.adapter] });
    expect(existsSync(unitPath(home))).toBe(true);
    expect(changes(linux.calls.slice(before))).toEqual([]);
  });

  test("keeps a service that leaves the plan only because a source cannot be fetched", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    await apply(outageDropping("linux", "slack-trigger", outageHides), { home, adapters: [linux.adapter] });
    expect([existsSync(unitPath(home)), linux.units.get("hedge-slack-trigger.service")]).toEqual([true, { active: true, enabled: true }]);
  });

  test("quotes a home that systemd would expand", async () => {
    const home = temp.make("home-50% $USER \"q\" \\-");
    await apply(plan("linux", [trigger]), { home, adapters: [systemd().adapter] });
    const quoted = `${home}/.local/state/hedge/jobs/slack-trigger.sh`.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$");
    expect(readFileSync(unitPath(home), "utf8")).toContain(`ExecStart=/bin/sh "${quoted}"\n`);
  });

  test("runs a scheduled job and a service side by side, and moves a job between them", async () => {
    const home = temp.make("home-");
    const linux = systemd();
    const scheduled: PackJob = { id: "slack-trigger", command: trigger.command, schedule: { every: "5m" } };

    await apply(plan("linux", [scheduled, prune]), { home, adapters: [linux.adapter] });
    expect(linux.cron.text).toContain("# hedge:slack-trigger");

    await apply(plan("linux", [trigger, prune]), { home, adapters: [linux.adapter] });
    expect(linux.cron.text).not.toContain("# hedge:slack-trigger");
    expect(linux.cron.text).toContain("# hedge:prune");
    expect(existsSync(unitPath(home))).toBe(true);
    expect(existsSync(join(home, ".local/state/hedge/jobs/slack-trigger.sh"))).toBe(true);
    expect(linux.units.get("hedge-slack-trigger.service")).toEqual({ active: true, enabled: true });
  });

  test("restarts on a later apply when a restart for a new command failed while the old process kept running", async () => {
    const home = temp.make("home-");
    const options: { refuse?: string } = {};
    const linux = systemd(options);
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    const changed = { ...trigger, command: ["hedge", "slack-trigger", "run", "--verbose"] };
    options.refuse = "restart";
    const failed = await apply(plan("linux", [changed]), { home, adapters: [linux.adapter] });
    expect(failed.findings.map((finding) => finding.say)).toContain("systemd did not start the slack-trigger job (Failed to restart).");
    expect(linux.units.get("hedge-slack-trigger.service")).toEqual({ active: true, enabled: true });
    options.refuse = undefined;
    expect((await check(plan("linux", [changed]), { home, adapters: [linux.adapter] })).ok).toBe(false);
    const before = linux.calls.length;

    await apply(plan("linux", [changed]), { home, adapters: [linux.adapter] });

    expect(changes(linux.calls.slice(before))).toEqual([["systemctl", "--user", "restart", "hedge-slack-trigger.service"]]);
    const after = linux.calls.length;
    await apply(plan("linux", [changed]), { home, adapters: [linux.adapter] });
    expect(changes(linux.calls.slice(after))).toEqual([]);
  });

  test("keeps the cron line of a job that becomes a service until systemd runs it", async () => {
    const home = temp.make("home-");
    const options: { manager?: boolean } = {};
    const linux = systemd(options);
    const scheduled: PackJob = { id: "slack-trigger", command: trigger.command, schedule: { every: "5m" } };
    await apply(plan("linux", [scheduled]), { home, adapters: [linux.adapter] });
    options.manager = false;

    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    expect(linux.cron.text).toContain("# hedge:slack-trigger");
    expect(existsSync(join(home, ".local/state/hedge/jobs/slack-trigger.sh"))).toBe(true);

    options.manager = true;
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    expect(linux.cron.text).not.toContain("# hedge:slack-trigger");
    expect(linux.units.get("hedge-slack-trigger.service")).toEqual({ active: true, enabled: true });
  });

  test("keeps the service of a job that becomes scheduled until its cron line is written", async () => {
    const home = temp.make("home-");
    const options: { crontab?: boolean } = {};
    const linux = systemd(options);
    const scheduled: PackJob = { id: "slack-trigger", command: trigger.command, schedule: { every: "5m" } };
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    options.crontab = false;

    await apply(plan("linux", [scheduled]), { home, adapters: [linux.adapter] });
    expect(existsSync(unitPath(home))).toBe(true);
    expect(linux.units.get("hedge-slack-trigger.service")).toEqual({ active: true, enabled: true });

    options.crontab = true;
    await apply(plan("linux", [scheduled]), { home, adapters: [linux.adapter] });
    expect(linux.cron.text).toContain("# hedge:slack-trigger");
    expect(existsSync(unitPath(home))).toBe(false);
    expect(linux.units.get("hedge-slack-trigger.service")).toEqual({ active: false, enabled: false });
    expect(existsSync(join(home, ".local/state/hedge/jobs/slack-trigger.sh"))).toBe(true);
  });

  test("stops a service whose unit file was deleted while it ran, and keeps its copy when it does not stop", async () => {
    const home = temp.make("home-");
    const options: { refuse?: string } = {};
    const linux = systemd(options);
    await apply(plan("linux", [trigger]), { home, adapters: [linux.adapter] });
    rmSync(unitPath(home));
    const copy = join(home, ".local/state/hedge/jobs/slack-trigger.service");

    options.refuse = "stop";
    const kept = await apply(plan("linux", []), { home, adapters: [linux.adapter] });
    expect(kept.findings.map((finding) => finding.say)).toContain("systemd did not stop the slack-trigger job (Failed to stop), so Hedge left its unit as it is.");
    expect(existsSync(copy)).toBe(true);

    options.refuse = undefined;
    const before = linux.calls.length;
    await apply(plan("linux", []), { home, adapters: [linux.adapter] });
    expect(changes(linux.calls.slice(before))).toEqual([["systemctl", "--user", "stop", "hedge-slack-trigger.service"]]);
    expect(linux.units.get("hedge-slack-trigger.service")?.active).toBe(false);
    expect(existsSync(copy)).toBe(false);
  });

  test("never lists or deletes through a jobs folder that is a link", async () => {
    const home = temp.make("home-");
    const elsewhere = temp.make("elsewhere-");
    writeFileSync(join(elsewhere, "unrelated.service"), "mine\n");
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    symlinkSync(elsewhere, join(home, ".local/state/hedge/jobs"));
    const linux = systemd();

    await apply(plan("linux", []), { home, adapters: [linux.adapter] });

    expect(readFileSync(join(elsewhere, "unrelated.service"), "utf8")).toBe("mine\n");
    expect(changes(linux.calls)).toEqual([]);
  });

  test("on a Mac, a service is a launchd agent that runs at load and is kept alive, and a new command reloads it", async () => {
    const home = temp.make("home-");
    const calls: string[][] = [];
    const loaded = new Set<string>();
    const run: CommandRunner = async (command) => {
      calls.push(command);
      const [, verb, target] = command;
      if (verb === "print") return { code: loaded.has(target!) ? 0 : 113, stdout: "" };
      if (verb === "bootstrap") loaded.add(`gui/501/${command[3]!.split("/").at(-1)!.replace(/\.plist$/, "")}`);
      if (verb === "bootout") loaded.delete(target!);
      return { code: 0, stdout: "" };
    };
    const mac = jobsAdapter({ run, engineRoot: engine, uid: 501 });

    await apply(plan("darwin", [trigger]), { home, adapters: [mac] });

    const text = readFileSync(join(home, "Library/LaunchAgents/dev.hedge.slack-trigger.plist"), "utf8");
    expect(text).toContain("  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n");
    expect(text).not.toContain("StartInterval");
    expect(text).not.toContain("StartCalendarInterval");
    expect(loaded.has("gui/501/dev.hedge.slack-trigger")).toBe(true);

    const before = calls.length;
    await apply(plan("darwin", [trigger]), { home, adapters: [mac] });
    expect(calls.slice(before).filter((call) => call[1] !== "print")).toEqual([]);

    await apply(plan("darwin", [{ ...trigger, command: ["hedge", "slack-trigger", "run", "--verbose"] }]), { home, adapters: [mac] });
    expect(calls.slice(before).filter((call) => call[1] !== "print").map((call) => call[1])).toEqual(["bootout", "bootstrap"]);
    expect(readFileSync(join(home, ".local/state/hedge/jobs/slack-trigger.sh"), "utf8")).toContain("'--verbose'");
  });
});
