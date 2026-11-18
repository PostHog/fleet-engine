import { type Hook, printing, quiet, runHook } from "../lib/hook.ts";
import { modelSelection, tableRows } from "../lib/model-selection.ts";

export const reminder = "This prompt asks for a review. A review runs in a worker that did not write the code, cast from the review rows of the model table, and in the other model family when a row names it. Review the code yourself only when you were dispatched as its reviewer.";
export const pointer = "The table is in ~/.agents/AGENTS.md.";

const ownPrompts = [/^\s*Act as the review sub-agent/i, /^\s*Update on pull request/i];
const asksReview = /\b(re-?)?review(s|ed|ing)?\b/i;
const reviewTarget = /\b(PRs?|pull requests?|diffs?|commits?|branch(es)?|changes|stack|code)\b|#\d+|\/pull\/\d+/i;

export function asksForReview(prompt: string): boolean {
  if (ownPrompts.some((own) => own.test(prompt))) return false;
  return asksReview.test(prompt) && reviewTarget.test(prompt);
}

export function nudge(prompt: string, section: string | undefined): string | undefined {
  if (!asksForReview(prompt)) return undefined;
  const rows = section ? tableRows(section, /review/i) : undefined;
  return rows ? `${reminder}\n\n${rows}` : `${reminder} ${pointer}`;
}

type PromptInput = { prompt?: unknown };

export const hook: Hook = async (provider, readInput, home) => {
  if (provider !== "claude" && provider !== "codex") return quiet;
  let input: PromptInput;
  try {
    input = JSON.parse(await readInput()) as PromptInput;
  } catch {
    return quiet;
  }
  if (typeof input.prompt !== "string" || !asksForReview(input.prompt)) return quiet;
  const context = nudge(input.prompt, modelSelection(home));
  return printing(context ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } } : undefined);
};

if (import.meta.main) await runHook(hook);
