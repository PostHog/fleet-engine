import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRow } from "../../base/lib/models.ts";
import { askModel, type Role } from "./proof-models.ts";

const row: ModelRow = { role: "review", work: "Review", provider: "claude", model: "review-model", effort: "high" };

test.each<[Role, string]>([["judge", "HEDGE_PROOF_JUDGE"], ["reviewer", "HEDGE_PROOF_REVIEWER"], ["arbiter", "HEDGE_REVIEW_ARBITER"], ["eval-judge", "HEDGE_PROOF_EVAL_JUDGE"]])(
  "a %s session starts without the lane's T3 thread id, and the lane keeps it",
  async (role, command) => {
    const env = { PATH: process.env.PATH, T3CODE_THREAD_ID: "mcp:lane", [command]: 'cat >/dev/null; echo "thread=${T3CODE_THREAD_ID:-none}"' };
    expect(await askModel(role, row, { prompt: "Judge it", cwd: tmpdir() }, env, 10_000)).toMatchObject({ ok: true, text: "thread=none" });
    expect(env.T3CODE_THREAD_ID).toBe("mcp:lane");
  },
);

test("a lean Claude arbiter gets the key helper of the user's settings, and runs today's command when the settings have none", async () => {
  const root = mkdtempSync(join(tmpdir(), "hedge-arbiter-key-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bun
await Bun.stdin.text();
console.log(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ argv: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL }) }));
`, { mode: 0o755 });
    const env = { HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const seen = async () => {
      const answer = await askModel("arbiter", row, { prompt: "Reply with the single word ok.", cwd: root }, env, 10_000);
      if (!answer.ok) throw new Error(answer.cause);
      return JSON.parse(answer.text) as { argv: string[]; base?: string };
    };
    const today = ["-p", "--model", "review-model", "--effort", "high", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--tools", "", "--permission-mode", "dontAsk"];
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "fake-proxy-key-helper", env: { ANTHROPIC_BASE_URL: "https://hub.example" } }));
    expect(await seen()).toEqual({ argv: ["--settings", '{"apiKeyHelper":"fake-proxy-key-helper"}', ...today], base: "https://hub.example" });
    const replaced = await askModel("arbiter", row, { prompt: "Judge it", cwd: root }, { ...env, HEDGE_REVIEW_ARBITER: 'cat >/dev/null; echo "$0 $*"' }, 10_000);
    expect(replaced).toMatchObject({ ok: true, text: "sh" });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://hub.example" } }));
    expect(await seen()).toEqual({ argv: today, base: "https://hub.example" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
