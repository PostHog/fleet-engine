import { expect, test } from "bun:test";
import { fakeRuntime, thread } from "../../../src/testing/runtime.ts";
import { runThread } from "./thread.ts";

function run(machines: Parameters<typeof fakeRuntime>[0], args: string[], stdin = "") {
  const runtime = fakeRuntime(machines);
  const lines: string[] = [];
  const result = runThread(args, { host: "hub", print: (line) => lines.push(line), readStdin: async () => stdin, threads: async () => runtime.threads });
  return { result, runtime, output: () => JSON.parse(lines.join("\n")) };
}

test("hedge thread send finds the thread on another machine without --host, and sends there", async () => {
  const { result, runtime, output } = run({ "": { threads: [thread("a")] }, box: { threads: [thread("b")] } }, ["send", "b", "Look", "again"]);
  expect(await result).toBe(0);
  expect(runtime.sent).toEqual([{ id: "b", text: "Look again", machine: "box" }]);
  expect(output()).toEqual({ host: "box", threadId: "b", sent: true });
});

test("hedge thread send takes the message from stdin, and words after the id are the message even when they look like flags", async () => {
  const fromStdin = run({ "": { threads: [thread("a")] } }, ["send", "a"], " from stdin \n");
  expect(await fromStdin.result).toBe(0);
  const flags = run({ "": { threads: [thread("a")] } }, ["send", "a", "--host", "x"]);
  expect(await flags.result).toBe(0);
  expect([...fromStdin.runtime.sent, ...flags.runtime.sent].map((sent) => sent.text)).toEqual(["from stdin", "--host x"]);
});

test("hedge thread send refuses an empty message and a thread it cannot place, and sends nothing", async () => {
  const empty = run({ "": { threads: [thread("a")] } }, ["send", "a"], "  ");
  expect(empty.result).rejects.toThrow("The message is empty.");
  const nowhere = run({ "": { threads: [thread("a")] }, box: { fails: "the link expired" } }, ["send", "z", "hi"]);
  expect(nowhere.result).rejects.toThrow("No machine has thread z.\nbox: the link expired");
  expect([...empty.runtime.sent, ...nowhere.runtime.sent]).toEqual([]);
});

test("an unqualified send waits for every machine to answer, so a copy on a silent machine is never skipped", async () => {
  const { result, runtime } = run({ "": { threads: [thread("a")] }, box: { problem: "did not answer" } }, ["send", "a", "hi"]);
  expect(result).rejects.toThrow("Thread a is on hub, but box could not be checked (did not answer). Choose the machine with --host.");
  expect(runtime.sent).toEqual([]);
  const chosen = run({ "": { threads: [thread("a")] }, box: { problem: "did not answer" } }, ["send", "--host", "hub", "a", "hi"]);
  expect(await chosen.result).toBe(0);
});

test("a short id finds a thread by its last part, and an id that fits two threads, or threads on two machines, is refused", async () => {
  const short = run({ "": { threads: [thread("mcp:abc")] } }, ["find", "abc"]);
  expect(await short.result).toBe(0);
  expect(short.output()).toEqual({ host: "hub", threadId: "mcp:abc" });
  expect(run({ "": { threads: [thread("mcp:abc"), thread("web:abc")] } }, ["find", "abc"]).result).rejects.toThrow("abc fits mcp:abc, web:abc. Give the full id.");
  expect(run({ "": { threads: [thread("a")] }, box: { threads: [thread("a")] } }, ["find", "a"]).result).rejects.toThrow("Thread a is on hub, box. Choose one with --host.");
});

test("an archived thread named by its full id wins over a live thread whose id ends with it", async () => {
  const { result, output } = run({ "": { threads: [thread("abc", { closed: "archived" }), thread("mcp:abc")] } }, ["find", "abc"]);
  expect(await result).toBe(0);
  expect(output().threadId).toBe("abc");
});

test("hedge thread read prints what the runtime shows, and --words keeps only what a person typed", async () => {
  const messages = [
    { id: "1", role: "user" as const, text: "Fix it", at: "2026-10-01T00:00:00Z", from: "person" as const },
    { id: "2", role: "assistant" as const, text: "Done", at: "2026-10-01T00:01:00Z" },
    { id: "3", role: "user" as const, text: "Lane update", at: "2026-10-01T00:02:00Z", from: "agent" as const },
  ];
  const read = run({ box: { threads: [thread("b")], reads: { b: { messages } } }, "": {} }, ["read", "b"]);
  expect(await read.result).toBe(0);
  expect(read.output().read).toEqual({ messages });
  const words = run({ box: { threads: [thread("b")], reads: { b: { messages } } }, "": {} }, ["read", "b", "--words"]);
  expect(await words.result).toBe(0);
  expect(words.output()).toEqual({ host: "box", words: [messages[0]] });
  const screen = run({ "": { threads: [thread("t7")], reads: { t7: { screen: "> working" } } } }, ["read", "t7", "--words"]);
  expect(screen.result).rejects.toThrow("cannot tell which words a person typed");
});

test("hedge thread without an action prints its usage", () => {
  expect(run({ "": {} }, []).result).rejects.toThrow("Usage: hedge thread list");
});
