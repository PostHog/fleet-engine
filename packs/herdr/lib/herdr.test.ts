import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelRow } from "../../../src/pack/types.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import type { Hc, HcResult } from "./hc.ts";
import { agentCommand, renderTemplate } from "./templates.ts";
import { herdrThreads, terminalName, threadsDir } from "./threads.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const models: ModelRow[] = [
  { role: "implementation", work: "Implementation", provider: "claude", model: "claude-big", effort: "high" },
  { role: "lookup", work: "Lookups", provider: "codex", model: "gpt-small", effort: "low", serviceTier: "fast" },
];

const request = { key: "slack:message-1", title: "Slack: the build is red", prompt: "Find out why the build is red.", modelRole: "implementation" };

const ok = (stdout: unknown): HcResult => ({ code: 0, stdout: JSON.stringify(stdout), stderr: "" });
const failed = (code: number, message: string): HcResult => ({ code, stdout: "", stderr: JSON.stringify({ error: { kind: "x", message } }) });

function fakeHc(answer: (args: string[]) => HcResult) {
  const calls: string[][] = [];
  const hc: Hc = async (args) => (calls.push(args), answer(args));
  return { hc, calls };
}

test("a template starts the agent of its model row, and Codex runs without its daemon so its commands stay in the terminal", () => {
  expect(agentCommand(models[0]!)).toBe("'claude' '--model' 'claude-big' '--effort' 'high'");
  expect(agentCommand(models[1]!)).toBe(`'codex' '--no-daemon' '-m' 'gpt-small' '-c' 'model_reasoning_effort="low"' '-c' 'service_tier="fast"'`);
  expect(renderTemplate(models[0]!)).toBe([
    "---",
    "description: Hedge implementation: Implementation",
    "command: 'claude' '--model' 'claude-big' '--effort' 'high'",
    "---",
    "Hedge started this implementation thread on claude-big. Your task follows.",
    "",
  ].join("\n"));
});

test("a terminal name fits herdr-core's rule, and two keys with one title get two names", () => {
  const name = terminalName("Slack: the build is red, and the deploy waits", "a");
  expect(name).toMatch(/^[a-z0-9_-]{1,32}$/);
  expect(name).toStartWith("slack-the-build-is-red-");
  expect(terminalName("Slack: the build is red, and the deploy waits", "b")).not.toBe(name);
  expect(terminalName("!!!", "a")).toMatch(/^[0-9a-f]{8}$/);
});

test("a thread starts in the background from its role's template, in the Hedge space, and keeps running after a restart", async () => {
  const home = temp.make("home-");
  const { hc, calls } = fakeHc((args) => (args[0] === "ls" ? ok({ terminals: [] }) : ok({ address: "t7", first_message: { sent: true } })));
  expect(await herdrThreads(models, { hc, home }).start(request)).toEqual({ id: "t7" });
  const [list, run] = calls;
  expect(list!.slice(0, 4)).toEqual(["ls", "--all", "--json", "--label"]);
  const label = list![4]!;
  expect(label).toMatch(/^hedge\.thread=[0-9a-f]{16}$/);
  expect(run).toEqual(["run", "--json", "--bg", "--keep", "--no-parent", "--name", terminalName(request.title, request.key), "--cwd", join(home, threadsDir),
    "--label", label, "--label", "herdr.space=hedge", "hedge-implementation", request.prompt]);
  expect(existsSync(join(home, threadsDir))).toBe(true);
});

test("a second start with the same key returns the first terminal, also after it finished, and starts nothing", async () => {
  const { hc, calls } = fakeHc(() => ok({ terminals: [{ address: "t3", state: "finished" }] }));
  expect(await herdrThreads(models, { hc, home: temp.make("home-") }).start(request)).toEqual({ id: "t3" });
  expect(calls.map((args) => args[0])).toEqual(["ls"]);
});

test("a start says when the agent did not take its task, and names the terminal to open", async () => {
  const { hc } = fakeHc((args) => (args[0] === "ls" ? ok({ terminals: [] }) : ok({ address: "t9", first_message: { sent: false, reason: "not_ready" } })));
  await expect(herdrThreads(models, { hc, home: temp.make("home-") }).start(request)).rejects.toThrow("did not take its task (not_ready). Open it with hc attach t9");
});

test("a start refuses a role that the model table lacks, and reports herdr-core's own words when it fails", async () => {
  const home = temp.make("home-");
  await expect(herdrThreads(models, { hc: fakeHc(() => ok({})).hc, home }).start({ ...request, modelRole: "security" })).rejects.toThrow("has no security row");
  const down = fakeHc(() => failed(1, "the core is not running"));
  await expect(herdrThreads(models, { hc: down.hc, home }).start(request)).rejects.toThrow("herdr-core did not list its terminals: the core is not running");
});

