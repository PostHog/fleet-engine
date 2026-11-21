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
  const remote = join(fixture("hedge-proof-remote-"), "github.com/example/product.git");
  mkdirSync(remote, { recursive: true });
  await pr.git("init", "-q", "--bare", remote);
  await pr.git("push", "-q", remote, "main:refs/heads/main");
  await pr.git("remote", "set-url", "origin", remote);
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
