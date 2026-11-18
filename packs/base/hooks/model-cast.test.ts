import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../../../src/pack/manifest.ts";
import type { AvailableSource, Profile } from "../../../src/pack/types.ts";
import { resolve } from "../../../src/reconciler/resolve.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import { hook as castTheReviewer } from "./cast-the-reviewer.ts";
import { hook as nameAModel } from "./name-a-model.ts";

const reminder = "Name a model on this Agent call: an omitted model inherits the parent model. Agent takes haiku, sonnet, opus, or fable; a row with a GPT model runs on Codex, through T3's `delegate_task`.";
const pointer = "Cast it with the model table in ~/.agents/AGENTS.md.";
const reviewReminder = "This prompt asks for a review. A review runs in a worker that did not write the code, cast from the review rows of the model table, and in the other model family when a row names it. Review the code yourself only when you were dispatched as its reviewer.";
const reviewPointer = "The table is in ~/.agents/AGENTS.md.";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const table = "## Model selection\n\n| Work | Model | Effort |\n| --- | --- | --- |\n"
  + "| **Survey**: read docs | `claude-sonnet-5-5` | high |\n| **Review** of Claude's code | `gpt-6.2-sol` | high |";
const instructions = `# Agent rules\n\nIntro.\n\n${table}\n\n# Memory\n\nOther pack rules.\n\n## About me\n\nMore rules.\n`;

let engine: AvailableSource;
beforeAll(async () => {
  const dir = join(import.meta.dir, "../../..");
  engine = { ref: { name: "engine", repo: "PostHog/fleet-engine", ref: "main" }, dir, packs: await loadPacks(dir) };
});

function renderedInstructions(models: NonNullable<Profile["overrides"]>["models"]) {
  const profile: Profile = { schema: 1, dir: "/profile", engine: { repo: "PostHog/fleet-engine", ref: "main", channel: "track" }, sources: [], packs: ["memory", "context-library"], plan: "both", settings: {}, workflows: {}, overrides: { models } };
  const file = resolve(profile, { schema: 1, role: "mac" }, [engine]).files.find((item) => item.target === ".agents/AGENTS.md");
  if (!file || !("content" in file)) throw new Error("no AGENTS.md");
  return file.content;
}

function homeWith(agentsMd: string | null) {
  const home = temp.make("model-cast-");
  if (agentsMd !== null) {
    mkdirSync(join(home, ".agents"));
    writeFileSync(join(home, ".agents/AGENTS.md"), agentsMd);
  }
  return home;
}

const event = (value: unknown) => async () => (typeof value === "string" ? value : JSON.stringify(value));
const quiet = { code: 0, stdout: "", stderr: "" };
const agentCall = (tool_input: unknown, tool_name = "Agent") => event({ hook_event_name: "PreToolUse", tool_name, tool_input });
const prompt = (text: string) => event({ hook_event_name: "UserPromptSubmit", prompt: text });
const context = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;

describe("name a model", () => {
  test.each(["Agent", "Task"])("sends a Claude %s call without a model back with the Model selection table, and nothing past it", async (tool) => {
    for (const input of [{ prompt: "find the files" }, null]) {
      expect(await nameAModel("claude", agentCall(input, tool), homeWith(instructions))).toEqual({ code: 2, stdout: "", stderr: `${reminder}\n\n${table}\n` });
    }
  });

  test("on a home the engine rendered from several packs, the bounce holds the profile's table and no pack's rules", async () => {
    const agentsMd = renderedInstructions([{ role: "review", work: "Independent assessment of changes", provider: "codex", model: "gpt-6.2-sol", effort: "high" }]);
    expect(agentsMd).toContain("# Memory");
    const result = await nameAModel("claude", agentCall({}), homeWith(agentsMd));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("| Independent assessment of changes | `gpt-6.2-sol` | high |");
    expect(result.stderr.trimEnd().split("\n").at(-1)).toStartWith("|");
    expect(result.stderr).not.toContain("# Memory");
  });

  test("keeps every row when a profile's work text spans lines or holds a pipe", async () => {
    const agentsMd = renderedInstructions([{ role: "lookup", work: "Lookups:\nfind files | logs", provider: "claude", model: "claude-haiku-5-5", effort: "medium" }]);
    const result = await nameAModel("claude", agentCall({}), homeWith(agentsMd));
    expect(result.stderr).toContain("| Lookups: find files \\| logs | `claude-haiku-5-5` | medium |");
    expect(result.stderr).toContain("| Review of code Claude wrote | `gpt-6.2-sol` | high |");
  });

  test("names the table's place when the instructions or their table are missing", async () => {
    for (const agentsMd of [null, "# Agent rules\n\nNo table.\n", "## Model selection\n\nThe table moved.\n"]) {
      expect(await nameAModel("claude", agentCall({}), homeWith(agentsMd))).toEqual({ code: 2, stdout: "", stderr: `${reminder} ${pointer}\n` });
    }
  });

  test("lets a call with a model, another tool, Codex, and a broken event through", async () => {
    const home = homeWith(instructions);
    expect(await nameAModel("claude", agentCall({ model: "sonnet" }), home)).toEqual(quiet);
    expect(await nameAModel("claude", agentCall({}, "Bash"), home)).toEqual(quiet);
    expect(await nameAModel("codex", agentCall({}), home)).toEqual(quiet);
    for (const broken of ["not json", "null", "[]", "7"]) expect(await nameAModel("claude", event(broken), home)).toEqual(quiet);
  });
});

