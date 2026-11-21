import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate, templatesDir } from "./templates.ts";
import type { ModelRow, Plan } from "../../../src/pack/types.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import { herdrAdapter } from "./adapter.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const models: ModelRow[] = [
  { role: "implementation", work: "Implementation", provider: "claude", model: "claude-big", effort: "high" },
  { role: "review", work: "Review", provider: "codex", model: "gpt-small", effort: "high" },
];

const plan = (packs: string[], rows = models) => ({ packs: packs.map((name) => ({ name, source: "engine", ref: "main", available: true })), models: rows }) as unknown as Plan;

function setup() {
  const home = temp.make("home-");
  return { home, adapter: herdrAdapter({ accountHome: async () => home }), templates: () => (existsSync(join(home, templatesDir)) ? readdirSync(join(home, templatesDir)).sort() : []) };
}

test("with the Herdr pack on, apply writes one template for each model row, and a second apply changes nothing", async () => {
  const { home, adapter, templates } = setup();
  const first = await adapter.apply(plan(["herdr"]), { home, dryRun: false, adopt: [] });
  expect(first.actions.map((action) => [action.target, action.operation])).toEqual([[`${templatesDir}/hedge-implementation.md`, "create"], [`${templatesDir}/hedge-review.md`, "create"]]);
  expect(templates()).toEqual(["hedge-implementation.md", "hedge-review.md"]);
  expect(readFileSync(join(home, templatesDir, "hedge-review.md"), "utf8")).toBe(renderTemplate(models[1]!));
  expect((await adapter.apply(plan(["herdr"]), { home, dryRun: false, adopt: [] })).actions).toEqual([]);
});

test("apply removes the Hedge templates that left the model table, or all of them once the pack is off, and keeps your own", async () => {
  const { home, adapter, templates } = setup();
  await adapter.apply(plan(["herdr"]), { home, dryRun: false, adopt: [] });
  writeFileSync(join(home, templatesDir, "reviewer.md"), "---\ncommand: pi\n---\n");
  const narrowed = await adapter.apply(plan(["herdr"], models.slice(0, 1)), { home, dryRun: false, adopt: [] });
  expect(narrowed.actions).toEqual([{ target: `${templatesDir}/hedge-review.md`, operation: "remove" }]);
  expect(templates()).toEqual(["hedge-implementation.md", "reviewer.md"]);
  await adapter.apply(plan([]), { home, dryRun: false, adopt: [] });
  expect(templates()).toEqual(["reviewer.md"]);
});

test("a dry run reports the templates and writes nothing, and a machine without the pack is left alone", async () => {
  const { home, adapter, templates } = setup();
  expect((await adapter.apply(plan(["herdr"]), { home, dryRun: true, adopt: [] })).actions).toHaveLength(2);
  expect(templates()).toEqual([]);
  expect(await adapter.apply(plan(["slack"]), { home, dryRun: false, adopt: [] })).toEqual({ actions: [], findings: [] });
});

test("apply leaves a linked templates folder alone, and says why", async () => {
  const { home, adapter, templates } = setup();
  mkdirSync(join(home, "elsewhere"));
  mkdirSync(join(home, ".config/herdr-core"), { recursive: true });
  Bun.spawnSync(["ln", "-s", join(home, "elsewhere"), join(home, templatesDir)]);
  const result = await adapter.apply(plan(["herdr"]), { home, dryRun: false, adopt: [] });
  expect(result.findings.map((finding) => finding.id)).toEqual(["herdr:link"]);
  expect(templates()).toEqual([]);
});
