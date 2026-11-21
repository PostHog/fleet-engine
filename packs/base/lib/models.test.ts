import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leanClaudeEnv, modelFor, modelTable, type ModelRow } from "./models.ts";

const rows: ModelRow[] = [
  { role: "lookup", work: "Find files", provider: "claude", model: "small-model", effort: "medium" },
  { role: "review", work: "Review Claude's code", provider: "codex", model: "large-model", effort: "high" },
];
const env = { HEDGE_MODELS: JSON.stringify(rows) };

test("reads the row of a role from the model table of the user's plan", () => {
  expect(modelFor("review", env)).toEqual(rows[1]!);
  expect(modelTable(env)).toEqual(rows);
});

test("refuses a role the table lacks, a missing table, and a malformed row", () => {
  expect(() => modelFor("review-codex", env)).toThrow("the model table of your AI plan has no review-codex row");
  expect(() => modelFor("lookup", {})).toThrow("run this command as hedge <command>, so it gets your model table");
  for (const provider of ["", "gemini cli", 3]) expect(() => modelTable({ HEDGE_MODELS: JSON.stringify([{ ...rows[0], provider }]) })).toThrow("HEDGE_MODELS holds a malformed row");
});

test("reads a row of any T3 provider instance", () => {
  const neon: ModelRow = { role: "survey", work: "Read docs", provider: "antigravity", model: "gemini-4-neon", effort: "high" };
  expect(modelFor("survey", { HEDGE_MODELS: JSON.stringify([...rows, neon]) })).toEqual(neon);
});

test("an empty or relative CLAUDE_CONFIG_DIR never lets the checkout under review set a Claude reviewer's env", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-claude-env-"));
  const previous = process.cwd();
  try {
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://hub.example" } }));
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://reviewed-code.example" } }));
    process.chdir(checkout);
    for (const configDir of ["", ".", "./"]) {
      expect(leanClaudeEnv(home, { CLAUDE_CONFIG_DIR: configDir }).ANTHROPIC_BASE_URL).toBe("https://hub.example");
    }
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
