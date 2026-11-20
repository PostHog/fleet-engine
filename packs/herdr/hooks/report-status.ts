import { closeSync, openSync, writeSync } from "node:fs";
import { type Hook, quiet, runHook } from "../../base/lib/hook.ts";

export type Report = { state: "idle" | "working" | "done" | "blocked"; kind?: "permission" | "question" };
export type WriteTerminal = (text: string) => void;

type HookEvent = { hook_event_name?: unknown; tool_name?: unknown; notification_type?: unknown };

const questionTools = new Set(["AskUserQuestion"]);

export function reportFor(event: HookEvent): Report | undefined {
  switch (event.hook_event_name) {
    case "SessionStart":
      return { state: "idle" };
    case "UserPromptSubmit":
    case "PostToolUse":
      return { state: "working" };
    case "PreToolUse":
      return questionTools.has(String(event.tool_name)) ? { state: "blocked", kind: "question" } : { state: "working" };
    case "Notification":
      if (event.notification_type === "permission_prompt") return { state: "blocked", kind: "permission" };
      if (event.notification_type === "elicitation_dialog") return { state: "blocked", kind: "question" };
      return undefined;
    case "Stop":
      return { state: "done" };
    default:
      return undefined;
  }
}

export const statusSequence = (report: Report, app: string) =>
  `\x1b]7501;${[`state=${report.state}`, report.kind && `kind=${report.kind}`, `app=${app}`].filter(Boolean).join(":")}\x1b\\`;

const controllingTerminal: WriteTerminal = (text) => {
  const fd = openSync("/dev/tty", "w");
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
};

export function reportStatus(env: NodeJS.ProcessEnv, write: WriteTerminal = controllingTerminal): Hook {
  return async (provider, readInput) => {
    if (!env.HC_TERMINAL_ID) return quiet;
    let event: HookEvent;
    try {
      event = JSON.parse(await readInput()) as HookEvent;
    } catch {
      return quiet;
    }
    const report = typeof event === "object" && event !== null ? reportFor(event) : undefined;
    if (!report) return quiet;
    try {
      write(statusSequence(report, provider));
    } catch {}
    return quiet;
  };
}

if (import.meta.main) await runHook(reportStatus(process.env));
