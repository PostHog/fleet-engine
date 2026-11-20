import { expect, test } from "bun:test";
import type { AgentRuntime } from "../../src/sdk/runtime.ts";
import { fakeRuntime, thread } from "../../src/testing/runtime.ts";
import { threadsCommand } from "./lib/threads-cli.ts";

function threadsCli(args: string[], stdin = "", machines: Parameters<typeof fakeRuntime>[0] = { "": { threads: [thread("t1")] }, box: { problem: "needs a login" } }) {
  const fake = fakeRuntime(machines);
  const runtime = { name: "fake", title: "Fake", capabilities: { machines: true, prLinks: false, transcript: false }, threads: () => fake.threads, threadVariable: "FAKE_THREAD" } satisfies AgentRuntime;
  const lines: string[] = [];
  const result = threadsCommand(args, {
    runtime: async () => ({ runtime, threads: fake.threads, record: { name: "fake", path: "", runtimes: {}, models: [] } }),
    print: (line) => lines.push(line), readStdin: async () => stdin, now: () => Date.parse("2026-11-20T09:41:30Z"),
  });
  return { result, fake, lines };
}

test("hedge threads start takes the prompt from stdin or --prompt, the role, the folder, and a key that --each-run makes new each minute", async () => {
  const piped = threadsCli(["start", "--key", "disk-watch:box-1", "--title", "Disk alert", "--role", "lookup"], "Look at the disk.\n");
  expect(await piped.result).toBe(0);
  const timed = threadsCli(["start", "--key", "hedge:quality-loop", "--each-run", "--title", "Hedge: quality-loop", "--cwd", "/w/app", "--prompt", "Run the loop."]);
  expect(await timed.result).toBe(0);
  expect([...piped.fake.started, ...timed.fake.started]).toEqual([
    { key: "disk-watch:box-1", title: "Disk alert", prompt: "Look at the disk.", modelRole: "lookup" },
    { key: "hedge:quality-loop:2026-11-20T09:41", title: "Hedge: quality-loop", prompt: "Run the loop.", modelRole: "implementation", cwd: "/w/app" },
  ]);
  expect(piped.lines).toEqual([JSON.stringify({ id: "started-1" })]);
});

test("hedge threads lists threads and machines, sends a message from stdin, and says when a thread is gone", async () => {
  const listed = threadsCli(["list"]);
  expect(await listed.result).toBe(0);
  expect(listed.lines).toEqual(["t1\tidle\tThread t1"]);
  const machines = threadsCli(["machines"]);
  await machines.result;
  expect(machines.lines).toEqual(["this machine\tthis machine\treachable", "box\tenv-box\tneeds a login"]);
  const sent = threadsCli(["send", "t1"], "Status?");
  expect(await sent.result).toBe(0);
  expect(sent.fake.sent).toEqual([{ id: "t1", text: "Status?" }]);
  const gone = threadsCli(["send", "t9"], "Status?");
  expect(await gone.result).toBe(1);
  expect(gone.lines).toEqual(["Fake has no open thread t9."]);
});

test("hedge threads refuses an empty prompt, a missing key, and an unknown verb", () => {
  expect(threadsCli(["start", "--key", "k", "--title", "T"], " ").result).rejects.toThrow("reads the prompt from standard input, and it was empty");
  expect(threadsCli(["start", "--title", "T"], "x").result).rejects.toThrow("Usage:");
  expect(threadsCli(["stop"]).result).rejects.toThrow("Usage:");
});
