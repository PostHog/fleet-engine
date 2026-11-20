import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIn } from "./pr-ci.ts";
import { diffSize } from "./proof-checkout.ts";
import { checkout, cleanFixtures, graded, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lines = (count: number, word: string) => Array.from({ length: count }, (_, index) => `${word} ${index}`).join("\n") + "\n";
const block = (body: string) => /<!-- hedge-proof-receipt[\s\S]*?<!-- \/hedge-proof-receipt -->/.exec(body)?.[0] ?? "";
const rendered = (row: string) => [...Bun.markdown.html(`| a | b | c | d |\n| --- | --- | --- | --- |\n${row}\n`).matchAll(/<td>([\s\S]*?)<\/td>/g)].map((match) => match[1]!);
const tableIn = (text: string) => text.split("\n").filter((line) => line.startsWith("| PR | Review rounds") || line.startsWith("| example/product#42 | ") && line.split(" | ").length === 4);

async function reviewHead(pr: Checkout) {
  expect((await pr.hedge("review-start", "--scope", "full")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
}

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
  await pr.hedge("gate");

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

test("a second remote of the same repository with a stale base does not count the base's later work as the PR's", async () => {
  const pr = await checkout();
  const fork = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.git("remote", "add", "hedge-base", "https://github.com/example/product.git");
  await pr.git("update-ref", "refs/remotes/hedge-base/main", fork);
  await pr.advanceBase("base.ts", lines(50, "landed"));
  await pr.git("merge", "-q", "--no-edit", "refs/remotes/origin/main");
  await pr.commit("feature.ts", lines(3, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | 3 at HEAD | none |");
});

test("a stale base ref counts from the base commit GitHub reports, so the base's later work is not the PR's", async () => {
  const pr = await checkout();
  const fork = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.advanceBase("base.ts", lines(50, "landed"));
  const landed = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.git("merge", "-q", "--no-edit", landed);
  await pr.commit("feature.ts", lines(3, "greet"));
  await pr.git("update-ref", "refs/remotes/origin/main", fork);
  pr.pullRequestState({ body: graded("non-critical"), baseSha: landed });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | 3 at HEAD | none |");
});

test("a second remote whose base holds commits GitHub's base does not leaves the fork point where GitHub puts it", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(3, "greet"));
  await pr.git("remote", "add", "hedge-base", "https://github.com/example/product.git");
  await pr.git("update-ref", "refs/remotes/hedge-base/main", "HEAD");
  await pr.advanceBase("base.ts", lines(50, "landed"));
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | 3 at HEAD | none |");
});

test("a checkout without the base commit GitHub reports counts unknown, not from a stale base ref", async () => {
  const pr = await checkout();
  const fork = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.advanceBase("base.ts", lines(50, "landed"));
  await pr.git("merge", "-q", "--no-edit", "refs/remotes/origin/main");
  await pr.commit("feature.ts", lines(3, "greet"));
  await pr.git("update-ref", "refs/remotes/origin/main", fork);
  pr.pullRequestState({ body: graded("non-critical"), baseSha: "0123456789abcdef0123456789abcdef01234567" });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  expect((await pr.hedge("gate")).output).toContain("growth: unknown at HEAD, since the base commit 0123456 that GitHub reports is not in this checkout. Run git fetch origin 0123456789abcdef0123456789abcdef01234567, then hedge proof gate again");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | unknown at HEAD | none |");
});

test("a reason with pipes and a run of spaces inside code renders in one cell, with who accepted it", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "ui-walk");
  await pr.hedge("gap", "--kind", "ui-walk", "--reason", "`a\\|b` is not `a|b`, and `printf 'a  b'` keeps\nits spaces");
  await agentAccepts(pr, "ui-walk");
  await pr.hedge("gate");

  const row = tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]!;
  const cells = rendered(row);
  expect(cells).toHaveLength(4);
  expect(cells[3]).toStartWith("ui-walk: <code>a|b</code> is not <code>a|b</code>, and <code>printf 'a  b'</code> keeps its spaces (🤖 agent ");
});

