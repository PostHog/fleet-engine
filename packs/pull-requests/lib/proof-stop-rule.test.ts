import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

test("the latest finished review decides: a final read that finds a production bug the PR introduced buys the next round", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, ["- minor | feature.ts:1 | the word reads oddly | anchor: greet 0"], ["1. fixed: the word reads plainly"]);
  await pr.commit("feature.ts", lines(11, "greet"));
  expect((await pr.hedge("review-start", "--scope", "final", "--base", reviewed)).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "- major | feature.ts:11 | the new greeting drops the name | anchor: greet 10\n");
  expect((await pr.hedge("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the greeting keeps the name\n");
  expect((await pr.hedge("respond", "--round", "final-1", "responses.md")).code).toBe(0);
  await pr.commit("feature.ts", lines(12, "greet"));

  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
});

test("a first review that saw no production lines never asks for a sanity pass, as the table shows no ratio for it", async () => {
  const pr = await checkout();
  await pr.commit("feature.test.ts", lines(10, "check"));
  pr.pullRequestState({ body: graded("non-critical") });
  expect((await pr.hedge("review-start", "--scope", "full")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "- major | the check never runs | anchor: check 0\n");
  expect((await pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the check runs\n");
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
  const reviewed = await pr.git("rev-parse", "HEAD");
  await pr.commit("helper.ts", lines(5, "help"));

  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
});

test("the first panel after a clean single review still runs, since the gate needs it", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, ["- minor | feature.ts:1 | the word reads oddly | anchor: greet 0"], ["1. rejected: it is the domain term"]);
  fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: feature.ts\n");
  await pr.hedge("require", "--none", "--reason", "docs only", "--author", "claude");

  expect((await pr.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await expect(pr.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("Round 2 found no bug in production code");
});

test("[base] counts only where a field starts with it, and the site comes from the location field alone", async () => {
  for (const finding of [
    "- major | feature.ts:2 | the lookup reads ranges[base] past its end | anchor: const range = ranges[base]",
    "- major | the greeting drops the last name, as feature.test.ts:3 shows",
    "- feature.ts:2 | major | Correctness | the greeting drops the last name | keep it | anchor: return flags | [base].length",
  ]) {
    const pr = await checkout();
    const reviewed = await firstRound(pr, [finding], ["1. fixed: the greeting keeps it"]);
    await pr.commit("feature.ts", lines(11, "greet"));
    expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
  }
});

test("an ungraded finding, a TESTS item without a file, and a major on a docs path with spaces, quoted or not, buy no round", async () => {
  for (const [finding, response] of [
    ["- major | `docs/User Guide.md:12` | the guide names the old flag", "1. fixed: the guide names the new flag"],
    ["- major | docs/User Guide.md:12 | the guide names the old flag", "1. fixed: the guide names the new flag"],
    ["- No findings, the greeting is right.", "1. fixed: the greeting reads right"],
    ["TESTS:\n- the suite mocks the clock", "1. fixed: the suite uses a real clock"],
  ] as const) {
    const pr = await checkout();
    const reviewed = await firstRound(pr, [finding], [response]);
    await pr.commit("feature.ts", lines(11, "greet"));
    await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(stops);
  }
});

test("the stop rule speaks before the scope of the next round, and names the question that gets the user's override", async () => {
  const pr = await checkout();
  await firstRound(pr, ["- minor | feature.ts:1 | the word reads oddly | anchor: greet 0"], ["1. rejected: it is the domain term"]);

  await expect(pr.hedge("review-start", "--scope", "full")).rejects.toThrow(stops);
  await expect(pr.hedge("review-start", "--scope", "full")).rejects.toThrow(`Question: "Run one more review round? example/product#42: ${stops}." Options: "Run one more round", "Stop here"`);
});

test("the user's override waits for a sanity pass too, and only the latest pass counts", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, ["- major | feature.ts:2 | the greeting drops the last name | anchor: greet 1"], ["1. fixed: the greeting keeps it"]);
  await pr.commit("feature.ts", lines(30, "greet"));
  expect((await pr.hedge("sanity", "--verdict", "justified", "--reason", "The fix needs its own parser")).code).toBe(0);
  pr.clock.now = new Date("2026-10-25T12:05:00Z");
  await pr.commit("feature.ts", lines(21, "greet"));
  expect((await pr.hedge("sanity", "--verdict", "cut", "--reason", "The parser went back to the base")).code).toBe(0);
  await pr.commit("feature.ts", lines(25, "greet"));

  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("Production lines grew from 10 at round 1 to 25 at HEAD");
  pr.choose("Run one more round", `Run one more review round? example/product#42: ${stops}.`);
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed, "--override", `2026-10-25 "Run one more round"`)).rejects.toThrow("Production lines grew from 10 at round 1 to 25 at HEAD");
});

