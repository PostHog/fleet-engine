import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freeBytes, freeInodeShare, freeMapFile, inodeFloorShare, shownInodes, type Space } from "../../base/lib/disk.ts";
import { numberSetting, stringSetting } from "../../base/lib/settings.ts";
import type { Env } from "./coder.ts";
import { threadModel, requireHubRole, spawnText, sshArgv, stateDir, threadScript, underLock, writeStateFile, type JobContext } from "./hub-job.ts";
import { devboxesOf, quote, remoteFleet } from "./machine.ts";

const gigabyte = 1024 ** 3;
const hour = 3600_000;
const sweepEveryHours = 1;
const repeatHours = 24;
const reportLines = 40;
const alertModel = "claude-haiku-5-5";
const sweepMinutes = 90;
const sweepBelowInodes = inodeFloorShare;
const alertBelowInodes = 0.05;

export type DiskWatchOptions = {
  boxes: string[]; statePath: string; now: () => number; log: (line: string) => void; dryRun?: boolean;
  sweepBelowGigabytes: number; alertBelowGigabytes: number;
  read: (box: string) => Promise<Space | null>;
  hostOf?: (box: string) => string | undefined;
  sweep: (box: string) => Promise<string>;
  alert: (box: string, free: Space, report: string) => Promise<boolean>;
};

type WatchState = Record<string, { sweptAt?: number; alertedAt?: number }>;

export async function watchDisks(options: DiskWatchOptions): Promise<void> {
  const state = readState(options.statePath);
  const save = () => { if (!options.dryRun) writeStateFile(options.statePath, state); };
  const boxes: Record<string, Space> = {};
  const checkedAt = new Date(options.now()).toISOString();
  const read = async (box: string) => {
    const free = await options.read(box);
    if (free !== null) boxes[box] = free;
    return free;
  };
  const passes = await Promise.allSettled(options.boxes.map((box) => watchDisk(box, state, { ...options, read }, save)));
  save();
  const answered = Object.keys(boxes).sort();
  const hosts = Object.fromEntries(answered.flatMap((box) => { const host = options.hostOf?.(box); return host ? [[box, host]] : []; }));
  if (!options.dryRun) writeStateFile(join(dirname(options.statePath), freeMapFile), { checkedAt, boxes: Object.fromEntries(answered.map((box) => [box, boxes[box]!.bytes])), hosts });
  const failed = passes.find((pass) => pass.status === "rejected");
  if (failed) throw failed.reason;
}

async function watchDisk(box: string, state: WatchState, options: DiskWatchOptions, save: () => void): Promise<void> {
  let free = await options.read(box);
  if (free === null) { options.log(`${box}: unreachable`); return; }
  const roomy = (space: Space) => space.bytes >= options.sweepBelowGigabytes * gigabyte && space.inodes >= sweepBelowInodes;
  if (roomy(free)) { recovered(box, state, save); options.log(shown(box, free)); return; }
  const entry = state[box] ??= {};
  let report = "No sweep ran in this pass. The last one ran less than an hour ago.";
  if (options.now() - (entry.sweptAt ?? 0) < sweepEveryHours * hour) options.log(`${shown(box, free)}; swept already`);
  else if (options.dryRun) options.log(`${shown(box, free)}; would sweep`);
  else {
    options.log(`${shown(box, free)}; sweeping`);
    entry.sweptAt = options.now();
    save();
    report = (await options.sweep(box)).split("\n").slice(-reportLines).join("\n");
    free = await options.read(box) ?? free;
    options.log(`${shown(box, free)} after the sweep`);
    if (roomy(free)) { recovered(box, state, save); return; }
  }
  if (free.bytes >= options.alertBelowGigabytes * gigabyte && free.inodes >= alertBelowInodes) return;
  if (options.now() - (entry.alertedAt ?? 0) < repeatHours * hour) { options.log(`${box}: alerted already`); return; }
  if (options.dryRun) { options.log(`${box}: would alert`); return; }
  entry.alertedAt = options.now();
  save();
  const alerted = await options.alert(box, free, report);
  options.log(`${box}: ${alerted ? "alerted" : "alert failed or lost its answer, so it is not tried again today"}`);
}

function recovered(box: string, state: WatchState, save: () => void): void {
  if (!state[box]) return;
  delete state[box];
  save();
}

const shown = (box: string, free: Space) => `${box}: ${(free.bytes / gigabyte).toFixed(1)}G free, ${shownInodes(free.inodes)}`;

export function parseDf(output: string): { space: Space | null; host?: string } {
  const [, usage, , inodeLine, host] = output.trim().split("\n");
  const available = Number(usage?.split(/\s+/)[3]);
  const [inodes, , free] = (inodeLine?.split(/\s+/) ?? []).slice(1, 4).map(Number);
  const space = Number.isFinite(available) && Number.isFinite(inodes) && Number.isFinite(free) ? { bytes: available * 1024, inodes: inodes! > 0 ? free! / inodes! : 1 } : null;
  return { space, host: host?.trim() || undefined };
}

