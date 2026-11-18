import { type Hook, printing, quiet, runHook } from "../lib/hook.ts";
import { modelSelection } from "../lib/model-selection.ts";

const reminder = "This prompt asks for a review. A review runs in a worker that did not write the code, cast from the review rows of the model table, and in the other model family when a row names it. Review the code yourself only when you were dispatched as its reviewer.";
const pointer = "The table is in ~/.agents/AGENTS.md.";

const ownPrompts = [/^\s*You review a pull request/i, /^\s*Act as the review sub-agent/i, /^\s*Update on pull request/i, /^\s*\[SYSTEM NOTIFICATION/i, /^\s*<task-notification>/i];
const asksReview = /(?<!\b(the|its|their|this|that)\s+)\b(re-?)?review(s|ing)?\b(?![\s-]*(comments?|findings?|feedback|threads?|bots?|notes?|requests?|rounds?|says?|said)(?!\w|\.\w))/i;
const holdsReview = /\b(do not|don't|not|never|no need to|without|skip)\s+(\w+\s+)?(re-?)?review\b/i;
const reviewTarget = /\b(PRs?|pull requests?|diffs?|commits?|branch(es)?|changes|stack|code)\b|#\d+|\/pull\/\d+|\b(?=[0-9a-f]*\d)[0-9a-f]{6,40}\b|[\w-]\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|kt|swift|sh|md|json|ya?ml|toml|sql|css|html)\b/i;

function asksForReview(prompt: string): boolean {
  if (ownPrompts.some((own) => own.test(prompt)) || !reviewTarget.test(prompt)) return false;
  return prompt.split(/(?<=[.!?])\s+|\n+/).some((sentence) => asksReview.test(sentence) && !holdsReview.test(sentence));
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