test("a sanity pass needs a reason without figures, and a half-written pass file is skipped", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, ["- major | feature.ts:2 | the greeting drops the last name | anchor: greet 1"], ["1. fixed: the greeting keeps it"]);
  await pr.commit("feature.ts", lines(21, "greet"));

  await expect(pr.hedge("sanity", "--verdict", "cut", "--reason", " ")).rejects.toThrow("--reason needs why");
  await expect(pr.hedge("sanity", "--verdict", "cut", "--reason", "cut 40% of the growth")).rejects.toThrow("sanity reason");
  mkdirSync(join(pr.pullRequest, "sanity"), { recursive: true });
  writeFileSync(join(pr.pullRequest, "sanity", `${await pr.git("rev-parse", "HEAD")}.json.1234`), "{\"commit\":");
  expect((await pr.hedge("sanity", "--verdict", "justified", "--reason", "The fix needs its own parser")).code).toBe(0);
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
});

test("a pipe inside code in a finding stays in its field, so a docs file buys no round and a production bug still does", async () => {
  const docs = await checkout();
  const docsReviewed = await firstRound(docs, ["- major | `docs/A|B.md:7` | the page names the wrong flag | anchor: greet 0"], ["1. fixed: the page names the flag"]);
  await docs.commit("feature.ts", lines(11, "greet"));
  await expect(docs.hedge("review-start", "--scope", "fixes", "--base", docsReviewed)).rejects.toThrow(stops);

  const code = await checkout();
  const codeReviewed = await firstRound(code, ["- major | feature.ts:2 | `flags | [base]` drops the last flag | anchor: greet 1"], ["1. fixed: the flags keep it"]);
  await code.commit("feature.ts", lines(11, "greet"));
  expect((await code.hedge("review-start", "--scope", "fixes", "--base", codeReviewed)).code).toBe(0);
});

test("past twice the first lines with GitHub's base commit missing here, the next round waits for the fetch, not a skipped sanity pass", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, ["- major | feature.ts:2 | the greeting drops the last name | anchor: greet 1"], ["1. fixed: the greeting keeps it"]);
  await pr.commit("feature.ts", lines(21, "greet"));
  pr.pullRequestState({ baseSha: "0123456789abcdef0123456789abcdef01234567" });

  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(
    "Hedge cannot count the production lines at HEAD, since the base commit 0123456 that GitHub reports is not in this checkout. Run git fetch origin main, then run this command again");
});

test("a [base] marker on the wrapped line of a finding still keeps it from buying a round", async () => {
  const pr = await checkout();
  const reviewed = await firstRound(pr, ["- major | feature.ts:2 |", "  [base] the base drops an empty name too, base feature.ts:2 | anchor: greet 1"], ["1. fixed: an empty name is kept now"]);
  await pr.commit("feature.ts", lines(11, "greet"));

  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(stops);
});

test("a sanity reason the receipt would read as a figure is refused when it is recorded", async () => {
  const pr = await checkout();
  await firstRound(pr, ["- major | feature.ts:2 | the greeting drops the last name | anchor: greet 1"], ["1. fixed: the greeting keeps it"]);
  await pr.commit("feature.ts", lines(21, "greet"));

  await expect(pr.hedge("sanity", "--verdict", "justified", "--reason", "Compare 48   213 rows")).rejects.toThrow("looks like a production figure");
});
