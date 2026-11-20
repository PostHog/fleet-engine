import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, fakeModel, graded, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lines = (count: number, word: string) => Array.from({ length: count }, (_, index) => `${word} ${index}`).join("\n") + "\n";

async function firstRound(pr: Checkout, findings: string[], responses: string[]) {
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  expect((await pr.hedge("review-start", "--scope", "full")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), findings.join("\n") + "\n");
  expect((await pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  writeFileSync(join(pr.repository, "responses.md"), responses.join("\n") + "\n");
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
  return pr.git("rev-parse", "HEAD");
}

const stops = "Round 1 found no bug in production code that the PR introduced, so the review loop stops";

test("a round whose findings are only tests, wording, base behaviour or rejected buys no other round, and the user's override still runs one", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, [
    "- minor | feature.ts:1 | the word reads oddly | anchor: greet 0",
    "- major | feature.test.ts:3 | the test asserts nothing | anchor: check",
    "- major | feature.ts:2 | [base] the base drops an empty name too, base feature.ts:2 | anchor: greet 1",
    "- blocker | feature.ts:4 | the greeting loses the name | anchor: greet 3",
    "TESTS:",
    "- feature.test.ts:1 mocks the clock",
  ], ["2. fixed: the test asserts the greeting", "3. fixed: an empty name is kept now", "4. rejected: the name is kept on line 5", "5. fixed: the test uses a real clock"]);
  await pr.commit("feature.test.ts", lines(3, "check"));

  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(stops);
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed, "--agent", "one more look")).rejects.toThrow(stops);
  pr.choose("Run one more round", "Run one more review round? example/product#42: round 1 found no bug in production code that the PR introduced.");
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed, "--override", `2026-10-25 "Run one more round"`)).code).toBe(0);
});

test("a fixed blocker or major in production code that the PR introduced buys the next round", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, ["- major | feature.ts:2 | the greeting drops the last name | anchor: greet 1"], ["1. fixed: the greeting keeps it"]);
  await pr.commit("feature.ts", lines(11, "greet"));

  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
});

test("past twice the production lines of the first review, the next round waits for a sanity pass at HEAD, which the end table shows", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, ["- major | feature.ts:2 | the greeting drops the last name | anchor: greet 1"], ["1. fixed: the greeting keeps it"]);
  await pr.commit("feature.ts", lines(21, "greet"));

  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(
    "Production lines grew from 10 at round 1 to 21 at HEAD, past twice the first. Before another round, cut the PR back to base behaviour, or justify the growth: hedge proof sanity --verdict cut|justified --reason '<why>'");
  expect((await pr.hedge("sanity", "--verdict", "justified", "--reason", "The fix needs its own parser")).code).toBe(0);
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).code).toBe(0);

  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.hedge("review-finish", "--round", "2", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  const report = (await pr.decide("report", "--pr", "example/product#42")).output.split("\n");
  expect(report.filter((line) => line.startsWith("| PR | Review rounds") || line.startsWith("| example/product#42 | 2 rounds"))).toEqual([
    "| PR | Review rounds | Production lines | Sanity pass | Skipped proofs |",
    "| example/product#42 | 2 rounds | 10 → 21 (×2.1) | justified at HEAD: The fix needs its own parser | none |",
  ]);
});

test("a sanity pass covers the lines it saw: a later head that grows again waits for a new one, and a cut back under twice the first needs none", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, ["- major | feature.ts:2 | the greeting drops the last name | anchor: greet 1"], ["1. fixed: the greeting keeps it"]);
  await pr.commit("feature.ts", lines(21, "greet"));
  await pr.hedge("sanity", "--verdict", "justified", "--reason", "The fix needs its own parser");
  await pr.commit("feature.ts", lines(24, "greet"));
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("Production lines grew from 10 at round 1 to 24 at HEAD");

  await pr.commit("feature.ts", lines(14, "greet"));
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
});

test("the reviewer reads that behaviour the base has too is no blocker, and that each finding says whether the PR introduced it", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.\n");
  expect((await pr.hedge("review", "--single")).code).toBe(0);

  expect(reviewer.prompts().at(-1)).toContain("Behaviour that the base branch has too is not a blocker or a major: mark such a finding minor, start its problem with [base], and cite the base line. Every other finding is one the PR introduced.");
});