test("a count where git warns, as when it skips rename detection, reads unknown, not as whole files added and removed", async () => {
  const pr = await checkout();
  await pr.advanceBase("first.ts", lines(20, "first"));
  await pr.advanceBase("second.ts", lines(20, "second"));
  await pr.git("merge", "-q", "--no-edit", "refs/remotes/origin/main");
  await pr.git("config", "diff.renameLimit", "1");
  await pr.git("mv", "first.ts", "moved-first.ts");
  await pr.git("mv", "second.ts", "moved-second.ts");
  writeFileSync(join(pr.repository, "moved-first.ts"), lines(19, "first") + "edited\n");
  await pr.git("add", "moved-first.ts");
  await pr.commit("moved-second.ts", lines(19, "second") + "edited\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | unknown at HEAD | none |");
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

  const reported = tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1];
  expect(reported).toContain("| ui-walk: No page yet a\\\\\\|b (🤖 agent ");
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical")}` });
  expect((await pr.hedge("receipt")).code).toBe(0);
  expect(tableIn(block(pr.githubBody()))[1]).toBe(reported);
});

test("a rename counts its deleted lines on the old path and its added lines on the new one", async () => {
  const pr = await checkout();
  await pr.advanceBase("engine.ts", lines(50, "engine"));
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.git("mv", "engine.ts", "engine.test.ts");
  await pr.commit("engine.test.ts", lines(40, "engine"));
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → 20 (×2.0) | none |");
});

test("a PR gated before any review shows its lines at HEAD, tests and docs apart", async () => {
  const pr = await checkout();
  writeFileSync(join(pr.repository, "README.md"), lines(2, "explain"));
  await pr.git("add", "README.md");
  await pr.commit("feature.test.ts", lines(4, "check"));
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | 0 at HEAD; tests 4; docs 2 | none |");
});

test("the receipt keeps the escapes its guard adds to a reason, so emphasis and links stay literal", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical")}` });
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "ui-walk");
  await pr.hedge("gap", "--kind", "ui-walk", "--reason", "Walk it *later* with [the plan](https://plan.example)");
  await agentAccepts(pr, "ui-walk");
  await pr.hedge("gate");
  expect((await pr.hedge("receipt")).code).toBe(0);

  const cells = rendered(tableIn(block(pr.githubBody()))[1]!);
  expect(cells[3]).toStartWith("ui-walk: Walk it *later* with [the plan](https://plan.example) (🤖 agent ");
  expect(cells[3]).not.toContain("<a ");
  expect(cells[3]).not.toContain("<em>");
});

test("the receipt guard reads a reason the way the table prints it, so a line break cannot split a figure past it", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical")}` });
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "ui-walk");
  await pr.hedge("gap", "--kind", "ui-walk", "--reason", "Read 48 \r\n\r\n 213 rows");
  await agentAccepts(pr, "ui-walk");
  await pr.hedge("gate");

  const receipt = await pr.hedge("receipt");
  expect(receipt.code).toBe(2);
  expect(receipt.output).toStartWith("receipt refused: the gap reason of ui-walk looks like a production figure");
});

test("a receipt without a gate at HEAD shows no end table row, as the report shows none", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical")}` });
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  expect((await pr.hedge("receipt")).code).toBe(0);

  expect(tableIn(block(pr.githubBody()))).toEqual([]);
  expect(block(pr.githubBody())).toContain("**End table:** no gate at HEAD yet. Run hedge proof gate, then hedge proof receipt.");
  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)).toEqual([]);
});

test("a gate after the PR merged counts from the base commit GitHub reports for it, the base before the merge", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  await mergeIntoMain(pr);
  await pr.hedge("gate", "--landed");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → 10 (×1.0) | none |");
});

test("a gate after the PR merged into another base reads unknown when that base holds HEAD", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  await pr.git("update-ref", "refs/remotes/origin/parent", "HEAD");
  pr.pullRequestState({ base: "parent", baseSha: await pr.git("rev-parse", "HEAD"), merged: true });
  await pr.hedge("gate", "--landed");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | unknown at HEAD | none |");
});

