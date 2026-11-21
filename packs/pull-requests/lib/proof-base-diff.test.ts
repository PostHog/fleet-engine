import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, fakeModel, fixture, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

async function publishBase(pr: Checkout, remote = "origin") {
  const bare = join(fixture("hedge-proof-remote-"), "github.com/example/product.git");
  mkdirSync(bare, { recursive: true });
  await pr.git("init", "-q", "--bare", bare);
  await pr.git("push", "-q", bare, "main:refs/heads/main");
  await pr.git("remote", remote === "origin" ? "set-url" : "add", remote, bare);
}

async function mergeBaseBehindStaleRef(pr: Checkout) {
  await pr.commit("feature.txt", "greet the new member\n");
  const stale = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.hedge("require", "--none", "--reason", "docs only");
  return stale;
}

async function judgePrompt(pr: Checkout) {
  await reviewHead(pr);
  const judge = fakeModel(pr, "JUDGE", verdict());
  expect((await pr.hedge("gate")).code).toBe(0);
  return judge.prompts().at(-1)!;
}

test("after the branch merges a base its stale base ref lags behind, the reviewer reads only the branch's lines", async () => {
  const pr = await checkout();
  const stale = await mergeBaseBehindStaleRef(pr);
  await publishBase(pr);
  await pr.git("update-ref", "refs/remotes/origin/main", stale);
  const reviewer = fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: feature.txt\n");

  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);

  const brief = reviewer.prompts().at(-1)!;
  expect(brief).toContain("+greet the new member");
  expect(brief).not.toContain("the base moves on");
});

test("after the branch merges a base its stale base ref lags behind, the judge reads only the branch's lines", async () => {
  const pr = await checkout();
  const stale = await mergeBaseBehindStaleRef(pr);
  await publishBase(pr);
  await pr.git("update-ref", "refs/remotes/origin/main", stale);

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).not.toContain("the base moves on");
});

test("after the base drops a tip the branch merged, the judge reads that tip's lines, which the branch now carries", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.advanceBase("base.md", "a base change that is later dropped\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.git("checkout", "-q", "main");
  await pr.git("reset", "-q", "--hard", "HEAD^");
  await pr.commit("forced.md", "the force-pushed base\n");
  await pr.git("checkout", "-q", "feature");
  await publishBase(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).toContain("+a base change that is later dropped");
  expect(prompt).not.toContain("the force-pushed base");
});

test("when one remote of the repository cannot be fetched, the judge reads the base from the one that can", async () => {
  const pr = await checkout();
  const stale = await mergeBaseBehindStaleRef(pr);
  await publishBase(pr, "upstream");
  await pr.git("remote", "set-url", "origin", join(fixture("hedge-proof-gone-"), "github.com/example/product.git"));
  await pr.git("update-ref", "refs/remotes/origin/main", stale);
  await pr.git("update-ref", "refs/remotes/upstream/main", stale);

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).not.toContain("the base moves on");
});
