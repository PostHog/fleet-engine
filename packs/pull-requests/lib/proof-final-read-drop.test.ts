import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanFixtures, checkout, clean, fakeModel, lockHolder, reviewHeadFixed, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const blocked = "cat >/dev/null; echo 'the guard blocked the model call' >&2; exit 1";
const unfinished = "A review is unfinished. Finish it before a final read.";
const reviews = (pr: Checkout) => join(pr.pullRequest, "reviews");
const dropped = (pr: Checkout) => readdirSync(join(reviews(pr), "dropped"));
const anyDropped = (pr: Checkout) => existsSync(join(reviews(pr), "dropped"));
const finalRead = (pr: Checkout, base: string, ...more: string[]) => pr.hedge("review", "--scope", "final", "--base", base, ...more);

async function reviewedPr() {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewed = await reviewHeadFixed(pr, "feature.txt:1", "greet");
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";
  const older = await pr.commit("feature.txt", "greet the member\n");
  return { pr, reviewed, older };
}

async function blockedFinalRead() {
  const reviewed = await reviewedPr();
  reviewed.pr.env.HEDGE_PROOF_REVIEWER = blocked;
  await expect(finalRead(reviewed.pr, reviewed.reviewed)).rejects.toThrow("gave no findings (exit 1: the guard blocked the model call");
  return reviewed;
}

async function failedPanelFinalRead(reviewer: string, lenses = ["correctness"]) {
  const reviewed = await reviewedPr();
  reviewed.pr.env.HEDGE_PROOF_REVIEWER = reviewer;
  expect((await finalRead(reviewed.pr, reviewed.reviewed, ...lenses.flatMap((lens) => ["--lens", lens]))).code).toBe(0);
  expect((await reviewed.pr.hedge("review", "--wait")).code).toBe(1);
  return reviewed;
}

test("a final read that never got an answer gives way to a final read of the new HEAD, and show and the gate name the dropped read and its cause", async () => {
  const { pr, reviewed, older } = await blockedFinalRead();
  const newer = await pr.commit("feature.txt", "greet the new member\n");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  const read = await finalRead(pr, reviewed);

  expect(read.code).toBe(0);
  expect(JSON.parse(read.output.split("\n")[0]!)).toMatchObject({ round: "final", id: "final-2" });
  expect(reviewer.prompts().at(-1)).toContain("+greet the new member");
  const line = `final read 1 on ${older.slice(0, 7)} dropped at ${newer.slice(0, 7)}: no reviewer answer was captured; cause: exit 1: the guard blocked the model call (after a retry)`;
  expect((await pr.hedge("show")).output).toContain(line);
  const judge = fakeModel(pr, "JUDGE", verdict());
  const gate = await pr.hedge("gate");
  expect(gate.output).toContain("review: HEAD reviewed in final read 2");
  expect(gate.output).toContain(`review: ${line}`);
  expect(judge.prompts().at(-1)).toContain(`review: ${line}`);
});

test("a second final read that never got an answer gives way too, and both drops stay on record", async () => {
  const { pr, reviewed } = await blockedFinalRead();
  await pr.commit("feature.txt", "greet the new member\n");
  await expect(finalRead(pr, reviewed)).rejects.toThrow("gave no findings");
  await pr.commit("feature.txt", "greet every new member\n");
  fakeModel(pr, "REVIEWER", "No findings.");

  const read = await finalRead(pr, reviewed);

  expect(JSON.parse(read.output.split("\n")[0]!)).toMatchObject({ id: "final-3" });
  expect(dropped(pr).sort()).toEqual(["final-1", "final-2"]);
});

test("a final read at HEAD that never got an answer runs again, and is not dropped", async () => {
  const { pr, reviewed } = await blockedFinalRead();
  fakeModel(pr, "REVIEWER", "No findings.");

  const read = await finalRead(pr, reviewed);

  expect(JSON.parse(read.output.split("\n")[0]!)).toMatchObject({ id: "final-1" });
  expect(anyDropped(pr)).toBe(false);
});

test("an author's final read at HEAD never drops the final read that hedge reserved at HEAD", async () => {
  const { pr, reviewed } = await blockedFinalRead();

  await expect(pr.hedge("review-start", "--scope", "final", "--base", reviewed)).rejects.toThrow(unfinished);
  expect(anyDropped(pr)).toBe(false);
});

test("a final read with captured findings is never dropped", async () => {
  const { pr, reviewed, older } = await reviewedPr();
  fakeModel(pr, "REVIEWER", "- major | feature.txt:1 | the greeting names no member | anchor: greet the member");
  expect((await finalRead(pr, reviewed)).code).toBe(0);
  await pr.commit("feature.txt", "greet the new member\n");

  await expect(finalRead(pr, reviewed)).rejects.toThrow(`Final read base must be the latest reviewed commit ${older}`);
  expect(readFileSync(join(reviews(pr), "final-1/findings.md"), "utf8")).toContain("the greeting names no member");
  expect(anyDropped(pr)).toBe(false);
});

