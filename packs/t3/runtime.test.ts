import { afterEach, expect, test } from "bun:test";
import { linkedEnvironment, linkedItem, linkedThread, linkedTools, minutesAgo, shellThread } from "../orchestration/lib/testing.ts";
import { startT3Stub, type T3Fixture } from "./lib/client/testing.ts";
import runtime from "./runtime.ts";
import { t3RuntimeThreads } from "./lib/runtime-threads.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function threadsOf(fixture: T3Fixture) {
  const stub = await startT3Stub({ environmentId: "env-hub", ...fixture });
  cleanups.push(() => stub.stop());
  return { stub, threads: t3RuntimeThreads([], { home: stub.home }) };
}

test("the T3 runtime names its thread variable and says what it can tell", () => {
  expect([runtime.name, runtime.title, runtime.threadVariable, runtime.capabilities]).toEqual(["t3", "T3 Code", "T3CODE_THREAD_ID", { machines: true, prLinks: true, transcript: true }]);
});

test("a thread on this machine shows its state, its question, its family, its pull requests, and its link", async () => {
  const { threads } = await threadsOf({ shell: { projects: [], threads: [
    shellThread("mcp:run", { activeRunId: "run-1", worktreePath: "/w/run", branch: "fix", pullRequests: [{ repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", snapshot: { state: "OPEN" } }] }),
    shellThread("mcp:ask", { pendingRuntimeRequest: { id: "card-1", kind: "user_input" }, lineage: { parentThreadId: "mcp:run" } }),
    shellThread("mcp:gone", { archivedAt: minutesAgo(5) }),
  ] } });
  const listed = await threads.list();
  expect(listed.map((thread) => [thread.id, thread.state, thread.blocked?.key ?? null, thread.parentId ?? null])).toEqual([["mcp:run", "working", null, null], ["mcp:ask", "blocked", "card-1", "mcp:run"]]);
  expect(listed[0]).toMatchObject({ cwd: "/w/run", branch: "fix", url: "https://app.t3.codes/threads/env-hub/mcp:run", pullRequests: [{ url: "https://github.com/acme/app/pull/7", repository: "acme/app", number: 7, state: "OPEN" }] });
  expect((await threads.list({ includeClosed: true })).map((thread) => [thread.id, thread.closed ?? null])).toContainEqual(["mcp:gone", "archived"]);
  expect((await threads.find("run"))?.id).toBe("mcp:run");
});

test("a linked machine is a machine of the runtime, by its label, and its threads come through the link", async () => {
  const { threads, stub } = await threadsOf({ shell: { projects: [], threads: [] }, links: [linkedEnvironment, { ...linkedEnvironment, environmentId: "env-old", label: "old-box", status: "expired" }], tools: linkedTools([
    linkedThread("mcp:far", { status: "running", items: [linkedItem("user_message", "Fix it"), linkedItem("assistant_message", "On it")] }),
  ]) });
  expect(await threads.machines()).toEqual([
    { name: "this machine", id: "env-hub", self: true },
    { name: "devbox-2", id: "env-linked", self: false },
    { name: "old-box", id: "env-old", self: false, problem: "the link is expired" },
  ]);
  expect((await threads.list({ machine: "devbox-2" })).map((thread) => [thread.id, thread.machine, thread.state, thread.url])).toEqual([["mcp:far", "devbox-2", "working", "https://app.t3.codes/threads/env-linked/mcp:far"]]);
  expect(await threads.read("mcp:far", { machine: "devbox-2" })).toEqual({ messages: [
    { id: "user_message-6", role: "user", text: "Fix it", at: minutesAgo(300), from: "person" },
    { id: "assistant_message-5", role: "assistant", text: "On it", at: minutesAgo(300) },
  ] });
  expect(await threads.send({ id: "mcp:far", text: "Status?", machine: "devbox-2" })).toBe(true);
  expect(stub.toolCalls.find((call) => call.name === "t3_thread_send")?.args).toMatchObject({ environmentId: "env-linked", threadId: "mcp:far", message: "Status?" });
  expect(threads.list({ machine: "nowhere" })).rejects.toThrow("T3 Code links no machine named nowhere.");
});

test("a send to an archived or unknown thread on this machine answers false and sends nothing", async () => {
  const { threads, stub } = await threadsOf({ shell: { projects: [], threads: [shellThread("mcp:old", { archivedAt: minutesAgo(1) })] } });
  expect([await threads.send({ id: "mcp:old", text: "hi" }), await threads.send({ id: "mcp:none", text: "hi" })]).toEqual([false, false]);
  expect(stub.toolCalls).toEqual([]);
});

test("a start on another machine is refused, because T3 Code starts threads where it runs", async () => {
  const { threads } = await threadsOf({ shell: { projects: [], threads: [] } });
  expect(threads.start({ key: "k", title: "T", prompt: "P", modelRole: "implementation", machine: "devbox-2" })).rejects.toThrow("T3 Code starts a thread on this machine only.");
});