function readState(path: string): WatchState {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(state).filter(([, entry]) => typeof entry === "object" && entry !== null)) as WatchState;
  } catch { return {}; }
}

export function diskWatchTargets(env: Env, home: string, hub: string, self: string): { local: string; remote: string[] } {
  return { local: hub, remote: devboxesOf(env, home).filter((box) => box !== hub && box !== self) };
}

export type DiskWatchContext = JobContext & { localFree?: () => number; localInodes?: () => number };

function hubDisks(context: DiskWatchContext, local: string, sweepBelowGigabytes: number, alertBelowGigabytes: number) {
  const { env } = context;
  const onBox = (box: string, command: string) => (box === local ? ["sh", "-c", command] : sshArgv(box, command));
  const inLoginShell = (command: string) => `bash -lc ${quote(command)}`;
  const localFleet = join(env.FLEET_ENGINE_DIR ?? join(context.home, ".local/share/fleet/engine"), "fleet");
  const hosts = new Map([[local, context.self]]);
  const read = async (box: string) => {
    if (box === local) return { bytes: (context.localFree ?? (() => freeBytes(context.home)))(), inodes: (context.localInodes ?? (() => freeInodeShare(context.home)))() };
    const df = await spawnText(sshArgv(box, 'df -Pk "$HOME" && df -Pi "$HOME" && hostname'), env, { timeoutMs: 30_000 });
    const { space, host } = parseDf(df.stdout);
    if (host) hosts.set(box, host);
    return df.code === 0 ? space : null;
  };
  const sweep = async (box: string) => {
    const floors = ["--floor", String(sweepBelowGigabytes), "--alert-floor", String(alertBelowGigabytes)];
    const argv = box === local ? ["sh", localFleet, "disk-sweep", ...floors] : sshArgv(box, `${inLoginShell(remoteFleet(["disk-sweep", ...floors].join(" ")))} 2>&1`);
    const swept = await spawnText(argv, env, { timeoutMs: sweepMinutes * 60_000 });
    const output = `${swept.stdout}${swept.stderr}`.trim();
    return swept.code === 0 ? output : `The sweep failed with exit ${swept.code === 124 ? "timeout" : swept.code}.\n${output}`;
  };
  const alert = async (box: string, free: Space, report: string) => {
    const shownFree = `${(free.bytes / gigabyte).toFixed(1)}G free, ${shownInodes(free.inodes)}`;
    const look = `df -h ~; df -i ~; ${remoteFleet("prune --dry-run --no-fetch --min-idle-hours 1")}`;
    const prompt = `${box} has ${shownFree}, below ${alertBelowGigabytes}G or ${alertBelowInodes * 100}% of inodes, though a cleanup sweep ran within the hour. A full disk crashes T3 and every lane on the box, and without inodes every new file fails with ENOSPC.
The sweep ran fleet prune, trimmed the T3 boot log, and ran the pnpm, uv and Go cache cleaners. It removed nothing else. Its report from this pass ends with the largest folders under $HOME:

${report}

Check what is left, read-only: run \`${box === local ? look : `ssh ${box} ${quote(inLoginShell(look))}`}\`.
Delete nothing and start no lanes. Reply in at most 10 lines: the free space, the largest folders the report names, and what your user must decide to free it.`;
    const script = threadScript(stringSetting("hub.threadFolder", env), `${box}: ${shownFree}`, threadModel("lookup", alertModel, env));
    return (await spawnText(onBox(local, script), env, { stdin: prompt, timeoutMs: 600_000 })).code === 0;
  };
  return { read, sweep, alert, sweepBelowGigabytes, hostOf: (box: string) => hosts.get(box) };
}

export async function diskWatchCommand(args: string[], context: DiskWatchContext): Promise<number> {
  const dryRun = args[0] === "--dry-run";
  if (args.length > Number(dryRun)) throw new Error("Usage: fleet disk-watch [--dry-run]");
  requireHubRole(context.home, "disk-watch");
  const { env } = context;
  const targets = diskWatchTargets(env, context.home, stringSetting("hub.alias", env), context.self);
  const sweepBelowGigabytes = numberSetting("hub.diskSweepGigabytes", env);
  const alertBelowGigabytes = numberSetting("hub.diskAlertGigabytes", env);
  return underLock(context, "disk-watch", "The disk watch", async () => {
    await watchDisks({
      boxes: [targets.local, ...targets.remote], statePath: join(stateDir(context.home, env), "disk-watch.json"), now: context.now, log: context.log, dryRun,
      alertBelowGigabytes, ...hubDisks(context, targets.local, sweepBelowGigabytes, alertBelowGigabytes),
    });
    return 0;
  });
}
