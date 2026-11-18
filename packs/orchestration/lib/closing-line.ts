import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { matchThread, type ShellThread, t3StatePath, t3UserData } from "../../base/lib/t3/index.ts";
import { readHandovers, unhandedLinks } from "../../pull-requests/lib/pr-owners.ts";
import { closingLine, closingPark, closingSettings, killSwitch, type Marks } from "./closing-marks.ts";
import { nestedSession, type ProcessTable } from "./proof-stop.ts";
import { personName } from "./prose-question.ts";

export type ParkT3 = { shell: () => Promise<{ threads: ShellThread[] }>; dispatch: (command: Record<string, unknown>) => Promise<unknown> };
export type ParkEvent = { stop_hook_active?: boolean; last_assistant_message?: string };
export type ParkOptions = {
  home: string; threadId?: string; t3: ParkT3; processes: ProcessTable;
  settleAfterRun: (threadId: string, runId: string, since: Date) => void; now?: () => Date; stoppedAt?: Date; deadline?: () => Promise<void>;
};
export type ParkBlock = { decision: "block"; reason: string };

export const parkDeadlineMs = 4_000;

const dayMs = 24 * 60 * 60 * 1000;
const furthestSnoozeMs = 180 * dayMs;
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const unsuccessful = ["failed", "interrupted", "cancelled", "rolled_back"];

function offsetMs(at: number, zone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
  const [, sign, hours, minutes] = /GMT([+-])(\d\d):(\d\d)/.exec(name ?? "") ?? [];
  return sign ? (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000 : 0;
}

const zonedTime = (wall: number, zone: string) => wall - offsetMs(wall - offsetMs(wall, zone), zone);

const wallClock = (at: number, zone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(at).filter((part) => part.type !== "literal").map((part) => Number(part.value)).join(" ");

export function snoozeTime(line: string, now: Date, zone: string): Date | undefined {
  const [, day, monthName, hour, minute] = /\b(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{1,2}):(\d\d)\b/.exec(line) ?? [];
  const month = months.indexOf(monthName?.toLowerCase() ?? "");
  if (month < 0 || Number(hour) > 23 || Number(minute) > 59) return undefined;
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(now));
  const named = [Number(day), month + 1, Number(hour), Number(minute)].join(" ");
  const at = [year, year + 1].map((candidate) => zonedTime(Date.UTC(candidate, month, Number(day), Number(hour), Number(minute)), zone))
    .find((candidate) => candidate > now.getTime() && wallClock(candidate, zone) === named);
  return at === undefined || at - now.getTime() > furthestSnoozeMs ? undefined : new Date(at);
}

function hasScheduledCheck(home: string, threadId: string, now: Date): boolean {
  const db = new Database(t3StatePath(t3UserData(home)), { readonly: true });
  try {
    return db.query<{ next: string }, [string]>("select next_run_at next from scheduled_tasks where thread_id = ? and enabled = 1 and next_run_at is not null").all(threadId)
      .some(({ next }) => Date.parse(next) > now.getTime());
  } finally {
    db.close();
  }
}

export const noCheckReason = (marks: Marks) => "Hedge blocked this stop: your closing line says this thread settles until its check, but no check is scheduled: "
  + "no enabled scheduled task bound to this thread has a next run. Schedule it with schedule_task bound to this thread, then end the turn again. "
  + `If the thread waits on someone else instead, end on a line that starts with ${marks.wait}.`;

export const snoozeTimeReason = (zone: string) => "Hedge blocked this stop: your closing line says this thread snoozes, but it is not snoozed, "
  + `and Hedge read no future time in ${zone}, such as "14th Nov 22:00", from the line. `
  + "Snooze it with t3_thread_organize (action snooze, snoozedUntil the wake time in ISO form), then end the turn again.";

export const ownsOpenReason = (urls: string[], person: string, marks: Marks) => `Hedge blocked this stop: your closing line settles this thread, or asks ${person} to, `
  + `but it owns open PR(s) ${urls.join(", ")}, and no other open thread links them. A settled thread drops out of ${person}'s view, and its PRs lose their owner. `
  + `If ${person} parked them, end on ${marks.snooze} with the park date. If they wait on someone else, end on ${marks.wait}. `
  + "Or hand each over first: the thread that takes it over links it with link_pull_request, and "
  + "`hedge pr handover --pr <PR URL> --to <thread id>` counts only while the thread it names stays open and links the PR. Or close or merge the PR.";

const isSnoozed = (thread: ShellThread, now: Date) => Boolean(thread.snoozedUntil && Date.parse(thread.snoozedUntil) > now.getTime());

const snoozeCommand = (threadId: string, until: Date) =>
  ({ type: "thread.snooze", commandId: `hedge:closing-line:${crypto.randomUUID()}`, threadId, snoozedUntil: until.toISOString() });

const ownedHere = async (home: string, threads: ShellThread[], id: string) => unhandedLinks(threads, id, await readHandovers(home));

async function check(event: ParkEvent, options: ParkOptions, live: () => boolean): Promise<ParkBlock | undefined> {
  const { home, threadId } = options;
  if (!threadId) return undefined;
  const { marks, parking } = closingSettings(home);
  const message = event.last_assistant_message ?? "";
  const park = closingPark(message, marks);
  if (!parking || !park) return undefined;
  const block = (reason: string): ParkBlock | undefined => (event.stop_hook_active ? undefined : { decision: "block", reason });
  const dispatch = async (command: Record<string, unknown>) => { if (live()) await options.t3.dispatch(command); };
  if (nestedSession(await options.processes.table(), options.processes.pid)) return undefined;
  const { threads } = await options.t3.shell();
  const now = options.now?.() ?? new Date();
  const thread = matchThread(threads, threadId, (item) => item.id);
  if (!thread || thread.lineage?.parentThreadId || thread.delegatedFrom || thread.pendingRuntimeRequest || thread.settledAt) return undefined;
  if (isSnoozed(thread, now) || (thread.pinnedAt && park !== "snooze")) return undefined;
  if (park === "done" || park === "check") {
    const owned = await ownedHere(home, threads, thread.id);
    if (owned.length) return block(ownsOpenReason(owned, personName(home), marks));
  }
  if (park === "wait") await dispatch(snoozeCommand(thread.id, new Date(now.getTime() + parking.waitSnoozeDays * dayMs)));
  if (park === "snooze") {
    const until = snoozeTime(closingLine(message), now, parking.timeZone);
    if (!until) return block(snoozeTimeReason(parking.timeZone));
    await dispatch(snoozeCommand(thread.id, until));
  }
  if (park === "check") {
    if (!hasScheduledCheck(home, thread.id, now)) return block(noCheckReason(marks));
    if (thread.activeRunId && live()) options.settleAfterRun(thread.id, thread.activeRunId, options.stoppedAt ?? now);
  }
  return undefined;
}

export async function parkStop(event: ParkEvent, options: ParkOptions): Promise<ParkBlock | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late = false;
  const deadline = options.deadline?.() ?? new Promise<void>((resolve) => { timer = setTimeout(resolve, parkDeadlineMs); });
  try {
    return await Promise.race([check(event, options, () => !late).catch(() => undefined), deadline.then(() => { late = true; return undefined; })]);
  } finally {
    clearTimeout(timer);
  }
}

