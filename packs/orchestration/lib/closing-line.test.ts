import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellThread } from "../../t3/lib/client/index.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import { parkStop, settleWhenRunEnds, snoozeTime, stillParks, type ParkOptions, type SettleClock } from "./closing-line.ts";
import { closingPark, closingSettings, defaultMarks } from "./closing-marks.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const threadId = "mcp:conductor-1";
const runId = "run:conductor-1:ordinal:4";
const now = new Date("2026-11-14T12:00:00.000Z");
const laneTree = ["1 0 systemd", "500 1 t3", "700 500 claude", "800 700 sh", "900 800 bun"].join("\n");
const parkingOn = { "orchestration.waitSnoozeDays": 3, "orchestration.timeZone": "Europe/Berlin", "guards.person": "Robin" };

type Command = Record<string, unknown> & { type: string };

function t3Server(fields: Partial<ShellThread> = {}) {
  const threads: ShellThread[] = [{
    id: threadId, title: "Conductor", projectId: "p", status: "running", activeRunId: runId, latestRunId: runId,
    settledAt: null, snoozedUntil: null, pendingRuntimeRequest: null, lineage: {}, ...fields,
  }];
  const received: Command[] = [];
  return {
    threads, received,
    endRun(status = "completed", next?: string) {
      Object.assign(threads[0]!, { status, activeRunId: next ?? null, latestRunId: next ?? runId });
    },
    t3: {
      shell: async () => ({ threads }),
      async dispatch(command: Record<string, unknown>) {
        const target = threads.find((item) => item.id === command.threadId)!;
        if (command.type === "thread.settle" && command.expectedLatestRunId !== target.latestRunId) throw new Error("another run");
        received.push(command as Command);
        if (command.type === "thread.snooze") target.snoozedUntil = String(command.snoozedUntil);
        if (command.type === "thread.settle") target.settledAt = now.toISOString();
      },
    },
  };
}

type Task = { thread_id: string | null; enabled: number; next_run_at: string | null };

function homeWith(tasks: Task[] = [], settings: Record<string, unknown> = parkingOn) {
  const home = temp.make("closing-line-");
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
  writeFileSync(join(home, ".local/state/hedge/settings.json"), JSON.stringify(settings));
  const db = new Database(join(home, ".t3/userdata/statev2.sqlite"));
  db.run("create table scheduled_tasks (task_id text primary key, title text not null, thread_id text, enabled integer not null, next_run_at text)");
  tasks.forEach((task, index) => db.query("insert into scheduled_tasks values (?, 'post-deploy check', ?, ?, ?)").run(`task-${index}`, task.thread_id, task.enabled, task.next_run_at));
  db.close();
  return home;
}

const checkSoon = [{ thread_id: threadId, enabled: 1, next_run_at: "2026-11-14T13:00:00.000Z" }];
const message = (closing: string) => `The lanes run; nothing needs you.\n\nTL;DR: two lanes building.\n\n${closing}\n`;

function inProcessSettle(server: ReturnType<typeof t3Server>, home: string, onPoll: (poll: number) => void = () => {}) {
  let settling: Promise<boolean> = Promise.resolve(false);
  let polls = 0;
  const clock: SettleClock = { now: () => polls * 2_000, sleep: async () => { onPoll(++polls); }, pollMs: 2_000, timeoutMs: 60_000 };
  return {
    settleAfterRun: (thread: string, run: string, since: Date) => {
      settling = settleWhenRunEnds(server.t3, { threadId: thread, runId: run, since, stillParks: stillParks(home, () => now) }, clock);
    },
    settledAt: async () => (await settling, server.threads[0]!.settledAt),
  };
}

const checkLine = "🔕 This thread **settles until its check at 15th Nov 11:35**";

async function settleWith(fields: Partial<ShellThread>, onPoll: (server: ReturnType<typeof t3Server>, poll: number, home: string) => void, tasks: Task[] = checkSoon) {
  const server = t3Server(fields);
  const home = homeWith(tasks);
  const settle = inProcessSettle(server, home, (poll) => onPoll(server, poll, home));
  const answer = await stop(checkLine, server, { home, settleAfterRun: settle.settleAfterRun });
  return { answer, server, settledAt: await settle.settledAt() };
}