test("a final read whose findings file exists but is empty is never dropped", async () => {
  const { pr, reviewed, older } = await blockedFinalRead();
  writeFileSync(join(reviews(pr), "final-1/findings.md"), "");
  await pr.commit("feature.txt", "greet the new member\n");

  await expect(finalRead(pr, reviewed)).rejects.toThrow(`Final read base must be the latest reviewed commit ${older}`);
  expect(anyDropped(pr)).toBe(false);
});

test("a panel final read whose failed lens left an answer is never dropped", async () => {
  const { pr, reviewed } = await failedPanelFinalRead("cat >/dev/null; echo '1. major: the greeting names no member'");
  expect(readFileSync(join(reviews(pr), "final-1/lenses/correctness.md"), "utf8")).toContain("the greeting names no member");
  await pr.commit("feature.txt", "greet the new member\n");

  await expect(finalRead(pr, reviewed)).rejects.toThrow(unfinished);
  expect(anyDropped(pr)).toBe(false);
});

test("a panel final read with one lens done and one failed is never dropped", async () => {
  const { pr, reviewed } = await failedPanelFinalRead(`prompt=$(cat); case "$prompt" in *"Lens: Risk"*) exit 1;; esac; printf '${clean}'`, ["correctness", "risk"]);
  expect(readdirSync(join(reviews(pr), "final-1/lenses"))).toContain("correctness.md");
  await pr.commit("feature.txt", "greet the new member\n");

  await expect(finalRead(pr, reviewed)).rejects.toThrow(unfinished);
  expect(anyDropped(pr)).toBe(false);
});

test("a panel final read whose lens answer file exists but is empty is never dropped", async () => {
  const { pr, reviewed } = await failedPanelFinalRead(blocked);
  writeFileSync(join(reviews(pr), "final-1/lenses/correctness.md"), "");
  await pr.commit("feature.txt", "greet the new member\n");

  await expect(finalRead(pr, reviewed)).rejects.toThrow(unfinished);
  expect(anyDropped(pr)).toBe(false);
});

test("a panel final read whose lenses have not run yet is never dropped", async () => {
  const { pr, reviewed } = await reviewedPr();
  pr.panel.lostWorkers = true;
  expect((await finalRead(pr, reviewed, "--lens", "correctness")).code).toBe(0);
  pr.panel.lostWorkers = false;
  await pr.commit("feature.txt", "greet the new member\n");

  await expect(finalRead(pr, reviewed)).rejects.toThrow(unfinished);
  expect(anyDropped(pr)).toBe(false);
});

test("a panel final read that stopped before it started its lenses is never dropped", async () => {
  const { pr, reviewed } = await reviewedPr();
  pr.panel.lostWorkers = true;
  expect((await finalRead(pr, reviewed, "--lens", "correctness")).code).toBe(0);
  pr.panel.lostWorkers = false;
  const read = join(reviews(pr), "final-1");
  renameSync(join(read, "panel.json"), join(read, "panel.staged.json"));
  await pr.commit("feature.txt", "greet the new member\n");

  await expect(finalRead(pr, reviewed)).rejects.toThrow(unfinished);
  expect(anyDropped(pr)).toBe(false);
});

test("a panel final read whose lenses all failed without an answer gives way to a final read of the new HEAD", async () => {
  const { pr, reviewed } = await failedPanelFinalRead(blocked);
  await pr.commit("feature.txt", "greet the new member\n");
  fakeModel(pr, "REVIEWER", "No findings.");

  expect((await finalRead(pr, reviewed)).code).toBe(0);
  expect(dropped(pr)).toEqual(["final-1"]);
  expect((await pr.hedge("show")).output).toContain("no reviewer answer was captured; cause: correctness: exit 1: the guard blocked the model call");
});

test("an unfinished panel round is never dropped for a final read", async () => {
  const { pr, reviewed } = await reviewedPr();
  pr.env.HEDGE_PROOF_REVIEWER = blocked;
  expect((await pr.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
  expect((await pr.hedge("review", "--wait")).code).toBe(1);
  await pr.commit("feature.txt", "greet the new member\n");

  await expect(finalRead(pr, reviewed)).rejects.toThrow(unfinished);
  expect(existsSync(join(reviews(pr), "2/round.json"))).toBe(true);
  expect(anyDropped(pr)).toBe(false);
});

test("a final read that the author reserved is never dropped, since hedge cannot know what its reviewer said", async () => {
  const { pr, reviewed } = await reviewedPr();
  expect((await pr.hedge("review-start", "--scope", "final", "--base", reviewed)).code).toBe(0);
  await pr.commit("feature.txt", "greet the new member\n");

  await expect(finalRead(pr, reviewed)).rejects.toThrow(unfinished);
  expect(anyDropped(pr)).toBe(false);
});

test("a final read that another command still works on is never dropped", async () => {
  const { pr, reviewed } = await blockedFinalRead();
  await pr.commit("feature.txt", "greet the new member\n");
  const holder = await lockHolder(join(reviews(pr), "final-1"));
  try {
    await expect(finalRead(pr, reviewed)).rejects.toThrow(unfinished);
    expect(anyDropped(pr)).toBe(false);
  } finally { await holder.release(); }
});
