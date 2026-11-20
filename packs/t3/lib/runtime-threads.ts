import type { ModelRow } from "../../../src/pack/types.ts";
import { MaybeStarted, type RuntimeMachine, type RuntimeThread, type RuntimeThreads, type ThreadState } from "../../../src/sdk/runtime.ts";
import { listLinkedEnvironments, listLinkedThreads, readLinkedMessages, sendLinkedMessage, type LinkedThread, type LinkedThreadDetail } from "./client/environments.ts";
import { UnansweredLaunch } from "./client/launch.ts";
import { withT3Session, type T3HttpClient, type T3SessionOptions } from "./client/session.ts";
import { t3Threads, threadUrl } from "./client/start.ts";
import { isWaiting, lastActivityAt, matchThread, questionCard, readSnapshots, readTurnItems, sendMessage, type ShellThread } from "./client/threads.ts";

const scopes = ["orchestration:read", "orchestration:operate", "access:read"];
const liveStatuses = new Set(["preparing", "queued", "starting", "running"]);

function shellState(thread: ShellThread): ThreadState {
  const status = thread.activityRunStatus ?? thread.status;
  if (questionCard(thread) || thread.pendingRuntimeRequest) return "blocked";
  if (thread.activeRunId || liveStatuses.has(status)) return "working";
  if (isWaiting(thread)) return "waiting";
  if (status === "failed" || thread.lastError) return "error";
  return thread.latestRunCompletedAt ? "done" : "idle";
}

export function fromShell(thread: ShellThread, environmentId?: string): RuntimeThread {
  const card = questionCard(thread);
  return {
    id: thread.id,
    title: thread.title,
    state: shellState(thread),
    ...(card ? { blocked: { kind: "question" as const, key: card } } : thread.pendingRuntimeRequest ? { blocked: { kind: "permission" as const, key: `${thread.id}:${thread.activeRunId ?? ""}` } } : {}),
    ...(thread.deletedAt ? { closed: "deleted" as const } : thread.archivedAt ? { closed: "archived" as const } : thread.settledAt ? { closed: "settled" as const } : {}),
    ...(thread.lineage?.parentThreadId ? { parentId: thread.lineage.parentThreadId } : {}),
    ...(thread.worktreePath ? { cwd: thread.worktreePath } : {}),
    ...(thread.branch ? { branch: thread.branch } : {}),
    updatedAt: lastActivityAt(thread),
    ...(thread.latestVisibleMessage?.text ? { latestText: thread.latestVisibleMessage.text } : {}),
    ...(thread.modelSelection?.model ? { model: thread.modelSelection.model } : {}),
    ...(thread.lastError ? { error: thread.lastError } : {}),
    ...(environmentId ? { url: threadUrl(environmentId, thread.id) } : {}),
    pullRequests: (thread.pullRequests ?? []).map((pr) => ({ url: pr.url, repository: pr.repository, number: pr.number, ...(pr.snapshot?.state ? { state: pr.snapshot.state } : {}) })),
  };
}

export function fromLinked(thread: LinkedThread | LinkedThreadDetail, machine: string, environmentId: string): RuntimeThread {
  const detail = thread as Partial<LinkedThreadDetail>;
  const state: ThreadState = (detail.pendingRequestCount ?? 0) > 0 ? "blocked" : thread.status === "running" ? "working" : thread.status === "waiting" ? "waiting" : thread.status === "failed" ? "error" : thread.status === "completed" ? "done" : "idle";
  return {
    id: thread.threadId,
    machine,
    title: thread.title,
    state,
    ...(state === "blocked" ? { blocked: { kind: "question" as const, key: `${thread.threadId}:${thread.itemCount}` } } : {}),
    ...(detail.archived ? { closed: "archived" as const } : thread.settled ? { closed: "settled" as const } : {}),
    ...(thread.parentThreadId ? { parentId: thread.parentThreadId } : {}),
    ...(detail.worktreePath ? { cwd: detail.worktreePath } : {}),
    ...(detail.branch ? { branch: detail.branch } : {}),
    updatedAt: thread.updatedAt,
    model: thread.model,
    url: threadUrl(environmentId, thread.threadId),
    pullRequests: (thread.pullRequests ?? []).map((pr) => ({ url: pr.url, repository: pr.repository, number: pr.number, ...(pr.state ? { state: pr.state } : {}) })),
  };
}

async function selfEnvironment(client: T3HttpClient): Promise<string | undefined> {
  const answer = await client.get<{ environmentId?: unknown }>("/.well-known/t3/environment").catch(() => undefined);
  return typeof answer?.environmentId === "string" ? answer.environmentId : undefined;
}