export type ParkCheck = (threads: ShellThread[], thread: ShellThread) => boolean;

export function stillParks(home: string, now = () => new Date(), handovers = () => readHandovers(home)) {
  return async (): Promise<ParkCheck> => {
    const handedOver = await handovers();
    return (threads, thread) => Boolean(closingSettings(home).parking) && !existsSync(join(home, killSwitch))
      && hasScheduledCheck(home, thread.id, now()) && unhandedLinks(threads, thread.id, handedOver).length === 0;
  };
}

export type SettleClock = { now: () => number; sleep: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number };

export const realSettleClock: SettleClock = { now: Date.now, sleep: (ms) => Bun.sleep(ms) };

export type SettleRequest = { threadId: string; runId: string; since: Date; stillParks: () => Promise<ParkCheck> };

export async function settleWhenRunEnds(t3: ParkT3, { threadId, runId, since, stillParks: prepare }: SettleRequest, clock: SettleClock = realSettleClock): Promise<boolean> {
  const giveUp = clock.now() + (clock.timeoutMs ?? 10 * 60_000);
  let confirmed = false;
  for (;;) {
    const parks = await prepare();
    const { threads } = await t3.shell();
    const thread = threads.find((item) => item.id === threadId);
    if (!thread || thread.settledAt || thread.pinnedAt || thread.latestRunId !== runId || thread.pendingRuntimeRequest || unsuccessful.includes(thread.status)) return false;
    if (thread.snoozedUntil && Date.parse(thread.snoozedUntil) > since.getTime()) return false;
    if (thread.pullRequests?.some(({ watch }) => watch?.startedAt && Date.parse(watch.startedAt) >= since.getTime())) return false;
    if (clock.now() > giveUp) return false;
    const ended = thread.activeRunId !== runId && thread.status === "completed";
    if (ended && !parks(threads, thread)) return false;
    if (ended && confirmed) {
      await t3.dispatch({ type: "thread.settle", commandId: `hedge:closing-line:settle:${runId}`, threadId, expectedLatestRunId: runId });
      return true;
    }
    confirmed = ended;
    if (!ended) await clock.sleep(clock.pollMs ?? 2_000);
  }
}
