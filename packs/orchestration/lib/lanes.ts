import type { RuntimeThread, RuntimeThreads, ThreadRead, Where } from "../../../src/sdk/runtime.ts";
import { readEachMachine, readMachines } from "./machines.ts";
import {
  descendants, fetchDiscussionFromGitHub, fetchIssueFromGitHub, mapRef, parked, splitRepository, ticketType,
  type Comment, type FetchDiscussion, type FetchIssue, type MapRef, type Ticket,
} from "./wayfinder.ts";

export type LaneThread = { id: string; status: string; live: boolean; updatedAt: string; gone: boolean; waitingIn: string | null; needsHuman?: string | null };
export type BoxReport = { host: string; threads?: LaneThread[]; error?: string };
export type ReadBoxes = (threadIds: string[]) => Promise<BoxReport[]>;
export type LaneAttention = { attention: boolean; text: string };
export type LanesIo = {
  host: string; now: Date; print(line: string): void; threads(): Promise<RuntimeThreads>;
  fetchIssue?: FetchIssue; fetchDiscussion?: FetchDiscussion;
};

type Lane = { ticket: Ticket; threadId: string };

const usage = "Usage: hedge lanes <map URL | owner/repo#number> [--stall minutes]";
const dispatchMarker = "<!-- orchestration-wayfinder-dispatch -->";
const settledStates = ["done", "idle"];
const liveStates = new Set(["working", "waiting"]);
const defaultStallMinutes = 30;
const tailItems = 50;
export const needsHumanMarker = "NEEDS_HUMAN:";

const matchId = (threads: RuntimeThread[], id: string) => threads.find((thread) => thread.id === id) ?? threads.find((thread) => thread.id.endsWith(`:${id}`) || thread.id.endsWith(`/${id}`));

export async function readLaneThreads(threads: RuntimeThreads, where: Where, threadIds: string[]): Promise<LaneThread[]> {
  const all = (await threads.list({ ...where, includeClosed: true })).filter((thread) => thread.closed !== "deleted");
  const children = Map.groupBy(all, (thread) => thread.parentId ?? "");
  const family = (thread: RuntimeThread): RuntimeThread[] => [thread, ...(children.get(thread.id) ?? []).flatMap(family)];
  const lanes = threadIds.flatMap((id) => {
    const lane = matchId(all, id);
    return lane ? [{ id, lane, members: family(lane) }] : [];
  });
  return Promise.all(lanes.map(async ({ id, lane, members }) => {
    const gone = lane.closed === "archived";
    const live = gone ? [] : members.filter((thread) => liveStates.has(thread.state));
    return {
      id, status: lane.state, live: live.length > 0,
      updatedAt: members.map((thread) => thread.updatedAt ?? "").sort().at(-1) ?? "", gone,
      waitingIn: members.find((thread) => thread.blocked)?.id ?? null,
      needsHuman: live.length || gone ? null : needsHuman(finalText(await threads.read(lane.id, { ...where, tail: tailItems }).catch(() => ({ messages: [] })))),
    };
  }));
}

