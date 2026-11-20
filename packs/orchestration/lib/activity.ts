import type { RuntimePullRequest, RuntimeThread, RuntimeThreads, Where } from "../../../src/sdk/runtime.ts";
import { pickMachine, readEachMachine, readMachines, type MachineReport } from "./machines.ts";

export type Work = { id: string; title: string; status: string; branch: string | null; pullRequests: RuntimePullRequest[]; messages: string[] };
export type OpenWork = Work & { waiting: boolean; updatedAt: string };
export type Activity = {
  id: string; title: string; status: string; busy: boolean; updatedAt: string;
  closed: boolean; worktree: string | null; model: string | null; error: string | null; latestMessage: string | null;
};
export type ActivityReport = MachineReport<{ threads?: Activity[]; thread?: unknown; work?: Work[] }>;
export type ActivityIo = { host: string; print(line: string): void; threads(): Promise<RuntimeThreads> };

type Query = { kind: "recent"; limit: number } | { kind: "open" } | { kind: "since"; since: Date } | { kind: "thread"; threadId: string };
type Request = { query: Query; host?: string; local: boolean; json: boolean };

const usage = "Usage: hedge activity [host] [--local] [--thread id | --since time | --open] [--limit count] [--json]";
const threadIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9:/._%-]{0,511}$/;
const latestMessageCap = 1000;
const busyStates = new Set(["working", "waiting", "blocked"]);

const listed = (threads: RuntimeThreads, where: Where) => threads.list({ ...where, includeClosed: true }).then((all) => all.filter((thread) => thread.closed !== "deleted"));

export async function readActivity(threads: RuntimeThreads, where: Where, limit: number): Promise<Activity[]> {
  return busyAndRecent((await listed(threads, where)).map((thread): Activity => ({
    id: thread.id, title: thread.title, status: thread.state, busy: busyStates.has(thread.state), updatedAt: thread.updatedAt ?? "",
    closed: Boolean(thread.closed), worktree: thread.cwd ?? null, model: thread.model ?? null, error: thread.error ?? null,
    latestMessage: thread.latestText?.slice(0, latestMessageCap) ?? null,
  })), limit);
}

export async function readWorkSince(threads: RuntimeThreads, where: Where, since: Date): Promise<Work[]> {
  const from = since.toISOString();
  const roots = (await listed(threads, where)).filter((thread) => !thread.parentId && (thread.updatedAt ?? "") >= from);
  const work = await Promise.all(roots.map(async (thread) => {
    const read = await threads.read(thread.id, { ...where, since: from });
    const messages = "screen" in read ? [] : read.messages.filter((message) => message.role === "user" && message.from === "person" && message.at >= from).map((message) => message.text);
    return { id: thread.id, title: thread.title, status: thread.state, branch: thread.branch ?? null, pullRequests: pullRequestKeys(thread.pullRequests ?? []), messages };
  }));
  return work.filter((thread) => thread.messages.length);
}

export async function readOpenWork(threads: RuntimeThreads, where: Where): Promise<OpenWork[]> {
  const open = await threads.list(where);
  const byId = new Map(open.map((thread) => [thread.id, thread]));
  const rootOf = (thread: RuntimeThread): string => {
    const parent = thread.parentId ? byId.get(thread.parentId) : undefined;
    return parent ? rootOf(parent) : thread.parentId ?? thread.id;
  };
  const children = Map.groupBy(open.filter((thread) => thread.parentId), rootOf);
  return open.filter((thread) => !thread.parentId).map((thread) => ({
    id: thread.id, title: thread.title, status: thread.state, branch: thread.branch ?? null,
    pullRequests: uniqueByUrl([thread, ...(children.get(thread.id) ?? [])].flatMap((member) => member.pullRequests ?? [])),
    messages: [], waiting: thread.state === "blocked", updatedAt: thread.updatedAt ?? "",
  }));
}

function busyAndRecent(threads: Activity[], limit: number): Activity[] {
  const sorted = threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return [...sorted.filter((thread) => thread.busy), ...sorted.filter((thread) => !thread.busy).slice(0, limit)];
}

function pullRequestKeys(pullRequests: RuntimePullRequest[]): RuntimePullRequest[] {
  return pullRequests.map(({ repository, number, url }) => ({ url, ...(repository ? { repository } : {}), ...(number ? { number } : {}) }));
}

function uniqueByUrl(pullRequests: RuntimePullRequest[]): RuntimePullRequest[] {
  return [...new Map(pullRequestKeys(pullRequests).map((pullRequest) => [pullRequest.url.toLowerCase(), pullRequest])).values()];
}

function parseRequest(args: string[]): Request {
  let local = false;
  let json = false;
  let open = false;
  let host: string | undefined;
  let threadId: string | undefined;
  let limit = 20;
  let since: Date | undefined;
  const rest = [...args];
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--local") { local = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--open") { open = true; continue; }
    if (arg === "--words") throw new Error("--words moved to hedge thread read <id> --words.");
    if (arg === "--since") {
      since = new Date(rest.shift() ?? "");
      if (Number.isNaN(since.getTime())) throw new Error("Give --since an ISO time, such as 2026-10-09T12:00:00Z.");
      continue;
    }
    if (arg === "--limit" || arg === "--thread") {
      const value = rest.shift();
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === "--limit") {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new Error("Activity limit must be between 1 and 100.");
        limit = Number(value);
      } else {
        if (!threadIdPattern.test(value)) throw new Error("Invalid thread id.");
        threadId = value;
      }
      continue;
    }
    if (arg.startsWith("-") || host) throw new Error(usage);
    host = arg;
  }
  if (local && host) throw new Error("Choose a host or --local.");
  if ([since, threadId, open || undefined].filter(Boolean).length > 1) throw new Error("Choose one of --since, --thread, and --open.");
  if (threadId && !local && !host) throw new Error("Choose a host or --local when reading a thread.");
  const query: Query = open ? { kind: "open" } : since ? { kind: "since", since } : threadId ? { kind: "thread", threadId } : { kind: "recent", limit };
  return { query, host, local, json };
}

async function readOn(threads: RuntimeThreads, where: Where, query: Query) {
  if (query.kind === "open") return { work: await readOpenWork(threads, where) };
  if (query.kind === "since") return { work: await readWorkSince(threads, where, query.since) };
  if (query.kind === "thread") return { thread: await threads.read(query.threadId, where) };
  return { threads: await readActivity(threads, where, query.limit) };
}

export async function runActivity(args: string[], io: ActivityIo): Promise<number> {
  const { query, host, local, json } = parseRequest(args);
  const threads = await io.threads();
  const machines = local ? [{ host: io.host, where: {} }] : await readMachines(threads, io.host);
  const chosen = host ? [pickMachine(machines, host)] : machines;
  const reports: ActivityReport[] = await readEachMachine(chosen, (where) => readOn(threads, where, query));
  if (json || query.kind !== "recent") io.print(JSON.stringify(reports, null, 2));
  else for (const report of reports) printReport(report, io.print);
  return reports.some((report) => report.error) ? 1 : 0;
}

function printReport(report: ActivityReport, print: (line: string) => void): void {
  print(`${report.host}${report.error ? `: ${report.error}` : ""}`);
  if (report.error !== undefined) return;
  if (!report.threads?.length) print("  No threads.");
  for (const thread of report.threads ?? []) print(`  ${thread.busy ? "*" : " "} ${thread.status} ${thread.updatedAt}: ${thread.title}\n    ${thread.id} ${thread.model ?? ""} ${thread.worktree ?? ""}`);
}
