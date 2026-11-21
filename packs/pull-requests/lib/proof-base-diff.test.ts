import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "../../../src/testing/git.ts";
import { spawnAsync } from "../../../src/testing/spawn.ts";
import { checkout, cleanFixtures, fakeModel, fixture, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lens = "FINDINGS:\n(none)\nCOVERED: feature.txt\n";

async function mergeMovedBaseBehindStaleRef(pr: Checkout) {
  await pr.commit("feature.txt", "greet the new member\n");
  const stale = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const moved = await pr.git("rev-parse", "main");
  await pr.git("update-ref", "refs/remotes/origin/main", stale);
  await pr.hedge("require", "--none", "--reason", "docs only");
  return moved;
}

async function publishBase(pr: Checkout, tip: string) {
  const remote = join(fixture("hedge-proof-remote-"), "github.com/example/product.git");
  mkdirSync(remote, { recursive: true });
  await pr.git("init", "-q", "--bare", remote);
  await pr.git("push", "-q", remote, `${tip}:refs/heads/main`);
  await pr.git("remote", "set-url", "origin", remote);
  return remote;
}

async function judgePrompt(pr: Checkout) {
  await reviewHead(pr);
  const judge = fakeModel(pr, "JUDGE", verdict());
  expect((await pr.hedge("gate")).code).toBe(0);
  return judge.prompts().at(-1)!;
}

test("after the branch merges a base its stale base ref lags behind, the reviewer reads only the branch's lines", async () => {
  const pr = await checkout();
  pr.pullRequestState({ baseSha: await mergeMovedBaseBehindStaleRef(pr) });
  const reviewer = fakeModel(pr, "REVIEWER", lens);

  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);

  const brief = reviewer.prompts().at(-1)!;
  expect(brief).toContain("+greet the new member");
  expect(brief).not.toContain("the base moves on");
});

test("after the branch merges a base its stale base ref lags behind, the judge reads only the branch's lines", async () => {
  const pr = await checkout();
  pr.pullRequestState({ baseSha: await mergeMovedBaseBehindStaleRef(pr) });

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).not.toContain("the base moves on");
});

test("when GitHub's base commit is not in the checkout yet, the judge fetches the base branch and reads only the branch's lines", async () => {
  const pr = await checkout();
  await mergeMovedBaseBehindStaleRef(pr);
  const remote = await publishBase(pr, "main");
  const elsewhere = fixture("hedge-proof-elsewhere-");
  const there = (...args: string[]) => spawnAsync(["git", ...args], { cwd: elsewhere, env: gitEnv });
  await there("clone", "-q", remote, ".");
  writeFileSync(join(elsewhere, "later.md"), "the base moves again\n");
  await there("add", "later.md");
  await there("commit", "-q", "-m", "Move the base again");
  await there("push", "-q", "origin", "HEAD:main");
  pr.pullRequestState({ baseSha: (await there("rev-parse", "HEAD")).stdout.trim() });

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).not.toContain("the base moves on");
});

test("after the base is rewritten past a tip the branch merged, the judge still reads that tip's lines, which the branch now carries", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.advanceBase("base.md", "a base change that is later discarded\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.git("checkout", "-q", "main");
  await pr.git("reset", "-q", "--hard", "HEAD^");
  const rewritten = await pr.commit("rewritten.md", "the rewritten base\n");
  await pr.git("checkout", "-q", "feature");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.pullRequestState({ baseSha: rewritten });

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).toContain("+a base change that is later discarded");
  expect(prompt).not.toContain("the rewritten base");
});

test("when the base was reset back past a tip the branch merged, the judge reads that tip's lines, which the branch now carries", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.advanceBase("base.md", "a base change that is later reset away\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const reset = await pr.git("rev-parse", "main^");
  await publishBase(pr, reset);
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.pullRequestState({ baseSha: reset });

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).toContain("+a base change that is later reset away");
});

test("when the base moved on after GitHub last read it and the branch merged it, the judge reads only the branch's lines", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  const lastRead = await pr.git("rev-parse", "main");
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await publishBase(pr, "main");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.pullRequestState({ baseSha: lastRead });

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).not.toContain("the base moves on");
});

test("when the base was force-pushed to a sibling of GitHub's base commit and the branch merged it, the judge fetches the base and reads only the branch's lines", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.advanceBase("base.md", "the base before the force-push\n");
  const lastRead = await pr.git("rev-parse", "main");
  await pr.git("checkout", "-q", "main");
  await pr.git("reset", "-q", "--hard", "HEAD^");
  await pr.commit("forced.md", "the force-pushed base\n");
  await pr.git("update-ref", "refs/remotes/origin/main", "HEAD");
  await pr.git("checkout", "-q", "feature");
  await pr.git("merge", "-q", "--no-edit", "main");
  await publishBase(pr, "main");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.pullRequestState({ baseSha: lastRead });

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).not.toContain("the force-pushed base");
  expect(prompt).not.toContain("the base before the force-push");
});