function finalText(read: ThreadRead): string {
  if ("screen" in read) return read.screen.split("\n").map((line) => line.replace(/[`*│]/g, "").trim()).filter((line) => line.startsWith(needsHumanMarker)).at(-1) ?? "";
  const last = read.messages.filter((message) => message.role === "user" || message.text).at(-1);
  return last?.role === "assistant" ? last.text : "";
}


export function needsHuman(message: string): string | null {
  const last = message.trim().split("\n").at(-1)?.replace(/[`*]/g, "").trim() ?? "";
  return last.startsWith(needsHumanMarker) ? last.slice(needsHumanMarker.length).trim() || "no ask given" : null;
}

export async function readLaneAttention(
  ref: MapRef, fetchIssue: FetchIssue, fetchDiscussion: FetchDiscussion, readBoxes: ReadBoxes, now: Date, stallMinutes: number,
): Promise<LaneAttention> {
  const tickets = await descendants(await fetchIssue(ref.owner, ref.repo, ref.number), fetchIssue);
  const lanes = (await Promise.all(tickets.filter(isWorking).map((ticket) => dispatchedLane(ticket, fetchDiscussion))))
    .filter((lane): lane is Lane => Boolean(lane));
  const boxes = lanes.length ? await readBoxes(lanes.map((lane) => lane.threadId)) : [];
  const findings = lanes.flatMap((lane) => {
    const finding = attentionFor(lane, boxes, now, stallMinutes);
    return finding ? [`  #${lane.ticket.number} ${ticketType(lane.ticket) ?? "ticket"} ${finding}`] : [];
  });
  const silentBoxes = boxes.filter((box) => box.error).map((box) => `${box.host} did not answer: ${box.error}`);
  const map = `${ref.owner}/${ref.repo}#${ref.number}`;
  if (!findings.length && !silentBoxes.length) return { attention: false, text: `No lane of ${map} needs attention.` };
  const heading = findings.length ? [`Lanes of ${map} that need attention:`] : [];
  return { attention: true, text: [...heading, ...findings, ...silentBoxes].join("\n") };
}

function isWorking(ticket: Ticket): boolean {
  return ticket.state === "OPEN" && ticket.assignees.length > 0 && !ticket.labels.includes(parked);
}

async function dispatchedLane(ticket: Ticket, fetchDiscussion: FetchDiscussion): Promise<Lane | undefined> {
  const [owner, repo] = splitRepository(ticket.repository);
  const { comments } = await fetchDiscussion(owner, repo, ticket.number);
  const threadId = comments.map(locatorThread).filter(Boolean).at(-1);
  return threadId ? { ticket, threadId } : undefined;
}

function locatorThread(comment: Comment): string | undefined {
  if (!comment.body.includes(dispatchMarker)) return undefined;
  return comment.body.match(/^(?:Child thread|Thread):\s*`?([a-zA-Z0-9][a-zA-Z0-9:._%-]{0,511})`?\s*$/m)?.[1];
}

function attentionFor(lane: Lane, boxes: BoxReport[], now: Date, stallMinutes: number): string | undefined {
  const found = boxes.flatMap((box) => (box.threads ?? []).filter((thread) => thread.id === lane.threadId).map((thread) => ({ box, thread })))[0];
  const orphaned = "Reconcile the ticket as an orphaned lane.";
  if (!found) return boxes.some((box) => box.error) ? undefined : `gone: no box has its thread ${lane.threadId}. ${orphaned}`;
  const { box, thread } = found;
  const where = `Thread ${thread.id} on ${box.host}.`;
  if (thread.gone) return `gone: its thread is archived or deleted. ${orphaned} ${where}`;
  if (thread.waitingIn) return `blocked: waits on an approval or an answer nobody sees in thread ${thread.waitingIn}. ${where}`;
  if (thread.needsHuman) return `needs the human: ${thread.needsHuman}. Ask them with the question tool, then send the answer to its thread. ${where}`;
  if (thread.live) {
    const quietMinutes = Math.floor((now.getTime() - Date.parse(thread.updatedAt)) / 60_000);
    return quietMinutes > stallMinutes
      ? `stalled: running with no activity for ${quietMinutes}m. Read its thread, and stop it when it is past its cap. ${where}`
      : undefined;
  }
  if (ticketType(lane.ticket) === "grilling") return undefined;
  const status = settledStates.includes(thread.status) ? "" : ` Its runtime shows ${thread.status}; the ticket decides.`;
  return `finished: ended its turn with the ticket open. Read its result and act on it.${status} ${where}`;
}

export async function runLanes(args: string[], io: LanesIo): Promise<number> {
  const [map, flag, minutes, ...rest] = args;
  if (!map || rest.length || (flag && (flag !== "--stall" || !/^\d+$/.test(minutes ?? "")))) throw new Error(usage);
  const ref = mapRef(map, usage);
  const readBoxes: ReadBoxes = async (threadIds) => {
    const threads = await io.threads();
    return readEachMachine(await readMachines(threads, io.host), async (where) => ({ threads: await readLaneThreads(threads, where, threadIds) }));
  };
  const report = await readLaneAttention(ref, io.fetchIssue ?? fetchIssueFromGitHub, io.fetchDiscussion ?? fetchDiscussionFromGitHub, readBoxes, io.now, Number(minutes ?? defaultStallMinutes));
  io.print(report.text);
  return report.attention ? 1 : 0;
}