describe("cast the reviewer", () => {
  test.each([
    "Review PR #1234 please",
    "can you re-review the diff",
    "review https://github.com/o/r/pull/9",
    "Give my branch a code review",
    "Review the last commit",
    "Review 9303a8e6889d82b058c5e7b71302fe1eb4027380",
    "Review requests.ts in this branch",
    "Review src/send.ts",
    "Review 2aa78e",
    "Review PR #12. Do not review PR #13.",
    "Review the diff and answer the review comments.",
  ])("reminds %p that a review runs cross-family, with the model table", async (text) => {
    for (const provider of ["claude", "codex"] as const) {
      const result = await castTheReviewer(provider, prompt(text), homeWith(instructions));
      expect(result.code).toBe(0);
      expect(context(result.stdout)).toEqual({ hookEventName: "UserPromptSubmit", additionalContext: `${reviewReminder}\n\n${table}` });
    }
  });

  test("on a home the engine rendered, the reminder holds a review row the profile renamed", async () => {
    const agentsMd = renderedInstructions([{ role: "review", work: "Independent assessment of changes", provider: "codex", model: "gpt-6.2-sol", effort: "high" }]);
    const result = await castTheReviewer("claude", prompt("Review PR #12"), homeWith(agentsMd));
    expect(context(result.stdout).additionalContext).toContain("| Independent assessment of changes | `gpt-6.2-sol` | high |");
    expect(context(result.stdout).additionalContext).not.toContain("# Memory");
  });

  test.each([
    "Fix the failing test",
    "What did the review say?",
    "Address the review comments on PR #123",
    "Address the review comments.",
    "Summarize the review of PR #12",
    "Summarize the code review for PR #12",
    "Respond to the code review on PR #12",
    "The bot reviewed PR #12. Apply its suggestions.",
    "Do not review this PR yet. Update the branch only.",
    "Don't review the diff, just rebase the branch",
    "Fix the review findings on this branch",
    "answer and resolve every review-bot thread on PR #12",
    "Act as the review sub-agent for PR #12",
    "You review a pull request as an independent reviewer from the other family. Work read-only.",
    "You review a pull request. Goal: <goal>",
    "Update on pull request #55: review requested",
    "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>Review PR #12 finished</task-notification>",
    "<task-notification>\n<summary>Background command \"Review PR #12\" completed</summary>\n</task-notification>",
  ])("adds nothing to %p", async (text) => {
    expect(await castTheReviewer("claude", prompt(text), homeWith(instructions))).toEqual(quiet);
  });

  test("names the table's place when the instructions are missing", async () => {
    const result = await castTheReviewer("claude", prompt("Review PR #1"), homeWith(null));
    expect(context(result.stdout).additionalContext).toBe(`${reviewReminder} ${reviewPointer}`);
  });

  test.each(["not json", "null", "[]", '{"prompt":7}'])("lets the broken event %p through", async (broken) => {
    expect(await castTheReviewer("claude", event(broken), homeWith(instructions))).toEqual(quiet);
  });
});
