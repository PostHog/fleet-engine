import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, fakeModel, graded, markPanel, reviewHead, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lines = (count: number, word: string) => Array.from({ length: count }, (_, index) => `${word} ${index}`).join("\n") + "\n";
const block = (body: string) => /<!-- hedge-proof-receipt[\s\S]*?<!-- \/hedge-proof-receipt -->/.exec(body)?.[0] ?? "";
const tableIn = (text: string) => text.split("\n").filter((line) => line.startsWith("| PR | Review rounds") || line.startsWith("| example/product#42 | ") && line.split(" | ").length === 4);

async function grownPr() {
  const pr = await checkout();
  const first = await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical")}` });
  await reviewHead(pr);
  writeFileSync(join(pr.repository, "feature.test.ts"), lines(4, "check"));
  writeFileSync(join(pr.repository, "README.md"), lines(2, "explain"));
  await pr.git("add", "feature.test.ts", "README.md");
  await pr.commit("feature.ts", lines(25, "greet"));
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", first)).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.hedge("review-finish", "--round", "2", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  markPanel(pr, "2");
  await pr.hedge("require", "--kinds", "ui-walk");
  await pr.hedge("gap", "--kind", "ui-walk", "--reason", "The greeting has no page");
  await agentAccepts(pr, "ui-walk");
  return pr;
}

const agentAccepts = (pr: Checkout, kind: string) => pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", kind, "--pr", "example/product#42",
  "--question", `Accept the ${kind} gap?`, "--answer", "Accept it", "--rejected", "Run it", "--reason", "Nothing to walk");

const decisionId = (pr: Checkout) => pr.decide("list", "--pr", "example/product#42").then(({ output }) => /\[(d-[0-9a-f]+)\]/.exec(output)![1]!);

test("the receipt and the end-of-run report show one table: the review rounds, production lines at the first review and at HEAD, and each skipped proof with who accepted it", async () => {
  const pr = await grownPr();
  const id = await decisionId(pr);
  expect((await pr.hedge("gate")).code).toBe(0);

  const table = [
    "| PR | Review rounds | Production lines | Skipped proofs |",
    `| example/product#42 | 2 rounds | 10 → 25 (×2.5); tests 0 → 4; docs 0 → 2 | ui-walk: The greeting has no page (🤖 agent ${id}) |`,
  ];
  expect((await pr.hedge("receipt")).code).toBe(0);
  expect(tableIn(block(pr.githubBody()))).toEqual(table);
  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)).toEqual(table);
});

test("a final read counts apart from the rounds, and the final lines are the lines at HEAD", async () => {
  const pr = await grownPr();
  const reviewed = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.ts", lines(30, "greet"));
  expect((await pr.hedge("review-start", "--scope", "final", "--base", reviewed)).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.hedge("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toContain(
    "| 2 rounds, 1 final read | 10 → 30 (×3.0); tests 0 → 4; docs 0 → 2 |");
});

test("the table holds a PR once a gate ran at its HEAD", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)).toEqual([]);
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → 10 (×1.0) | none |");
});

test("the lines count from where the PR branched from the base GitHub reports, so a stale local base ref does not count the base's own changes", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  const stale = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.advanceBase("base.ts", lines(50, "base"));
  const fresh = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.git("merge", "-q", "--no-edit", "main");
  writeFileSync(join(pr.home, "../github/base-sha"), fresh);
  await pr.git("update-ref", "refs/remotes/origin/main", stale);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → 10 (×1.0) | none |");
});

async function staleBaseRef(pr: Checkout, githubBase: (fresh: string) => string) {
  const stale = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.advanceBase("base.ts", lines(50, "base"));
  const fresh = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.git("merge", "-q", "--no-edit", "main");
  writeFileSync(join(pr.home, "../github/base-sha"), githubBase(fresh));
  await pr.git("update-ref", "refs/remotes/origin/main", stale);
}

test("the review tier counts from the base GitHub reports too, so it agrees with the table", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical", "low") });
  await staleBaseRef(pr, (fresh) => fresh);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "REVIEWER", "No findings.\n");

  expect((await pr.hedge("review")).output).toContain("review tier: read: merge-risk grade low, 10 authored production lines");
});

test("a base GitHub reports that this checkout cannot fetch leaves the HEAD lines unknown, not counted from a stale ref", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await staleBaseRef(pr, () => "f".repeat(40));
  await pr.git("config", "protocol.allow", "never");
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → unknown | none |");
});

test("round 1 counts from where it was reviewed, so a lower PR that merged into the base later does not count", async () => {
  const pr = await checkout();
  await pr.commit("lower.ts", lines(50, "lower"));
  const lower = await pr.commit("lower.ts", lines(100, "lower"));
  const main = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.git("update-ref", "refs/remotes/origin/main", lower);
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.git("update-ref", "refs/remotes/origin/main", main);
  await pr.advanceBase("lower.ts", lines(100, "lower"));
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.ts", lines(20, "greet"));
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → 20 (×2.0) | none |");
});

test("a renamed file counts its changed lines, not its whole content twice", async () => {
  const pr = await checkout();
  await pr.advanceBase("engine.ts", lines(50, "engine"));
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.git("mv", "engine.ts", "motor.ts");
  await pr.git("commit", "-q", "-m", "Rename the feature");
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → 10 (×1.0) | none |");
});

test("a gate saved before the table existed reads as not measured, not as no review", async () => {
  const pr = await grownPr();
  expect((await pr.hedge("gate")).code).toBe(0);
  const head = await pr.git("rev-parse", "HEAD");
  const saved = join(pr.pullRequest, "gate-outcome", `${head}.json`);
  const outcome = JSON.parse(readFileSync(saved, "utf8"));
  delete outcome.gate.summary.growth;
  writeFileSync(saved, JSON.stringify(outcome));

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toContain("| example/product#42 | not measured; run hedge proof gate | not measured |");
});

test("a reason with a carriage return or an escaped pipe stays in its cell", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "ui-walk");
  await pr.hedge("gap", "--kind", "ui-walk", "--reason", "No page\ryet a\\|b");
  await agentAccepts(pr, "ui-walk");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toContain("| ui-walk: No page yet a\\\\\\|b (🤖 agent ");
});