test("a gate after the PR merged counts the review that finished after the last gate before it", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  await reviewHead(pr);
  await mergeIntoMain(pr);
  await pr.hedge("gate", "--landed");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → 10 (×1.0) | none |");
});

async function mergeIntoMain(pr: Checkout) {
  const before = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.git("checkout", "-q", "main");
  await pr.git("merge", "-q", "--no-ff", "--no-edit", "feature");
  await pr.git("update-ref", "refs/remotes/origin/main", "HEAD");
  await pr.git("checkout", "-q", "feature");
  pr.pullRequestState({ baseSha: before, merged: true });
}

test("a gap reason with a long run of backslashes prints in the table at once", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "ui-walk");
  await pr.hedge("gap", "--kind", "ui-walk", "--reason", "\\".repeat(40_000) + " no page");
  await agentAccepts(pr, "ui-walk");
  await pr.hedge("gate");

  const row = tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1];
  expect(row).toEndWith(" no page (🤖 agent " + await decisionId(pr) + ") |");
});

test("a gap reason with a long run of backticks prints in the table at once", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "ui-walk");
  await pr.hedge("gap", "--kind", "ui-walk", "--reason", "`".repeat(100_000) + " no page");
  await agentAccepts(pr, "ui-walk");
  await pr.hedge("gate");

  const row = tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1];
  expect(row).toEndWith(" no page (🤖 agent " + await decisionId(pr) + ") |");
});

test("a saved count with a field that is not a number reads unknown, and the report still prints", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(3, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  const saved = join(pr.pullRequest, "gate-outcome", `${await pr.git("rev-parse", "HEAD")}.json`);
  const record = JSON.parse(readFileSync(saved, "utf8"));
  record.gate.summary.growth.final.production = null;
  writeFileSync(saved, JSON.stringify(record));

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | unknown at HEAD | none |");
});

test("a saved final figure that is not a number shows no ratio beside the first count", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  const saved = join(pr.pullRequest, "gate-outcome", `${await pr.git("rev-parse", "HEAD")}.json`);
  const record = JSON.parse(readFileSync(saved, "utf8"));
  record.gate.summary.growth.final.production = null;
  writeFileSync(saved, JSON.stringify(record));

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → unknown | none |");
});

test("a landed gate without GitHub's base commit names the landed gate to run again", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(3, "greet"));
  pr.pullRequestState({ body: graded("non-critical"), baseSha: "0123456789abcdef0123456789abcdef01234567", merged: true });
  await pr.hedge("require", "--none", "--reason", "Docs only");

  expect((await pr.hedge("gate", "--landed")).output).toContain("then hedge proof gate --landed again");
});

test("a merged PR's receipt without a gate names the landed gate", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical")}`, merged: true });
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  expect((await pr.hedge("receipt")).code).toBe(0);

  expect(block(pr.githubBody())).toContain("**End table:** no gate at HEAD yet. Run hedge proof gate --landed, then hedge proof receipt.");
});

test("a PR named twice in the report reads once, and each other spelling keeps its own row, so no spelling hides another's gate", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  const proofRows = (report: string) => report.split("\n").filter((line) => /^\| example\/product#42 \| /i.test(line) && line.split(" | ").length === 5);

  const twice = (await pr.decide("report", "--pr", "example/product#42", "--pr", "example/product#42")).output;
  expect(twice).toContain("## End-of-run report: example/product#42\n");
  expect(tableIn(twice)).toHaveLength(2);
  expect(proofRows(twice)).toHaveLength(1);
  expect(proofRows((await pr.decide("report", "--pr", "Example/Product#42", "--pr", "example/product#42")).output)).toHaveLength(2);
});

test("a base commit from GitHub that is not a full SHA counts unknown, not from a local branch of that name", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(3, "greet"));
  pr.pullRequestState({ body: graded("non-critical"), baseSha: "main" });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | unknown at HEAD | none |");
});

