import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliFixtures } from "./testing/cli.ts";
import { isolateGit, tempDirs } from "./testing/git.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());
const { hedge } = cliFixtures(temp);

async function applied(packs: string[], extra: Record<string, unknown>) {
  const home = temp.make("home-");
  const dir = temp.make("profile-");
  const profile = { schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [], packs, plan: "both", settings: {}, workflows: {}, migrations: ["picks-turn-on"], ...extra };
  const text = JSON.stringify(profile, null, 2) + "\n";
  writeFileSync(join(dir, "hedge.json"), text);
  const result = await hedge(["apply", "--profile", dir], home);
  return { home, result, unchanged: readFileSync(join(dir, "hedge.json"), "utf8") === text };
}

describe("hedge apply with a profile that still names an old pack", () => {
  test("context-library installs the library from the Memory pack, and no shared memory", async () => {
    const { home, result, unchanged } = await applied(["context-library"], { settings: { "context-library.repo": "me/notes" }, workflows: { "context-library": true } });
    expect(result.code).toBe(0);
    expect(existsSync(join(home, ".config/hedge/hooks/UserPromptSubmit/context-recall.ts"))).toBe(true);
    expect(existsSync(join(home, ".config/hedge/hooks/SessionStart/memory-index.ts"))).toBe(false);
    expect(existsSync(join(home, ".agents/guides/memory.md"))).toBe(false);
    expect(existsSync(join(home, ".agents/skills/dream"))).toBe(false);
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).not.toContain("~/.agents/memory");
    expect(unchanged).toBe(true);
  });

  test("recovery gets no hub skill and no MCP gateway", async () => {
    const { home, result, unchanged } = await applied(["recovery"], { workflows: { "provider-recovery": true } });
    expect(result.code).toBe(0);
    expect(existsSync(join(home, ".agents/skills/hedge-hub"))).toBe(false);
    expect(result.output).not.toContain("mcp-gateway");
    expect(unchanged).toBe(true);
  });
});