async function environmentOf(client: T3HttpClient, machine: string): Promise<string> {
  const links = await listLinkedEnvironments(client);
  const link = links.find((item) => item.label === machine || item.environmentId === machine);
  if (!link) throw new Error(`T3 Code links no machine named ${machine}. Run hedge threads machines to see the linked machines.`);
  return link.environmentId;
}

export function t3RuntimeThreads(models: ModelRow[], session: T3SessionOptions = {}): RuntimeThreads {
  const starter = t3Threads(models, session);
  const within = <T>(run: (client: T3HttpClient) => Promise<T>) => withT3Session(run, { ...session, scopes });
  const list = (machine?: string, includeClosed = false) =>
    within(async (client) => {
      if (machine) {
        const environmentId = await environmentOf(client, machine);
        const threads = await listLinkedThreads(client, environmentId, { allProjects: true, includeSubagents: true, ...(includeClosed ? {} : { settled: false }) });
        return threads.map((thread) => fromLinked(thread, machine, environmentId));
      }
      const environmentId = await selfEnvironment(client);
      const threads = (await readSnapshots(client)).flatMap((snapshot) => snapshot.threads).map((thread) => fromShell(thread, environmentId));
      return includeClosed ? threads : threads.filter((thread) => !thread.closed);
    });
  return {
    async start(def) {
      if (def.machine) throw new Error("T3 Code starts a thread on this machine only. Run the command on the machine that should run the thread.");
      try {
        return await starter.start(def);
      } catch (error) {
        throw error instanceof UnansweredLaunch ? new MaybeStarted(error.message) : error;
      }
    },
    send: ({ id, text, machine }) =>
      machine
        ? within(async (client) => (await sendLinkedMessage(client, await environmentOf(client, machine), id, text), true))
        : within(async (client) => {
            const thread = matchThread((await readSnapshots(client)).flatMap((snapshot) => snapshot.threads), id, (item) => item.id);
            if (!thread || thread.archivedAt) return false;
            await sendMessage(client, thread, text);
            return true;
          }),
    list: (options = {}) => list(options.machine, options.includeClosed),
    find: async (id, options = {}) => matchThread(await list(options.machine, true), id, (thread) => thread.id),
    read: (id, options = {}) =>
      within(async (client) => {
        if (options.machine) {
          const { items } = await readLinkedMessages(client, await environmentOf(client, options.machine), id);
          const messages = items.filter((item) => item.text && (item.type === "user_message" || item.type === "assistant_message")).map((item) => ({ id: item.itemId, role: item.type === "user_message" ? ("user" as const) : ("assistant" as const), text: item.text!, at: item.updatedAt, ...(item.type === "user_message" ? { from: author(item.createdBy, item.creationSource) } : {}) }));
          return { messages: tail(since(messages, options.since), options.tail) };
        }
        const thread = matchThread((await readSnapshots(client)).flatMap((snapshot) => snapshot.threads), id, (item) => item.id);
        if (!thread) throw new Error(`No thread ${id} on this machine.`);
        const items = await readTurnItems(client, thread.id, (oldest) => !options.since || (oldest?.item.startedAt ?? "") >= options.since);
        const messages = items.filter(({ item }) => item.text && (item.type === "user_message" || item.type === "assistant_message")).map(({ item }) => ({ id: item.messageId ?? item.id ?? "", role: item.type === "user_message" ? ("user" as const) : ("assistant" as const), text: item.text!, at: item.updatedAt ?? item.startedAt, ...(item.type === "user_message" ? { from: author(item.createdBy, item.creationSource) } : {}) }));
        return { messages: tail(since(messages, options.since), options.tail) };
      }),
    machines: () =>
      within(async (client) => {
        const self: RuntimeMachine = { name: "this machine", id: (await selfEnvironment(client)) ?? "local", self: true };
        const links = await listLinkedEnvironments(client);
        return [self, ...links.map((link) => ({ name: link.label, id: link.environmentId, self: false, ...(link.status === "reachable" ? {} : { problem: link.lastError ?? `the link is ${link.status}` }) }))];
      }),
  };
}

const author = (createdBy?: string | null, source?: string | null) => (createdBy === "user" && (source === "web" || source === "mobile") ? ("person" as const) : ("agent" as const));
const since = <T extends { at: string }>(items: T[], from?: string) => (from ? items.filter((item) => item.at >= from) : items);
const tail = <T>(items: T[], count?: number) => (count === undefined ? items : items.slice(-count));