test("a gate saved by an engine without the end table shows no row until the gate runs again", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical")}` });
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  const saved = join(pr.pullRequest, "gate-outcome", `${await pr.git("rev-parse", "HEAD")}.json`);
  const outcome = JSON.parse(readFileSync(saved, "utf8"));
  const { endTable: _endTable, ...oldKey } = outcome.key;
  const { growth: _growth, ...oldSummary } = outcome.gate.summary;
  writeFileSync(saved, JSON.stringify({ ...outcome, key: oldKey, gate: { ...outcome.gate, summary: oldSummary } }));

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)).toEqual([]);
  expect((await pr.hedge("receipt")).code).toBe(0);
  expect(block(pr.githubBody())).toContain("**End table:** no gate at HEAD yet. Run hedge proof gate, then hedge proof receipt.");
  await pr.hedge("gate");
  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → 10 (×1.0) | none |");
});

test("a base commit from GitHub that is not a string counts unknown, and the gate still saves its verdict", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(3, "greet"));
  pr.pullRequestState({ body: graded("non-critical"), baseSha: 42 });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  const gate = await pr.hedge("gate");

  expect(gate.output).not.toContain("TypeError");
  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | no review | unknown at HEAD | none |");
});

test("counting lines in a partial clone reads unknown and fetches no missing file", () => {
  const root = mkdtempSync(join(tmpdir(), "hedge-partial-"));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const origin = join(root, "origin");
  const clone = join(root, "clone");
  const git = (cwd: string, ...args: string[]) => runIn(cwd, env)(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]).stdout.trim();
  try {
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "uploadpack.allowFilter", "true");
    writeFileSync(join(origin, "feature.ts"), lines(3, "greet"));
    git(origin, "add", "feature.ts");
    git(origin, "commit", "-q", "-m", "first");
    const first = git(origin, "rev-parse", "HEAD");
    writeFileSync(join(origin, "feature.ts"), lines(9, "greet"));
    git(origin, "commit", "-q", "-am", "second");
    const second = git(origin, "rev-parse", "HEAD");
    git(root, "clone", "-q", "--no-checkout", "--filter=blob:none", `file://${origin}`, clone);
    expect(git(clone, "rev-parse", "HEAD")).toBe(second);

    expect(diffSize({ repository: "example/product", pr: 42, commit: second }, runIn(clone, env), first)).toBeUndefined();
    expect(runIn(clone, { ...env, GIT_NO_LAZY_FETCH: "1" })(["git", "cat-file", "-e", `${second}:feature.ts`]).code).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a round 1 that read an empty range shows zero lines at round 1, not unknown", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  expect((await pr.hedge("review-start", "--scope", "full")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  await pr.commit("feature.ts", lines(30, "greet"));
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 0 → 30 | none |");
});

test("after GitHub moves the PR to another base, the report shows no saved growth until the gate runs again", async () => {
  const pr = await checkout();
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  const moved = await pr.git("commit-tree", "main^{tree}", "-p", "main", "-m", "Another base");
  pr.pullRequestState({ body: graded("non-critical"), baseSha: moved });

  const report = (await pr.decide("report", "--pr", "example/product#42")).output;
  expect(report).toContain("### Review and skipped proofs\nNone gated at HEAD.");
  expect(tableIn(report)).toEqual([]);
});

test("round 1 counts from its fork point with GitHub's base, so base changes it merged past a stale local base ref stay out", async () => {
  const pr = await checkout();
  const stale = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.advanceBase("base.ts", lines(50, "landed"));
  await pr.git("merge", "-q", "--no-edit", "refs/remotes/origin/main");
  const landed = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.commit("feature.ts", lines(10, "greet"));
  await pr.git("update-ref", "refs/remotes/origin/main", stale);
  pr.pullRequestState({ body: graded("non-critical"), baseSha: landed });
  await reviewHead(pr);
  await pr.git("update-ref", "refs/remotes/origin/main", landed);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");

  expect(tableIn((await pr.decide("report", "--pr", "example/product#42")).output)[1]).toBe("| example/product#42 | 1 round | 10 → 10 (×1.0) | none |");
});
