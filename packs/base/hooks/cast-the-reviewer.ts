import { type Hook, printing, quiet, runHook } from "../lib/hook.ts";
import { modelSelection } from "../lib/model-selection.ts";

const reminder = "This prompt asks for a review. A review runs in a worker that did not write the code, cast from the review rows of the model table, and in the other model family when a row names it. Review the code yourself only when you were dispatched as its reviewer.";
const pointer = "The table is in ~/.agents/AGENTS.md.";

const ownPrompts = [/^\s*You review a pull request/i, /^\s*Act as the review sub-agent/i, /^\s*Update on pull request/i, /^\s*\[SYSTEM NOTIFICATION/i, /^\s*<task-notification>/i];
const fileName = /[\w-]\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|kt|swift|sh|md|json|ya?ml|toml|sql|css|html)\b/;
const slashedWords = /^[a-z-]+\/[a-z-]+[.,:;!?]?$/i;
const asksReview = /(?<!\b(the|its|their|this|that)\s+(code\s+)?)\b(re-?)?review(s|ing)?\b(?![\s-]*(comments?|findings?|feedback|threads?|bots?|notes?|requests?|rounds?|says?|said)(?!\w|\.\w))/i;
const holdsReview = /\b(do not|don't|not|never|no need to|without|skip)\s+(\w+\s+)?(re-?)?review\b/i;
const doesTheReview = /\b(do|perform|run|start)\s+(the|a)\s+(code\s+)?review\b/i;
const reviewTarget = new RegExp(String.raw`\b(PRs?|pull requests?|diffs?|commits?|branch(es)?|changes|stack|code)\b|#\d+|\/pull\/\d+|\b(?=[0-9a-f]*\d)[0-9a-f]{6,40}\b|\b[0-9a-f]{7,40}\b|${fileName.source}`, "i");

function isPath(token: string): boolean {
  return (token.includes("/") && !slashedWords.test(token)) || fileName.test(token);
}

function withoutPaths(sentence: string): string {
  return sentence.split(/\s+/).filter((token) => !isPath(token)).join(" ");
}

function asksForReview(prompt: string): boolean {
  if (ownPrompts.some((own) => own.test(prompt)) || !reviewTarget.test(prompt)) return false;
  const sentences = prompt.split(/(?<=[.!?])\s+|\n+/);
  const holdsAny = sentences.some((sentence) => holdsReview.test(sentence));
  return sentences.some((sentence) => {
    const words = withoutPaths(sentence);
    const asks = (asksReview.test(words) || doesTheReview.test(words)) && !holdsReview.test(words);
    return asks && (!holdsAny || reviewTarget.test(sentence));
  });
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