async function stop(closing: string, server = t3Server(), options: Partial<ParkOptions> = {}) {
  return parkStop({ last_assistant_message: message(closing) }, {
    home: options.home ?? homeWith(), threadId, t3: server.t3, now: () => now, processes: { pid: 900, table: async () => laneTree }, settleAfterRun: () => {}, ...options,
  });
}

describe("closing-line parking", () => {
  test("a turn that closes waiting on someone else snoozes the thread for the set number of days", async () => {
    const server = t3Server();
    expect(await stop("⏳ **Waiting on** the #337 and #338 lanes", server)).toBeUndefined();
    expect(server.received).toEqual([expect.objectContaining({ type: "thread.snooze", threadId, snoozedUntil: "2026-11-17T12:00:00.000Z" })]);
    const week = t3Server();
    await stop("⏳ **Watching** the lanes", week, { home: homeWith([], { ...parkingOn, "orchestration.waitSnoozeDays": 7 }) });
    expect(week.threads[0]!.snoozedUntil).toBe("2026-11-21T12:00:00.000Z");
  });

  test("a snooze closing line snoozes the thread until its time in the set time zone", async () => {
    const winter = t3Server();
    await stop("💤 This thread **snoozes until 14th Nov 22:00**", winter);
    expect(winter.threads[0]!.snoozedUntil).toBe("2026-11-14T21:00:00.000Z");
    const summer = t3Server();
    await stop("💤 This thread **snoozes until 2nd Apr 08:30**", summer);
    expect(summer.threads[0]!.snoozedUntil).toBe("2027-04-02T06:30:00.000Z");
    const utc = t3Server();
    await stop("💤 This thread **snoozes until 14th Nov 22:00**", utc, { home: homeWith([], { ...parkingOn, "orchestration.timeZone": "UTC" }) });
    expect(utc.threads[0]!.snoozedUntil).toBe("2026-11-14T22:00:00.000Z");
  });

  test("reads a time the clock skips at the spring change, or a day that does not exist, as no time", () => {
    expect(snoozeTime("💤 until 28th Mar 02:30", now, "Europe/Berlin")).toBeUndefined();
    expect(snoozeTime("💤 until 31st Nov 09:00", now, "Europe/Berlin")).toBeUndefined();
    expect(snoozeTime("💤 until 14th Nov 11:00", now, "Europe/Berlin")).toBeUndefined();
    expect(snoozeTime("💤 until 15th Nov 9:05", now, "America/New_York")?.toISOString()).toBe("2026-11-15T14:05:00.000Z");
  });

  test("a snooze closing line without a future time Hedge can read is sent back once to snooze by hand", async () => {
    for (const closing of ["💤 This thread **snoozes until Monday morning**", "💤 This thread **snoozes until 14th Nov 11:00**"]) {
      const server = t3Server();
      const answer = await stop(closing, server);
      expect(answer?.reason).toContain("t3_thread_organize");
      expect(answer?.reason).toContain("in Europe/Berlin");
      expect(server.received).toEqual([]);
    }
  });

  test("a thread that closes on its own scheduled check settles once its run completes, and not before", async () => {
    let settledEarly: string | null | undefined;
    const { answer, server, settledAt } = await settleWith({}, (target, poll) => {
      if (poll === 1) settledEarly = target.threads[0]!.settledAt;
      if (poll === 2) target.endRun();
    });
    expect([answer, settledEarly, settledAt]).toEqual([undefined, null, now.toISOString()]);
    expect(server.received).toEqual([expect.objectContaining({ type: "thread.settle", threadId, expectedLatestRunId: runId })]);
  });

  test("a thread that closes on a check with no future run bound to it is sent back once, and never settles", async () => {
    const stale: Task[] = [
      { thread_id: "mcp:another-thread", enabled: 1, next_run_at: "2026-11-15T10:35:00.000Z" },
      { thread_id: threadId, enabled: 0, next_run_at: "2026-11-15T10:35:00.000Z" },
      { thread_id: threadId, enabled: 1, next_run_at: "2026-11-14T11:00:00.000Z" },
      { thread_id: threadId, enabled: 1, next_run_at: null },
    ];
    const { answer, settledAt } = await settleWith({}, (target) => target.endRun(), stale);
    expect(answer?.reason).toContain("no check is scheduled");
    expect(answer?.reason).toContain("starts with ⏳");
    expect(settledAt).toBeNull();
  });

  test("the settle skips a run that did not complete, a message queued behind it, and a run past the timeout", async () => {
    for (const status of ["failed", "interrupted", "cancelled", "rolled_back"]) {
      expect((await settleWith({}, (target) => target.endRun(status))).settledAt).toBeNull();
    }
    expect((await settleWith({}, (target) => target.endRun("completed", "run:conductor-1:ordinal:5"))).settledAt).toBeNull();
    expect((await settleWith({}, () => {})).settledAt).toBeNull();
    expect((await settleWith({}, (target, poll) => { if (poll === 31) target.endRun(); })).settledAt).toBeNull();
  });

  test("the settle waits while the run waits on a question, and settles once it completes", async () => {
    const { settledAt } = await settleWith({}, (target, poll) => {
      if (poll === 1) Object.assign(target.threads[0]!, { status: "waiting", activeRunId: null });
      if (poll === 3) target.endRun();
    });
    expect(settledAt).toBe(now.toISOString());
  });

  test("the settle leaves a thread alone that starts watching a pull request, or that the person pins, before its run ends", async () => {
    const watching = await settleWith({}, (target) => {
      target.threads[0]!.pullRequests = [{ repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", snapshot: { state: "merged" }, watch: { startedAt: "2026-11-14T12:00:01.000Z" } }];
      target.endRun();
    });
    const pinned = await settleWith({}, (target) => { target.threads[0]!.pinnedAt = "2026-11-14T12:01:00.000Z"; target.endRun(); });
    expect([watching.settledAt, pinned.settledAt]).toEqual([null, null]);
  });

  test("the settle leaves a thread alone whose check is turned off, or that comes to own an open PR alone, before its run ends", async () => {
    const disabled = await settleWith({}, (target, _poll, home) => {
      const db = new Database(join(home, ".t3/userdata/statev2.sqlite"));
      db.run("update scheduled_tasks set enabled = 0");
      db.close();
      target.endRun();
    });
    const owning = await settleWith({}, (target) => {
      target.threads[0]!.pullRequests = [{ repository: "acme/app", number: 8, url: "https://github.com/acme/app/pull/8", snapshot: { state: "open" } }];
      target.endRun();
    });
    expect([disabled.settledAt, owning.settledAt]).toEqual([null, null]);
  });

  test("the settle leaves a thread alone once parking is turned off or the hook's kill switch is on, before its run ends", async () => {
    const off = await settleWith({}, (target, _poll, home) => {
      writeFileSync(join(home, ".local/state/hedge/settings.json"), JSON.stringify({ "guards.person": "Robin" }));
      target.endRun();
    });
    const killed = await settleWith({}, (target, _poll, home) => {
      mkdirSync(join(home, ".config/hedge"), { recursive: true });
      writeFileSync(join(home, ".config/hedge/ask-guard.off"), "");
      target.endRun();
    });
    expect([off.settledAt, killed.settledAt]).toEqual([null, null]);
  });

  test("the settle reads the thread again after its last checks, and leaves it alone when a pin, a PR watch, a snooze or an open PR it owns alone arrived meanwhile", async () => {
    const changes: Partial<ShellThread>[] = [
      { pinnedAt: "2026-11-14T12:01:00.000Z" },
      { pullRequests: [{ repository: "acme/app", number: 9, url: "https://github.com/acme/app/pull/9", snapshot: { state: "merged" }, watch: { startedAt: "2026-11-14T12:01:00.000Z" } }] },
      { snoozedUntil: "2026-11-15T08:00:00.000Z" },
      { pullRequests: [{ repository: "acme/app", number: 8, url: "https://github.com/acme/app/pull/8", snapshot: { state: "open" } }] },
    ];
    const settleOnce = async (change: Partial<ShellThread>) => {
      const server = t3Server({ status: "completed", activeRunId: null });
      let reads = 0;
      const changing = { shell: async () => (++reads === 2 && Object.assign(server.threads[0]!, change), { threads: server.threads }), dispatch: server.t3.dispatch };
      await settleWhenRunEnds(changing, { threadId, runId, since: now, stillParks: stillParks(homeWith(checkSoon), () => now) }, { now: () => 0, sleep: async () => {} });
      return server.threads[0]!.settledAt;
    };
    for (const change of changes) expect(await settleOnce(change)).toBeNull();
    expect(await settleOnce({})).toBe(now.toISOString());
  });

  test("the settle reads the thread and its check after it reads the handovers, so a check turned off or a snooze set meanwhile leaves the thread alone", async () => {
    const settleOnce = async (change: (home: string, thread: ShellThread) => void) => {
      const server = t3Server({ status: "completed", activeRunId: null });
      const home = homeWith(checkSoon);
      let reads = 0;
      const handovers = async () => {
        if (++reads === 2) change(home, server.threads[0]!);
        return [];
      };
      await settleWhenRunEnds(server.t3, { threadId, runId, since: now, stillParks: stillParks(home, () => now, handovers) }, { now: () => 0, sleep: async () => {} });
      return server.threads[0]!.settledAt;
    };
    const checkOff = (home: string) => {
      const db = new Database(join(home, ".t3/userdata/statev2.sqlite"));
      db.run("update scheduled_tasks set enabled = 0");
      db.close();
    };
    expect(await settleOnce(checkOff)).toBeNull();
    expect(await settleOnce((_home, thread) => { thread.snoozedUntil = "2026-11-15T08:00:00.000Z"; })).toBeNull();
    expect(await settleOnce(() => {})).toBe(now.toISOString());
  });

  test("a timed snooze reads the clock after it reads T3, so a time that passed meanwhile is not sent", async () => {
    const home = homeWith([], { ...parkingOn, "orchestration.timeZone": "UTC" });
    const server = t3Server();
    let clock = new Date("2026-11-14T11:59:59.000Z");
    const slow = { ...server.t3, shell: async () => { clock = new Date("2026-11-14T12:00:01.000Z"); return server.t3.shell(); } };
    const answer = await stop("💤 This thread **snoozes until 14th Nov 12:00**", server, { home, t3: slow, now: () => clock });
    expect(answer?.decision).toBe("block");
    expect(server.received).toEqual([]);
  });

  test("the longest mark wins when one set mark starts another", async () => {
    const home = homeWith([], { ...parkingOn, "orchestration.timeZone": "UTC", "orchestration.waitMark": "WAIT", "orchestration.snoozeMark": "WAIT UNTIL" });
    const timed = t3Server();
    await stop("WAIT UNTIL 20th Nov 10:00", timed, { home });
    const waiting = t3Server();
    await stop("WAIT on CI", waiting, { home });
    expect([timed.threads[0]!.snoozedUntil, waiting.threads[0]!.snoozedUntil]).toEqual(["2026-11-20T10:00:00.000Z", "2026-11-17T12:00:00.000Z"]);
  });

  test("a stop that ends again after a send-back parks the thread, and never sends it back twice", async () => {
    const continued = (closing: string, server: ReturnType<typeof t3Server>, options: Partial<ParkOptions> = {}) => parkStop(
      { stop_hook_active: true, last_assistant_message: message(closing) },
      { home: options.home ?? homeWith(), threadId, t3: server.t3, now: () => now, processes: { pid: 900, table: async () => laneTree }, settleAfterRun: () => {}, ...options },
    );
    const waiting = t3Server();
    expect(await continued("⏳ **Waiting on** CI", waiting)).toBeUndefined();
    expect(waiting.threads[0]!.snoozedUntil).toBe("2026-11-17T12:00:00.000Z");
    const checking = t3Server();
    const home = homeWith(checkSoon);
    const settle = inProcessSettle(checking, home, () => checking.endRun());
    expect(await continued(checkLine, checking, { home, settleAfterRun: settle.settleAfterRun })).toBeUndefined();
    expect(await settle.settledAt()).toBe(now.toISOString());
    const untimed = t3Server();
    expect(await continued("💤 This thread **snoozes until Monday morning**", untimed)).toBeUndefined();
    const owning = t3Server({ pullRequests: [{ repository: "acme/app", number: 1, url: "https://github.com/acme/app/pull/1", snapshot: { state: "open" } }] });
    expect(await continued("➡️ You can **settle** this thread", owning)).toBeUndefined();
    expect([untimed.received, owning.received]).toEqual([[], []]);
  });

  test("the check sends nothing once its deadline passed", async () => {
    let answer: () => void = () => {};
    const slow = t3Server();
    const stalled = { shell: () => new Promise<{ threads: ShellThread[] }>((resolve) => { answer = () => resolve({ threads: slow.threads }); }), dispatch: slow.t3.dispatch };
    expect(await stop("⏳ **Waiting on** CI", slow, { t3: stalled, deadline: async () => {} })).toBeUndefined();
    answer();
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(slow.received).toEqual([]);
  });

  test("a child thread, a delegated thread, a pending card, a settled thread, or a thread already snoozed is left alone", async () => {
    for (const fields of [
      { lineage: { parentThreadId: "mcp:parent", relationshipToParent: "subagent" } },
      { delegatedFrom: { environmentId: "env-hub", threadId: "mcp:hub-thread" } },
      { pendingRuntimeRequest: { id: "card-1", kind: "user_input" } },
      { settledAt: "2026-11-14T11:00:00.000Z" },
      { snoozedUntil: "2026-11-20T00:00:00.000Z" },
    ]) {
      const server = t3Server(fields);
      expect(await stop("⏳ **Waiting on** the lanes", server)).toBeUndefined();
      expect(await stop("🔕 This thread **settles until its check at 15th Nov 11:35**", server, { home: homeWith(checkSoon) })).toBeUndefined();
      expect(server.received).toEqual([]);
    }
  });

  test("a pinned thread stays in view on a wait, a check, or a done line, and snoozes only when its closing line asks for a time", async () => {
    const pinned = { pinnedAt: "2026-11-13T15:13:00.339Z", pullRequests: [{ repository: "acme/app", number: 1, url: "https://github.com/acme/app/pull/1", snapshot: { state: "open" } }] };
    const server = t3Server(pinned);
    const home = homeWith(checkSoon);
    const settle = inProcessSettle(server, home, () => server.endRun());
    expect(await stop("⏳ **Waiting on** the lanes", server)).toBeUndefined();
    expect(await stop(checkLine, server, { home, settleAfterRun: settle.settleAfterRun })).toBeUndefined();
    expect(await stop("➡️ You can **settle** this thread", server)).toBeUndefined();
    expect([await settle.settledAt(), server.received]).toEqual([null, []]);
    await stop("💤 This thread **snoozes until 14th Nov 22:00**", server);
    expect(server.threads[0]!.snoozedUntil).toBe("2026-11-14T21:00:00.000Z");
  });

  test("a closing line that settles the thread, or asks the person to, is sent back once while the thread alone links an open PR", async () => {
    const link = (n: number, state = "open") => ({ repository: "acme/app", number: n, url: `https://github.com/acme/app/pull/${n}`, snapshot: { state } });
    for (const closing of ["➡️ You can **settle** this thread", "🔕 This thread **settles until its check at 15th Nov 11:35**"]) {
      const server = t3Server({ pullRequests: [link(1), link(2, "merged")] });
      const home = homeWith(checkSoon);
      const settle = inProcessSettle(server, home, () => server.endRun());
      const answer = await stop(closing, server, { home, settleAfterRun: settle.settleAfterRun });
      expect(answer?.reason).toContain("owns open PR(s) https://github.com/acme/app/pull/1,");
      expect(answer?.reason).toContain("If Robin parked them, end on 💤 with the park date. If they wait on someone else, end on ⏳.");
      expect([await settle.settledAt(), server.received]).toEqual([null, []]);
    }
    expect(await stop("➡️ You can **settle** this thread", t3Server({ pullRequests: [link(2, "merged")] }))).toBeUndefined();
    const shared = t3Server({ pullRequests: [link(1)] });
    shared.threads.push({ ...shared.threads[0]!, id: "mcp:heir", activeRunId: null });
    expect(await stop("➡️ You can **settle** this thread", shared)).toBeUndefined();
    const parked = t3Server({ pullRequests: [link(1)] });
    await stop("💤 This thread **snoozes until 25th Nov 09:00**", parked);
    expect(parked.threads[0]!.snoozedUntil).toBe("2026-11-25T08:00:00.000Z");
  });

  test("a handover counts only while the thread it names stays open and links the PR", async () => {
    const link = { repository: "acme/app", number: 1, url: "https://github.com/acme/app/pull/1", snapshot: { state: "open" } };
    const home = homeWith();
    writeFileSync(join(home, ".local/state/hedge/pr-handovers.jsonl"), `${JSON.stringify({ pr: "https://github.com/acme/app/pull/1", from: threadId, to: "mcp:heir", at: "" })}\n`);
    const unlinked = t3Server({ pullRequests: [link] });
    unlinked.threads.push({ id: "mcp:heir", title: "Heir", projectId: "p", status: "idle" });
    expect((await stop("➡️ You can **settle** this thread", unlinked, { home }))?.reason).toContain("pull/1,");
    const linked = t3Server({ pullRequests: [link] });
    linked.threads.push({ id: "mcp:heir", title: "Heir", projectId: "p", status: "idle", settledAt: "x", pullRequests: [link] });
    expect((await stop("➡️ You can **settle** this thread", linked, { home }))?.reason).toContain("pull/1,");
  });

  test("the thread with the hook's exact id is parked, not one whose id only ends with it", async () => {
    const server = t3Server();
    server.threads.unshift({ ...server.threads[0]!, id: `mcp:other:${threadId}` });
    await stop("⏳ **Waiting on** CI", server);
    expect(server.received).toEqual([expect.objectContaining({ threadId })]);
  });

  test("parking stays off until its workflow sets the snooze length", async () => {
    const server = t3Server();
    expect(await stop("⏳ **Waiting on** CI", server, { home: homeWith([], { "guards.person": "Robin" }) })).toBeUndefined();
    expect(await stop("➡️ You can **settle** this thread", t3Server({ pullRequests: [{ repository: "acme/app", number: 1, url: "https://github.com/acme/app/pull/1" }] }), { home: homeWith([], {}) })).toBeUndefined();
    expect(server.received).toEqual([]);
  });

  test("other closing lines, a nested session, and a session outside T3 change nothing", async () => {
    const server = t3Server();
    expect(await stop("❓ **Read the above** and answer the following questions:", server)).toBeUndefined();
    expect(await stop("⏳ **Waiting on** CI", server, { threadId: undefined })).toBeUndefined();
    expect(await stop("⏳ **Waiting on** CI", server, { threadId: "mcp:not-on-this-machine" })).toBeUndefined();
    const nested = [laneTree, "910 700 bash", "920 910 codex", "930 920 sh", "950 930 bun"].join("\n");
    expect(await stop("⏳ **Waiting on** CI", server, { processes: { pid: 950, table: async () => nested } })).toBeUndefined();
    expect(server.received).toEqual([]);
  });

  test("the stop passes when T3, its state, or the process table cannot be read, or when the check runs past its deadline", async () => {
    const down = { shell: async (): Promise<never> => { throw new Error("T3 auth session issue failed"); }, dispatch: async () => {} };
    expect(await stop("⏳ **Waiting on** CI", t3Server(), { t3: down })).toBeUndefined();
    const stalled = { shell: () => new Promise<never>(() => {}), dispatch: async () => {} };
    expect(await stop("⏳ **Waiting on** CI", t3Server(), { t3: stalled, deadline: async () => {} })).toBeUndefined();
    const noState = temp.make("closing-line-");
    mkdirSync(join(noState, ".local/state/hedge"), { recursive: true });
    writeFileSync(join(noState, ".local/state/hedge/settings.json"), JSON.stringify(parkingOn));
    expect(await stop("🔕 This thread **settles until its check at 15th Nov 11:35**", t3Server(), { home: noState })).toBeUndefined();
    expect(await stop("⏳ **Waiting on** CI", t3Server(), { processes: { pid: 900, table: async () => { throw new Error("ps exited 1"); } } })).toBeUndefined();
  });
});

describe("closing marks", () => {
  test("default to the four marks, and read set marks with or without the emoji variation selector", () => {
    expect(closingSettings(temp.make("marks-"))).toEqual({ marks: defaultMarks });
    expect(closingPark("Done.\n\n➡ You can settle this thread", defaultMarks)).toBe("done");
    expect(closingPark("Done.\n\n➡️ You can settle this thread", defaultMarks)).toBe("done");
    const home = homeWith([], { ...parkingOn, "orchestration.waitMark": "WAIT:", "orchestration.doneMark": " " });
    const { marks } = closingSettings(home);
    expect(marks).toEqual({ ...defaultMarks, wait: "WAIT:" });
    expect(closingPark("Lanes run.\n\nWAIT: the lanes", marks)).toBe("wait");
    expect(closingPark("Lanes run.\n\n⏳ the lanes", marks)).toBeUndefined();
    expect(closingPark("⏳ Earlier wait.\n\nDone, nothing else.", defaultMarks)).toBeUndefined();
  });

  test("a set wait mark snoozes the thread", async () => {
    const server = t3Server();
    await stop("WAIT: the lanes", server, { home: homeWith([], { ...parkingOn, "orchestration.waitMark": "WAIT:" }) });
    expect(server.threads[0]!.snoozedUntil).toBe("2026-11-17T12:00:00.000Z");
  });
});
