import { expect, test } from "bun:test";
import { reportFor, reportStatus, statusSequence } from "./hooks/report-status.ts";

const event = (fields: Record<string, unknown>) => async () => JSON.stringify(fields);

function hook(env: Record<string, string> = { HC_TERMINAL_ID: "t7" }) {
  const written: string[] = [];
  return { run: reportStatus(env, (text) => written.push(text)), written };
}

test("each agent event maps to the status that herdr-core shows, and a question or a permission blocks", () => {
  expect([
    reportFor({ hook_event_name: "SessionStart" }),
    reportFor({ hook_event_name: "UserPromptSubmit" }),
    reportFor({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
    reportFor({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
    reportFor({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
    reportFor({ hook_event_name: "Notification", notification_type: "permission_prompt" }),
    reportFor({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
    reportFor({ hook_event_name: "Stop" }),
  ]).toEqual([
    { state: "idle" },
    { state: "working" },
    { state: "working" },
    { state: "blocked", kind: "question" },
    { state: "working" },
    { state: "blocked", kind: "permission" },
    undefined,
    { state: "done" },
  ]);
});

test("a report is one OSC 7501 sequence that names the agent", () => {
  expect(statusSequence({ state: "blocked", kind: "permission" }, "claude")).toBe("\x1b]7501;state=blocked:kind=permission:app=claude\x1b\\");
  expect(statusSequence({ state: "done" }, "codex")).toBe("\x1b]7501;state=done:app=codex\x1b\\");
});

test("the hook reports only inside a herdr-core terminal, answers nothing to the agent, and never fails it", async () => {
  const inside = hook();
  expect(await inside.run("claude", event({ hook_event_name: "Stop" }), "/home")).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(inside.written).toEqual(["\x1b]7501;state=done:app=claude\x1b\\"]);

  const outside = hook({});
  await outside.run("claude", event({ hook_event_name: "Stop" }), "/home");
  expect(outside.written).toEqual([]);

  const broken = reportStatus({ HC_TERMINAL_ID: "t7" }, () => {
    throw new Error("no terminal");
  });
  expect(await broken("codex", event({ hook_event_name: "Stop" }), "/home")).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(await hook().run("claude", async () => "not json", "/home")).toEqual({ code: 0, stdout: "", stderr: "" });
});
