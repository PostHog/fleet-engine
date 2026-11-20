import { listLinkedThreads, readLinkedItemText, readLinkedThread } from "./client/environments.ts";
import type { T3HttpClient } from "./client/session.ts";
import { isWaiting, readTurnItems, type ShellSnapshot, type ShellThread } from "./client/threads.ts";

export type ParkedThread = { id: string; title: string; snoozedUntil: string | null; snoozedAt: string | null; message: { text: string; at: string } };
export type ParkedThreads = { threads: ParkedThread[]; unread: string[] };

const parkedTail = 20;
const parkedTextCap = 4000;

async function eachThread<T extends { id: string }>(threads: T[], read: (thread: T) => Promise<ParkedThread[]>): Promise<ParkedThreads> {
  const results = await Promise.allSettled(threads.map(read));
  return {
    threads: results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    unread: threads.filter((_, index) => results[index]!.status === "rejected").map((thread) => thread.id),
  };
}

function hiddenFromInbox(thread: ShellThread): boolean {
  return !thread.activeRunId && !thread.pendingRuntimeRequest && (isWaiting(thread) || Boolean(thread.snoozedUntil));
}

export async function readParkedThreads(client: T3HttpClient): Promise<ParkedThreads> {
  const shell = await client.getShell<ShellSnapshot>();
  const parked = shell.threads.filter((thread) => !thread.deletedAt && !thread.archivedAt && !thread.settledAt && !thread.lineage?.parentThreadId && hiddenFromInbox(thread));
  return eachThread(parked, async (thread): Promise<ParkedThread[]> => {
    const items = (await readTurnItems(client, thread.id, () => false)).map(({ item }) => item);
    const last = items.filter((item) => item.type === "user_message" || (item.type === "assistant_message" && item.text)).at(-1);
    if (last?.type !== "assistant_message" || !last.text) return [];
    return [{ id: thread.id, title: thread.title, snoozedUntil: thread.snoozedUntil ?? null, snoozedAt: thread.snoozedAt ?? null, message: { text: last.text.slice(-parkedTextCap), at: last.startedAt } }];
  });
}

export async function readLinkedParkedThreads(client: T3HttpClient, environmentId: string): Promise<ParkedThreads> {
  const threads = await listLinkedThreads(client, environmentId, { allProjects: true, settled: false });
  const running = threads.filter((thread) => !thread.parentThreadId && thread.status === "running").map((thread) => ({ ...thread, id: thread.threadId }));
  return eachThread(running, async (thread): Promise<ParkedThread[]> => {
    const afterPosition = thread.itemCount - parkedTail - 1;
    const tail = await readLinkedThread(client, environmentId, { threadId: thread.threadId, view: "activity", ...(afterPosition >= 0 ? { afterPosition } : {}), limit: parkedTail, maxCharsPerItem: parkedTextCap });
    const last = tail.items.at(-1);
    if (tail.thread.pendingRequestCount > 0 || last?.type !== "assistant_message" || !last.text) return [];
    const text = (await readLinkedItemText(client, environmentId, thread.threadId, last)) ?? "";
    return [{ id: thread.threadId, title: thread.title, snoozedUntil: thread.snoozedUntil, snoozedAt: null, message: { text: text.slice(-parkedTextCap), at: last.updatedAt } }];
  });
}
