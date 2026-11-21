import { expect, test } from "bun:test";
import { fakeRuntime, thread, type FakeMachine } from "../../../src/testing/runtime.ts";
import { runActivity } from "./activity.ts";

async function activity(machines: Record<string, FakeMachine>, args: string[]) {
  const runtime = fakeRuntime(machines);
  const lines: string[] = [];
  const code = await runActivity(args, { host: "hub", print: (line) => lines.push(line), threads: async () => runtime.threads });
  return { code, text: lines.join("\n"), json: () => JSON.parse(lines.join("\n")) };
}

const pr = (number: number) => ({ url: `https://github.com/acme/app/pull/${number}`, repository: "acme/app", number });

test("hedge activity lists each machine, busy threads first and then the most recent", async () => {
  const { code, text } = await activity({
    "": { threads: [thread("idle", { updatedAt: "2026-10-02T00:00:00Z" }), thread("busy", { state: "blocked", updatedAt: "2026-10-01T00:00:00Z", model: "claude-big", cwd: "/w/busy" })] },
    "devbox-2": { threads: [thread("far", { state: "working" })] },
  }, []);
  expect(code).toBe(0);
  expect(text).toBe([
    "hub",
    "  * blocked 2026-10-01T00:00:00Z: Thread busy\n    busy claude-big /w/busy",
    "    idle 2026-10-02T00:00:00Z: Thread idle\n    idle  ",
    "devbox-2",
    "  * working 2026-10-01T00:00:00.000Z: Thread far\n    far  ",
  ].join("\n"));
});

test("--open lists the open top-level threads of every machine with the PRs their subagent threads link", async () => {
  const { json } = await activity({ "": { threads: [
    thread("root", { pullRequests: [pr(1)] }),
    thread("child", { parentId: "root", pullRequests: [pr(2), pr(1)] }),
    thread("grandchild", { parentId: "child", pullRequests: [pr(3)] }),
    thread("asks", { state: "blocked", blocked: { kind: "question", key: "q" } }),
    thread("closed", { closed: "settled", pullRequests: [pr(4)] }),
  ] } }, ["--open"]);
  const [report] = json();
  expect(report.work.map((work: { id: string; pullRequests: { number: number }[]; waiting: boolean }) => [work.id, work.pullRequests.map((item) => item.number), work.waiting])).toEqual([["root", [1, 2, 3], false], ["asks", [], true]]);
});

test("--since lists the top-level threads a person wrote in since then, with only their words from then on", async () => {
  const at = (minute: number) => `2026-10-01T00:${String(minute).padStart(2, "0")}:00Z`;
  const { json } = await activity({ "": {
    threads: [thread("a", { updatedAt: at(30), branch: "fix" }), thread("old", { updatedAt: at(1) }), thread("sub", { parentId: "a", updatedAt: at(30) })],
    reads: { a: { messages: [
      { id: "1", role: "user", text: "before", at: at(5), from: "person" },
      { id: "2", role: "user", text: "after", at: at(20), from: "person" },
      { id: "3", role: "user", text: "from a lane", at: at(21), from: "agent" },
      { id: "4", role: "assistant", text: "ok", at: at(22) },
    ] } },
  } }, ["--since", at(10)]);
  expect(json()[0].work).toEqual([{ id: "a", title: "Thread a", status: "idle", branch: "fix", pullRequests: [], messages: ["after"] }]);
});

test("a host reads one machine by its name, and this machine by its own", async () => {
  const machines = { "": { threads: [thread("here")] }, "devbox-2": { threads: [thread("there")] } };
  expect((await activity(machines, ["devbox-2", "--json"])).json().map((report: { host: string }) => report.host)).toEqual(["devbox-2"]);
  expect((await activity(machines, ["hub", "--json"])).json().map((report: { host: string }) => report.host)).toEqual(["hub"]);
  expect(activity(machines, ["nowhere"])).rejects.toThrow("No machine nowhere. Reachable: devbox-2.");
});

test("a machine that cannot answer is named with its reason, and the command exits 1", async () => {
  const { code, text } = await activity({ "": { threads: [] }, "devbox-2": { problem: "its link expired" } }, []);
  expect(code).toBe(1);
  expect(text).toBe("hub\n  No threads.\ndevbox-2: its link expired");
});

test("--thread prints what the runtime reads of one thread", async () => {
  const { json } = await activity({ "": { threads: [thread("t7")], reads: { t7: { screen: "> ready" } } } }, ["--local", "--thread", "t7"]);
  expect(json()[0].thread).toEqual({ screen: "> ready" });
  expect(activity({ "": {} }, ["--thread", "t7"])).rejects.toThrow("Choose a host or --local when reading a thread.");
});
