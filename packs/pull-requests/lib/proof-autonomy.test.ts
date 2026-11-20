import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, fakeModel, finishRound, graded, reviewHead, settings, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const decideAtEnd = (pr: Checkout) => { pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.autonomy": "end" }); };

async function escalatedRound(pr: Checkout) {
  const head = await pr.commit("feature.txt", "new\n");
  for (const round of ["1", "2"]) {
    await pr.hedge("review-start", ...(round === "1" ? ["--scope", "full"] : ["--scope", "fixes", "--base", head]));
    await finishRound(pr, round);
  }
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo 'ESCALATE: Round 2 undoes the rename round 1 asked for.'";
  return ["review-start", "--scope", "fixes", "--base", head];
}

test("on end, an escalated round tells the agent to decide it alone, even on a critical PR, and the decision runs the round", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("critical", "medium") });
  const third = await escalatedRound(pr);

  await expect(pr.hedge(...third)).rejects.toThrow("The arbiter escalates: Round 2 undoes the rename round 1 asked for. Decide the round yourself: run this command again with --agent '<your reason>'");
  await expect(pr.hedge(...third)).rejects.toThrow("the user reads it in the end table of hedge decision report");
  await expect(pr.hedge(...third)).rejects.not.toThrow("Ask the user with your question tool");

  expect((await pr.hedge(...third, "--agent", "Round 1 asked for the rename as a nit")).code).toBe(0);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/3/round.json"), "utf8"))).toMatchObject({ decision: { mark: "🤖" } });
});

test("on end, an ungraded PR still sends an escalated round to the user", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  const third = await escalatedRound(pr);

  await expect(pr.hedge(...third)).rejects.toThrow("The arbiter escalates: Round 2 undoes the rename round 1 asked for. Ask the user with your question tool");
  expect(existsSync(join(pr.pullRequest, "reviews/3"))).toBe(false);
});

test("on ask, an escalated round asks the user as before", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("critical", "medium") });
  const third = await escalatedRound(pr);

  await expect(pr.hedge(...third)).rejects.toThrow("Ask the user with your question tool");
});

test("on end, a gap prints the agent's own decision, and the ledger takes it", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "new\n");

  const gap = await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access");
  expect(gap.output).toContain(`Decide the gap yourself: run hedge decision record --mark 🤖 --class proof-gap --kind prod-shape --pr example/product#42 --question "Accept the prod-shape gap? example/product#42: No production read access" --answer "Accept the gap" --rejected "Keep the gap open" --reason '<your reason>'`);
  expect(gap.output).toContain("The user reads it in the end table of hedge decision report");
  expect(gap.output).not.toContain("Ask the user with your question tool");

  const recorded = await pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#42", "--question", "Accept the prod-shape gap? example/product#42: No production read access", "--answer", "Accept the gap", "--rejected", "Keep the gap open", "--reason", "The change reads no stored rows");
  expect(recorded.code).toBe(0);
  expect((await pr.decide("list", "--class", "proof-gap")).output).toContain("🤖 **Accept the prod-shape gap? example/product#42: No production read access** Accept the gap");
});

test("on end, a panel gap, any gap on a one-way door, and a product gap on a critical PR still go to the user", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "new\n");

  expect((await pr.hedge("gap", "--kind", "panel", "--reason", "A docs-only lane")).output).toContain("Ask the user with your question tool");
  pr.pullRequestState({ body: graded("non-critical").replace("two-way door", "one-way door") });
  expect((await pr.hedge("gap", "--kind", "post-deploy-watch", "--reason", "No dashboard yet")).output).toContain("Ask the user with your question tool");
  pr.pullRequestState({ body: graded("critical", "high") });
  expect((await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access")).output).toContain("Ask the user with your question tool");
  expect((await pr.hedge("gap", "--kind", "post-deploy-watch", "--reason", "No dashboard yet")).output).toContain("Decide the gap yourself");
});

test("on end, the gate tells the agent to decide an open judge gap alone", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));
  await pr.hedge("gap", "--kind", "judge", "--reason", "The judge reads feature.txt as code");

  const gate = await pr.hedge("gate");
  expect(gate.code).not.toBe(0);
  expect(gate.output).toContain("judge gap: not accepted: The judge reads feature.txt as code. Decide the gap yourself: run hedge decision record --mark 🤖 --class proof-gap --kind judge --pr example/product#42");
});
