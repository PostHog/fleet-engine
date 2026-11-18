import { type Hook, printing, quiet, runHook } from "../lib/hook.ts";
import { modelSelection } from "../lib/model-selection.ts";

export const reminder = "This prompt asks for a review. A review runs in a worker that did not write the code, cast from the review rows of the model table, and in the other model family when a row names it. Review the code yourself only when you were dispatched as its reviewer.";
export const pointer = "The table is in ~/.agents/AGENTS.md.";

const ownPrompts = [/^\s*You review a pull request/i, /^\s*Act as the review sub-agent/i, /^\s*Update on pull request/i, /^\s*\[SYSTEM NOTIFICATION/i, /^\s*<task-notification>/i];
const asksReview = /\b(re-?)?review(s|ed|ing)?\b(?![\s-]*(comments?|findings?|feedback|threads?|bots?|notes?|requests?|rounds?|says?|said)\b)/i;
const reviewTarget = /\b(PRs?|pull requests?|diffs?|commits?|branch(es)?|changes|stack|code)\b|#\d+|\/pull\/\d+|\b[0-9a-f]{7,40}\b/i;

function asksForReview(prompt: string): boolean {
  if (ownPrompts.some((own) => own.test(prompt))) return false;
  return asksReview.test(prompt) && reviewTarget.test(prompt);
}

export const hook: Hook = async (provider, readInput, home) => {
  if (provider !== "claude" && provider !== "codex") return quiet;
  let input: unknown;
  try {
    input = JSON.parse(await readInput());
  } catch {
    return quiet;
  }
  const prompt = typeof input === "object" && input !== null ? (input as { prompt?: unknown }).prompt : undefined;
  if (typeof prompt !== "string" || !asksForReview(prompt)) return quiet;
  const table = modelSelection(home);
  const context = table ? `${reminder}\n\n${table}` : `${reminder} ${pointer}`;
  return printing({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
};

if (import.meta.main) await runHook(hook);
