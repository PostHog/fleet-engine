import { expect, test } from "bun:test";
import type { RuntimeMessage } from "../../../src/sdk/runtime.ts";
import { fakeRuntime, thread, type FakeMachine } from "../../../src/testing/runtime.ts";
import { minutesAgo, now } from "./testing.ts";
import { needsHuman, runLanes } from "./lanes.ts";
import type { Discussion, IssueNode } from "./wayfinder.ts";

type Ticket = { number: number; thread?: string; state?: string; labels?: string[]; assignees?: string[] };

const tickets: Ticket[] = [
  { number: 2, thread: "mcp:local-lane" },
  { number: 3, thread: "mcp:linked-stalled" },
  { number: 4, thread: "mcp:linked-waiting" },
  { number: 5, thread: "mcp:linked-archived" },
  { number: 6, thread: "linked-finished" },
  { number: 7, thread: "mcp:nowhere" },
  { number: 8, thread: "mcp:linked-busy" },
  { number: 9, thread: "mcp:linked-finished", state: "CLOSED" },
  { number: 10, thread: "mcp:linked-finished", labels: ["wayfinder:task", "wayfinder:awaiting-human"] },
  { number: 11, thread: "mcp:local-grilling", labels: ["wayfinder:grilling"] },
];

function issue(ticket: Ticket): IssueNode {
  return {
    number: ticket.number, title: `Ticket ${ticket.number}`, state: ticket.state ?? "OPEN", repository: "acme/maps",
    assignees: ticket.assignees ?? ["someone"], labels: ticket.labels ?? ["wayfinder:task"], blockedBy: [], childCount: 0, children: [],
  };
}

function discussion(ticket: Ticket | undefined): Discussion {
  const body = `<!-- orchestration-wayfinder-dispatch -->\nDispatched.\nThread: \`${ticket?.thread}\``;
  return { body: "", comments: ticket?.thread ? [{ author: "someone", body, url: `https://github.com/acme/maps/issues/${ticket.number}#c`, createdAt: minutesAgo(500) }] : [] };
}

const said = (role: RuntimeMessage["role"], text: string): RuntimeMessage => ({ id: text, role, text, at: minutesAgo(20) });

const here: FakeMachine = {
  threads: [thread("mcp:local-lane", { state: "done", updatedAt: minutesAgo(20) }), thread("mcp:local-grilling", { state: "done", updatedAt: minutesAgo(20) })],
  reads: { "mcp:local-lane": { messages: [said("user", "Go"), said("assistant", "I stopped here.\n**NEEDS_HUMAN: pick a name**")] }, "mcp:local-grilling": { messages: [] } },
};

const box: FakeMachine = {
  threads: [
    thread("mcp:linked-stalled", { state: "working", updatedAt: minutesAgo(45) }),
    thread("mcp:linked-waiting", { state: "blocked", blocked: { kind: "question", key: "q" }, updatedAt: minutesAgo(1) }),
    thread("mcp:linked-archived", { closed: "archived" }),
    thread("mcp:linked-finished", { state: "done" }),
    thread("mcp:linked-busy", { state: "done", updatedAt: minutesAgo(200) }),
    thread("mcp:linked-busy-child", { state: "working", parentId: "mcp:linked-busy", updatedAt: minutesAgo(3) }),
  ],
  reads: { "mcp:linked-finished": { messages: [said("user", "Go"), said("assistant", "All done.\nNEEDS_HUMAN: is a quote here, not at the end\nDone.")] } },
};

async function lanes(machines: Record<string, FakeMachine>, chosen: Ticket[] = tickets, args = ["https://github.com/acme/maps/issues/1"]) {
  const runtime = fakeRuntime(machines);
  const lines: string[] = [];
  const map: IssueNode = { ...issue({ number: 1, labels: ["wayfinder:map"] }), childCount: chosen.length, children: chosen.map(issue) };
  const code = await runLanes(args, {
    host: "this-box", now, print: (line) => lines.push(line), threads: async () => runtime.threads,
    fetchIssue: async (_owner, _repo, number) => (number === 1 ? map : issue(chosen.find((ticket) => ticket.number === number)!)),
    fetchDiscussion: async (_owner, _repo, number) => discussion(chosen.find((ticket) => ticket.number === number)),
  });
  return { code, output: lines.join("\n") };
}

test("hedge lanes finds each lane on this machine or another and names the ones that need the conductor", async () => {
  const { code, output } = await lanes({ "": here, "devbox-2": box });
  expect(output).toBe([
    "Lanes of acme/maps#1 that need attention:",
    "  #2 task needs the human: pick a name. Ask them with the question tool, then send the answer to its thread. Thread mcp:local-lane on this-box.",
    "  #3 task stalled: running with no activity for 45m. Read its thread, and stop it when it is past its cap. Thread mcp:linked-stalled on devbox-2.",
    "  #4 task blocked: waits on an approval or an answer nobody sees in thread mcp:linked-waiting. Thread mcp:linked-waiting on devbox-2.",
    "  #5 task gone: its thread is archived or deleted. Reconcile the ticket as an orphaned lane. Thread mcp:linked-archived on devbox-2.",
    "  #6 task finished: ended its turn with the ticket open. Read its result and act on it. Thread linked-finished on devbox-2.",
    "  #7 task gone: no box has its thread mcp:nowhere. Reconcile the ticket as an orphaned lane.",
  ].join("\n"));
  expect(code).toBe(1);
});

test("a machine that fails to read its lanes is named as not answering, and its lanes are not called gone", async () => {
  const { code, output } = await lanes({ "": { threads: [] }, "devbox-2": { fails: "The linked environment answered HTTP 503." } }, [{ number: 2, thread: "mcp:linked-flaky" }]);
  expect(output).toBe("devbox-2 did not answer: The linked environment answered HTTP 503.");
  expect(code).toBe(1);
});

test("a runtime that shows a lane as its screen still shows the ask that the lane printed last", async () => {
  const screen = { screen: "● Done.\n  NEEDS_HUMAN: pick a region\n\n╭────╮\n│ >  │\n╰────╯" };
  const { output } = await lanes({ "": { threads: [thread("t7", { state: "idle" })], reads: { t7: screen } } }, [{ number: 2, thread: "t7" }]);
  expect(output).toBe("Lanes of acme/maps#1 that need attention:\n  #2 task needs the human: pick a region. Ask them with the question tool, then send the answer to its thread. Thread t7 on this-box.");
});

test("hedge lanes refuses a bad map or stall, and says when no lane needs attention", async () => {
  const usage = "Usage: hedge lanes <map URL | owner/repo#number> [--stall minutes]";
  await expect(lanes({ "": {} }, [], [])).rejects.toThrow(usage);
  await expect(lanes({ "": {} }, [], ["acme/maps#1", "--stall", "soon"])).rejects.toThrow(usage);
  await expect(lanes({ "": {} }, [], ["not a map"])).rejects.toThrow(usage);
  expect(await lanes({ "": { threads: [] } }, [], ["acme/maps#1"])).toEqual({ code: 0, output: "No lane of acme/maps#1 needs attention." });
});

test("only the last line of a lane's final message asks for the human", () => {
  expect(needsHuman("Done.\n`NEEDS_HUMAN: choose the region`")).toBe("choose the region");
  expect(needsHuman("NEEDS_HUMAN:")).toBe("no ask given");
  expect(needsHuman("NEEDS_HUMAN: quoted\nDone.")).toBeNull();
});
