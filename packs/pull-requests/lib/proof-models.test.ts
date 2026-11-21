import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { ModelRow } from "../../base/lib/models.ts";
import { askModel, type Role } from "./proof-models.ts";

const row: ModelRow = { role: "review", work: "Review", provider: "claude", model: "review-model", effort: "high" };

test("a row of a T3 provider that has no CLI here fails with a cause that names the row", async () => {
  const neon = { ...row, provider: "antigravity", model: "gemini-4-neon" };
  expect(await askModel("reviewer", neon, { prompt: "Review it", cwd: tmpdir() }, { PATH: process.env.PATH }, 10_000)).toEqual({
    ok: false, cause: "hedge proof runs its models with the claude or codex CLI, and the review row names provider antigravity. Give that row a Claude or Codex model.", model: "gemini-4-neon",
  });
});

test.each<[Role, string]>([["judge", "HEDGE_PROOF_JUDGE"], ["reviewer", "HEDGE_PROOF_REVIEWER"], ["arbiter", "HEDGE_REVIEW_ARBITER"], ["eval-judge", "HEDGE_PROOF_EVAL_JUDGE"]])(
  "a %s session starts without the lane's T3 thread id, and the lane keeps it",
  async (role, command) => {
    const env = { PATH: process.env.PATH, T3CODE_THREAD_ID: "mcp:lane", [command]: 'cat >/dev/null; echo "thread=${T3CODE_THREAD_ID:-none}"' };
    expect(await askModel(role, row, { prompt: "Judge it", cwd: tmpdir() }, env, 10_000)).toMatchObject({ ok: true, text: "thread=none" });
    expect(env.T3CODE_THREAD_ID).toBe("mcp:lane");
  },
);
