import { describe, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./testing/git.ts";
import { getShHarness, onLinuxHost } from "./testing/get-sh.ts";
import { emptySchedulers, type SchedulerState } from "./testing/scheduler-cli.ts";
import { deliver, eventLogPath, putValue, valuesDir } from "../packs/hub/lib/secret-store.ts";

const { sandbox, profile, engine, getSh, temp } = getShHarness();

const oldCron = "0 3 * * * /bin/sh '/old/nightly.sh' # fleet:nightly\n*/5 * * * * my-own-job\n";
const running = { active: true, enabled: true };
const off = { active: false, enabled: false };

function engineWithWatcher(change?: (repo: string) => void) {
  const repo = temp.make("engine-watcher-");
  git(repo, "clone", "-q", engine.repo, ".");
  mkdirSync(join(repo, "packs/watcher"), { recursive: true });
  writeFileSync(join(repo, "packs/watcher/pack.json"), JSON.stringify({ schema: 1, name: "watcher", summary: "Watches.", jobs: [{ id: "watch", command: ["true"], schedule: { every: "always" } }] }));
  change?.(repo);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "watcher pack");
  return repo;
}

const fleetWrapper = (engine: string) => `#!/bin/sh\n# Fleet\nexec sh '${engine.replaceAll("'", "'\\''")}/fleet' "$@"\n`;
const tree = (home: string) => readdirSync(home, { recursive: true, withFileTypes: true }).map((entry) => `${join(entry.parentPath, entry.name)} ${entry.isFile() ? readFileSync(join(entry.parentPath, entry.name), "utf8") : entry.isSymbolicLink() ? "link" : "dir"}`).sort();

type Upgrade = { failing?: string[]; stuck?: string[]; lastWords?: (home: string) => SchedulerState["lastWords"]; engine?: (repo: string) => void; oldEngine?: string; wrapper?: (engine: string) => string };

