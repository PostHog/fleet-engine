import { expect, test } from "bun:test";
import { t3ThreadWords } from "./proof-answers.ts";

test("only T3 Code tells which answers a person gave, so another runtime refuses to hear an answer and names the way out", async () => {
  await expect(t3ThreadWords("/nonexistent", "herdr")("t7")).rejects.toThrow("Only T3 Code records which answers a person gave in its app, and base.runtime is herdr. Record this decision as an agent decision, or run the thread in T3 Code.");
});