test("a send answers false for a terminal that is gone or finished, and reports any other failure", async () => {
  const home = temp.make("home-");
  const codes = new Map([["t1", ok({})], ["t2", failed(3, "not found")], ["t3", failed(11, "finished")], ["t4", failed(9, "blocked")]]);
  const { hc, calls } = fakeHc((args) => codes.get(args[1]!)!);
  const threads = herdrThreads(models, { hc, home });
  expect(await threads.send({ id: "t1", text: "Recheck the fix" })).toBe(true);
  expect(calls[0]).toEqual(["send", "t1", "Recheck the fix"]);
  expect(await threads.send({ id: "t2", text: "x" })).toBe(false);
  expect(await threads.send({ id: "t3", text: "x" })).toBe(false);
  await expect(threads.send({ id: "t4", text: "x" })).rejects.toThrow("herdr-core did not send to t4: blocked");
});

test("a list shows the agent terminals of this machine or of one other machine, with their reported state, their question, and their parent", async () => {
  const terminals = [
    { address: "t7", name: "fix", title: "Fix the build", state: "live", cwd: "/w/fix", status: { state: "blocked", kind: "question" }, status_ms: Date.parse("2026-10-01T00:00:00Z"), turn: 2 },
    { address: "t8", state: "live", parent: "t7", status: { state: "working" } },
    { address: "t9", state: "live", status: null },
    { address: "t3", state: "finished", labels: { "hedge.thread": "abc" }, finished_ms: Date.parse("2026-10-02T00:00:00Z") },
    { address: "box/t1", state: "live", parent: "t4", status: { state: "error", msg: "rate limited" } },
  ];
  const { hc, calls } = fakeHc(() => ok({ terminals }));
  const threads = herdrThreads(models, { hc, home: temp.make("home-") });
  expect(await threads.list()).toEqual([
    { id: "t7", title: "Fix the build", state: "blocked", blocked: { kind: "question", key: "t7:2" }, cwd: "/w/fix", updatedAt: "2026-10-01T00:00:00.000Z" },
    { id: "t8", title: "t8", state: "working", parentId: "t7" },
  ]);
  expect(calls[0]).toEqual(["ls", "--json"]);
  expect((await threads.list({ includeClosed: true })).map((thread) => [thread.id, thread.closed ?? null])).toContainEqual(["t3", "settled"]);
  expect(await threads.list({ machine: "box" })).toEqual([{ id: "box/t1", machine: "box", title: "box/t1", state: "error", parentId: "box/t4", error: "rate limited" }]);
  expect([(await threads.find("t7"))?.id, (await threads.find("t1", { machine: "box" }))?.id, await threads.find("t1")]).toEqual(["t7", "box/t1", undefined]);
});

test("a read is the terminal's screen, and machines are this one and each herdr-core machine with why it cannot be reached", async () => {
  const { hc, calls } = fakeHc((args) => (args[0] === "read" ? { code: 0, stdout: "> ready\n", stderr: "" } : ok({ machines: [{ name: "box", id: "m1", state: "connected" }, { name: "old", id: "m2", state: "needs_login", why: "SSH login failed" }] })));
  const threads = herdrThreads(models, { hc, home: temp.make("home-") });
  expect(await threads.read("t1", { machine: "box", tail: 5 })).toEqual({ screen: "> ready\n" });
  expect(calls[0]).toEqual(["read", "box/t1", "--lines", "200"]);
  expect(await threads.machines()).toEqual([
    { name: "this machine", id: "local", self: true },
    { name: "box", id: "m1", self: false },
    { name: "old", id: "m2", self: false, problem: "SSH login failed" },
  ]);
});

test("a start on another machine runs there, and a start may name the folder the thread starts in", async () => {
  const { hc, calls } = fakeHc((args) => (args[0] === "ls" ? ok({ terminals: [] }) : ok({ address: "box/t2", first_message: { sent: true } })));
  const threads = herdrThreads(models, { hc, home: temp.make("home-") });
  expect(await threads.start({ ...request, machine: "box", cwd: "/w/app" })).toEqual({ id: "box/t2" });
  const run = calls.find((args) => args[0] === "run")!;
  expect([run[run.indexOf("--cwd") + 1], run[run.indexOf("--on") + 1]]).toEqual(["/w/app", "box"]);
});
