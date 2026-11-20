import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, graded, markPanel, reviewHead, type Checkout } from "./proof-testing.ts";

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
