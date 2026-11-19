import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./testing/git.ts";
import { getShHarness, onLinuxHost } from "./testing/get-sh.ts";
import { emptySchedulers, type SchedulerState } from "./testing/scheduler-cli.ts";

const { sandbox, profile, engine, getSh, temp } = getShHarness();

const oldCron = "0 3 * * * /bin/sh '/old/nightly.sh' # fleet:nightly\n*/5 * * * * my-own-job\n";
const running = { active: true, enabled: true };
const off = { active: false, enabled: false };

/** The engine with one more pack, whose watch service apply starts as hedge-watch.service. */
function engineWithWatcher() {
  const repo = temp.make("engine-watcher-");
  git(repo, "clone", "-q", engine.repo, ".");
  mkdirSync(join(repo, "packs/watcher"), { recursive: true });
  writeFileSync(join(repo, "packs/watcher/pack.json"), JSON.stringify({ schema: 1, name: "watcher", summary: "Watches.", jobs: [{ id: "watch", command: ["true"], schedule: { every: "always" } }] }));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "watcher pack");
  return repo;
}

/** A Linux account that Fleet set up: its machine file, its profile, its watch service running under systemd, and a fleet: cron job beside one of the user's own. systemctl and crontab keep their state in a file between commands. */
function fleetMachine(failing: string[] = []) {
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
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(join(home, ".config/systemd/user/fleet-watch.service"), "[Unit]\nDescription=Fleet: watch\n");
  const stateFile = join(box.root, "schedulers.json");
  const write = (state: SchedulerState) => writeFileSync(stateFile, JSON.stringify(state));
  write({ ...emptySchedulers(), units: { "fleet-watch.service": running }, failing, crontab: oldCron });
  for (const tool of ["systemctl", "crontab"]) box.stub(tool, `exec "${process.execPath}" "${join(import.meta.dir, "testing/scheduler-cli.ts")}" "${stateFile}" ${tool} "$@"`);
  const state = () => JSON.parse(readFileSync(stateFile, "utf8")) as SchedulerState;
  const engineRepo = engineWithWatcher();
  const getShWith = (args: string[]) => getSh(box, ["--ref", "main", ...args], { env: { HEDGE_ENGINE_REPO: engineRepo, HEDGE_ACCOUNT_HOME: home } });
  return { home, repo, state, getSh: getShWith, startsAgain: () => write({ ...state(), failing: [] }) };
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

  onLinuxHost("exits 1 when the Hedge service does not start, keeps Fleet's off, and an identical retry applies again", () => {
    const machine = fleetMachine(["hedge-watch.service"]);

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

    expect(result.output).toContain("Hedge: The systemd unit fleet-watch.service from before the rename still runs (it is active)");
    expect(result.output).toContain("The cron job nightly from before the rename still runs");
    expect(result.output).toContain(`${oldProfile} is in a Fleet path from before the rename, so Hedge does not use it.`);
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
});