function fleetMachine({ failing = [], stuck, lastWords, engine: change, oldEngine: folder = ".local/share/fleet/engine", wrapper = fleetWrapper }: Upgrade = {}) {
  const box = sandbox("Linux");
  const home = box.home;
  const repo = profile();
  const answers = JSON.parse(readFileSync(join(repo, "hedge.json"), "utf8"));
  writeFileSync(join(repo, "hedge.json"), JSON.stringify({ ...answers, packs: ["watcher"] }));
  renameSync(join(repo, "hedge.json"), join(repo, "fleet.json"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "profile");
  const oldProfile = join(home, ".local/share/fleet/profile");
  git(home, "clone", "-q", repo, oldProfile);
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "devbox", profileDir: oldProfile }));
  const oldEngine = join(home, folder);
  mkdirSync(oldEngine, { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/fleet"), wrapper(oldEngine), { mode: 0o755 });
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(join(home, ".config/systemd/user/fleet-watch.service"), "[Unit]\nDescription=Fleet: watch\n");
  const stateFile = join(box.root, "schedulers.json");
  const write = (state: SchedulerState) => writeFileSync(stateFile, JSON.stringify(state));
  write({ ...emptySchedulers(), units: { "fleet-watch.service": running }, failing, crontab: oldCron, ...(stuck && { stuck }), ...(lastWords && { lastWords: lastWords(home) }) });
  for (const tool of ["systemctl", "crontab"]) box.stub(tool, `exec "${process.execPath}" "${join(import.meta.dir, "testing/scheduler-cli.ts")}" "${stateFile}" ${tool} "$@"`);
  const state = () => JSON.parse(readFileSync(stateFile, "utf8")) as SchedulerState;
  const engineRepo = engineWithWatcher(change);
  const getShWith = (args: string[]) => getSh(box, ["--ref", "main", ...args], { env: { HEDGE_ENGINE_REPO: engineRepo, HEDGE_ACCOUNT_HOME: home } });
  return { home, repo, state, getSh: getShWith, startsAgain: () => write({ ...state(), failing: [], stuck: [] }) };
}

describe("get.sh upgrades a machine that Fleet runs", () => {
  onLinuxHost("stops Fleet's service and its cron job, keeps the user's cron job, starts the Hedge service, and never runs both", () => {
    const machine = fleetMachine();

    const result = machine.getSh([]);

    expect(result.code).toBe(0);
    const state = machine.state();
    expect([state.units["fleet-watch.service"], state.units["hedge-watch.service"]]).toEqual([off, running]);
    expect(state.crontab).toContain("*/5 * * * * my-own-job\n");
    expect(state.crontab).not.toContain("# fleet:");
    expect(state.both).toEqual([]);
  });

  onLinuxHost("stops before it changes anything when the fleet command runs a Fleet engine in a custom folder while Fleet's service runs, in a preview too", () => {
    const machine = fleetMachine({ oldEngine: "src/fleet-engine" });
    const before = tree(machine.home);

    const preview = machine.getSh(["--", "--dry-run"]);
    const result = machine.getSh([]);

    expect(preview.code).toBe(1);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`Hedge: ${machine.home}/.local/bin/fleet runs a Fleet engine in ${machine.home}/src/fleet-engine, and Hedge finds and stops only the Fleet engine in ${machine.home}/.local/share/fleet/engine, so Hedge changed nothing.`);
    expect(result.output).toContain("Then run get.sh again.");
    expect(tree(machine.home)).toEqual(before);
    const state = machine.state();
    expect(state.units).toEqual({ "fleet-watch.service": running });
    expect(state.crontab).toBe(oldCron);
  });

  onLinuxHost("stops before it changes anything when the default Fleet engine folder links to a custom checkout, and names the link and where it points", () => {
    const machine = fleetMachine({ oldEngine: "src/fleet-engine" });
    const checkout = join(machine.home, "src/other-engine");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "fleet"), "");
    writeFileSync(join(checkout, "hedge"), "");
    const link = join(machine.home, ".local/share/fleet/engine");
    symlinkSync(checkout, link);
    const before = tree(machine.home);

    const result = machine.getSh([]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`Hedge: ${link} is a link to ${checkout}, and Hedge finds and stops only a Fleet engine that sits in ${link} itself, so Hedge changed nothing.`);
    expect(result.output).toContain(`delete the link ${link}, or move the engine to ${link} in place of the link. Then run get.sh again.`);
    expect(tree(machine.home)).toEqual(before);
    expect(machine.state().units).toEqual({ "fleet-watch.service": running });
  });

  onLinuxHost("stops before it changes anything when the fleet command names a Fleet engine folder with an escaped apostrophe", () => {
    const machine = fleetMachine({ oldEngine: "src/it's fleet" });
    const before = tree(machine.home);

    const result = machine.getSh([]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`Hedge: ${machine.home}/.local/bin/fleet runs a Fleet engine in ${machine.home}/src/it's fleet, and Hedge finds and stops only`);
    expect(tree(machine.home)).toEqual(before);
    expect(machine.state().units).toEqual({ "fleet-watch.service": running });
  });

  onLinuxHost("ignores a fleet command without the installer's # Fleet line, even when it names another folder, and moves the Fleet engine install", () => {
    const unmarked = "#!/bin/sh\nexec sh '/opt/other/fleet' \"$@\"\n";
    const machine = fleetMachine({ wrapper: () => unmarked });

    const result = machine.getSh([]);

    expect(result.code).toBe(0);
    const state = machine.state();
    expect([state.units["fleet-watch.service"], state.units["hedge-watch.service"]]).toEqual([off, running]);
    expect(readFileSync(join(machine.home, ".local/bin/fleet"), "utf8")).toBe(unmarked);
  });

  onLinuxHost("exits 1 when the Hedge service does not start, keeps Fleet's off, and an identical retry applies again", () => {
    const machine = fleetMachine({ failing: ["hedge-watch.service"] });

    const first = machine.getSh([]);
    const afterFirst = machine.state();
    machine.startsAgain();
    const retry = machine.getSh([]);

    expect(first.code).toBe(1);
    expect(first.output).toContain("systemd did not start the watch job");
    expect([afterFirst.units["fleet-watch.service"], afterFirst.units["hedge-watch.service"]?.active]).toEqual([off, false]);
    expect(retry.code).toBe(0);
    expect(machine.state().units["hedge-watch.service"]).toEqual(running);
    expect(machine.state().both).toEqual([]);
  });

  onLinuxHost("a dry run copies nothing and stops nothing, and names what still runs", () => {
    const machine = fleetMachine();

    const result = machine.getSh(["--profile", machine.repo, "--", "--dry-run"]);

    expect(result.output).toContain("The systemd unit fleet-watch.service from before the rename still runs (it is active)");
    expect(result.output).toContain("The cron job nightly from before the rename still runs");
    expect(machine.state()).toEqual({ ...emptySchedulers(), units: { "fleet-watch.service": running }, crontab: oldCron });
    expect(existsSync(join(machine.home, ".config/hedge/machine.json"))).toBe(false);
  });

  onLinuxHost("a dry run with --profile at the Fleet profile names what still runs before the apply preview refuses that profile", () => {
    const machine = fleetMachine();
    const oldProfile = join(machine.home, ".local/share/fleet/profile");

    const result = machine.getSh(["--profile", oldProfile, "--", "--dry-run"]);

    const listed = result.output.indexOf("Hedge: The systemd unit fleet-watch.service from before the rename still runs (it is active)");
    const refused = result.output.indexOf(`${oldProfile} is in a Fleet path from before the rename, so Hedge does not use it.`);
    expect(result.code).toBe(1);
    expect(listed).toBeGreaterThanOrEqual(0);
    expect(result.output).toContain("The cron job nightly from before the rename still runs");
    expect(refused).toBeGreaterThan(listed);
    expect(machine.state()).toEqual({ ...emptySchedulers(), units: { "fleet-watch.service": running }, crontab: oldCron });
  });

  onLinuxHost("a dry run without --profile names what still runs, runs no setup, and changes nothing", () => {
    const machine = fleetMachine();

    const result = machine.getSh(["--", "--dry-run"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("Hedge: The systemd unit fleet-watch.service from before the rename still runs (it is active)");
    expect(result.output).toContain("The cron job nightly from before the rename still runs");
    expect(result.output).toContain("A preview without --profile runs no setup.");
    expect(result.output).not.toContain("unknown option");
    expect(machine.state()).toEqual({ ...emptySchedulers(), units: { "fleet-watch.service": running }, crontab: oldCron });
    expect(existsSync(join(machine.home, ".config/hedge"))).toBe(false);
  });
  onLinuxHost("when a Fleet unit does not stop, exits 1 before it copies or starts anything, and a retry once it stops copies and applies", () => {
    const machine = fleetMachine({ stuck: ["fleet-watch.service"] });

    const first = machine.getSh([]);
    const afterFirst = machine.state();
    const copied = existsSync(join(machine.home, ".config/hedge"));
    machine.startsAgain();
    const retry = machine.getSh([]);

    expect(first.code).toBe(1);
    expect(first.output).toContain("Hedge: Fleet may still run, so Hedge copied and applied nothing.");
    expect([afterFirst.units["fleet-watch.service"]?.active, "hedge-watch.service" in afterFirst.units]).toEqual([true, false]);
    expect(copied).toBe(false);
    expect(retry.code).toBe(0);
    expect([machine.state().units["fleet-watch.service"], machine.state().units["hedge-watch.service"]]).toEqual([off, running]);
    expect(machine.state().both).toEqual([]);
  });

  onLinuxHost("a secret that Fleet saves while it stops reaches Hedge's secret store, also when --install-only hands over to setup", async () => {
    const now = new Date("2026-11-19T12:00:00Z");
    const rows = [{ name: "early-key", env: ["EARLY_KEY"] }, { name: "late-key", env: ["LATE_KEY"] }].map((row) => ({ ...row, provider: { name: "test" }, scope: "test", settings: "" }));
    const fleets = { home: temp.make("fleet-store-"), rows, now };
    await putValue(fleets, { name: "early-key", text: "early-value-1", why: "intake", machine: "test" });
    const late = await putValue(fleets, { name: "late-key", text: "late-value-22", why: "intake", machine: "test" });
    const logged = readFileSync(eventLogPath(fleets.home), "utf8").split("\n").filter(Boolean);
    const lateLine = logged.find((line) => JSON.parse(line).id === late.id)!;
    const machine = fleetMachine({ lastWords: (home) => [{ unit: "fleet-watch.service", file: join(home, ".local/state/fleet/secrets.jsonl"), line: `${lateLine}\n` }] });
    cpSync(valuesDir(fleets.home), join(machine.home, ".config/fleet/secrets"), { recursive: true });
    mkdirSync(join(machine.home, ".local/state/fleet"), { recursive: true });
    writeFileSync(join(machine.home, ".local/state/fleet/secrets.jsonl"), logged.filter((line) => line !== lateLine).map((line) => `${line}\n`).join(""), { mode: 0o600 });

    const result = machine.getSh(["--install-only"]);

    expect(result.code).toBe(0);
    expect(deliver({ home: machine.home, rows, now }, { names: ["early-key", "late-key"], machine: "test" })).toEqual([
      { name: "early-key", values: { EARLY_KEY: "early-value-1" } },
      { name: "late-key", values: { LATE_KEY: "late-value-22" } },
    ]);
  });

  onLinuxHost("a dry run on an engine whose retire-fleet ignores --dry-run stops nothing and says it cannot name what still runs", () => {
    const machine = fleetMachine({
      engine: (repo) => {
        const cli = join(repo, "src/cli.ts");
        const source = readFileSync(cli, "utf8");
        const ignoring = source.replace(/  if \(args\.length > 1 \|\| [^\n]*\n/, "").replace("  if (args.length) return listFleet(fleet, options);\n", "");
        expect(ignoring).not.toBe(source);
        writeFileSync(cli, ignoring);
      },
    });

    const result = machine.getSh(["--", "--dry-run"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("so this preview does not name what still runs.");
    expect(machine.state()).toEqual({ ...emptySchedulers(), units: { "fleet-watch.service": running }, crontab: oldCron });
  });
});
