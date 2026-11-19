import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitEnv } from "../../../src/testing/git.ts";
import { localLedger } from "./decision-ledger.ts";
import { cleanBaseMerge, remotesOf } from "./proof-checkout.ts";
import { netDeltaIn } from "./proof-delta.ts";
import { finishReview, proofGate, pullRequestDirectory, startReview, type Arbiter, type ProofIdentity, type ReviewLimits } from "./proof.ts";
import { checkout, clean as noFindings, cleanFixtures, fakeModel, finishRound, fixture, hubAt, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const repository = "example/product";
const pr = 7;
const major = "FINDINGS:\n- src/app.ts:1 | major | Correctness | the count is off by one | count from zero | anchor: app\nCOVERED: src/app.ts\n";
const clean = "FINDINGS:\n- src/app.ts:1 | minor | Design | a name reads plain | rename it | anchor: app\nCOVERED: src/app.ts\n";
const continues: Arbiter = async () => ({ verdict: "continue", reason: "", model: "arbiter-under-test" });
const escalates: Arbiter = async () => ({ verdict: "escalate", reason: "Final read 1 asks to undo the fix round 1 asked for", model: "arbiter-under-test" });
const timesOut: Arbiter = async () => ({ verdict: "unavailable", reason: "the arbiter timed out", model: "arbiter-under-test" });
const unasked: Arbiter = async () => { throw new Error("the arbiter was asked"); };
const roomy: ReviewLimits = { free: 10, ceiling: 10 };
const short = (commit: string) => commit.slice(0, 7);

function gitRepo() {
  const directory = fixture("hedge-proof-carry-");
  const [home, cwd, bin] = ["home", "repo", "bin"].map((name) => join(directory, name));
  for (const path of [home, cwd, bin]) mkdirSync(path);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '{"base":{"ref":"main"}}'\n`, { mode: 0o755 });
  const env = { ...gitEnv, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const run = (command: string[]) => {
    const child = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode ?? 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  };
  const git = (...args: string[]) => {
    const result = run(["git", ...args]);
    if (result.code > 1) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return { ...result, stdout: result.stdout.trim() };
  };
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); }
  };
  const commit = (message: string, files: Record<string, string>) => { write(files); git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", message); return git("rev-parse", "HEAD").stdout; };
  const github = { base: "" };
  const onBranch = (branch: string, step: () => void) => { git("checkout", "-q", branch); step(); git("checkout", "-q", "feature"); };
  const advanceBase = (files: Record<string, string>) => onBranch("main", () => {
    github.base = commit("Change the base", files);
    git("update-ref", "refs/remotes/origin/main", github.base);
  });
  const forgeLocalBase = (files: Record<string, string>) => onBranch("main", () => {
    git("checkout", "-q", "-b", "forged");
    git("update-ref", "refs/remotes/origin/main", commit("Change a base GitHub never had", files));
  });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  const start = () => { github.base = git("rev-parse", "HEAD").stdout; git("update-ref", "refs/remotes/origin/main", github.base); git("checkout", "-q", "-b", "feature"); };
  return { directory, home, run, git, write, commit, advanceBase, forgeLocalBase, github, start };
}

type Repo = ReturnType<typeof gitRepo>;
const at = (commit: string): ProofIdentity => ({ repository, pr, commit });
const netDelta = (repo: Repo, remotes = () => remotesOf(repository, repo.run)) => netDeltaIn(repo.run, remotes);

async function finish(repo: Repo, commit: string, id: number | `final-${number}`, findings: string) {
  const path = join(repo.home, `findings-${id}.md`);
  writeFileSync(path, findings);
  await finishReview(repo.home, at(commit), id, path, "gpt-6.2-sol");
}

async function reviewedPanel(repo: Repo, commit: string, findings = clean) {
  const { directory } = await startReview(repo.home, at(commit), { scope: "full", arbiter: unasked, limits: roomy, baseSha: repo.github.base });
  writeFileSync(join(directory, "panel.json"), "{}");
  await finish(repo, commit, 1, findings);
}

const finalRead = (repo: Repo, commit: string, base: string, arbiter: Arbiter, limits = roomy) =>
  startReview(repo.home, at(commit), { scope: "final", base, arbiter, limits, netDelta: netDelta(repo), baseSha: repo.github.base });

async function reviewLine(repo: Repo, commit: string, remotes?: () => string[]) {
  const gate = await proofGate(repo.home, at(commit), {
    ci: () => ({ state: "green", detail: "1 check(s)" }), pushedHead: () => ({ commit, body: "", baseSha: repo.github.base }), ledger: localLedger(repo.home),
    cleanBaseMerge: cleanBaseMerge(at(commit), repo.run), netDelta: netDelta(repo, remotes),
  });
  return gate.lines.find((line) => line.startsWith("review:"));
}

const carriedLine = (reviewed: string) => `review: HEAD carried from ${short(reviewed)}: nothing changed past it and the base (round 1 by gpt-6.2-sol)`;
const finalReadLine = (reviewed: string, files: number) => `review: HEAD not reviewed, last review covered ${short(reviewed)}; ${files} file(s) changed past it and the base. Read them with hedge proof review --scope final --base ${reviewed}`;

function reviewedApp() {
  const repo = gitRepo();
  repo.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  repo.start();
  return { repo, reviewed: repo.commit("Count the app", { "src/app.ts": "export const app = 2;\n" }) };
}

test("a clean merge of the base carries the review, writes its receipt, and needs no final read", async () => {
  const { repo, reviewed } = reviewedApp();
  await reviewedPanel(repo, reviewed);
  repo.advanceBase({ "src/other.ts": "export const other = 3;\n" });
  repo.git("merge", "-q", "--no-edit", "origin/main");
  const merged = repo.git("rev-parse", "HEAD").stdout;

  expect(await reviewLine(repo, merged)).toBe(carriedLine(reviewed));
  expect(JSON.parse(readFileSync(join(pullRequestDirectory(repo.home, at(merged)), "carried", `${merged}.json`), "utf8"))).toMatchObject({ commit: merged, from: reviewed });
  await expect(finalRead(repo, merged, reviewed, unasked)).rejects.toThrow(`HEAD needs no final read: nothing changed past ${short(reviewed)} and the base`);
});

test("a change and its revert by content carry the review", async () => {
  const { repo, reviewed } = reviewedApp();
  await reviewedPanel(repo, reviewed);
  repo.commit("Try a fix", { "src/app.ts": "export const app = 3;\n", "src/fix.ts": "export const fix = true;\n" });
  repo.git("rm", "-q", "src/fix.ts");
  const back = repo.commit("Take the fix back", { "src/app.ts": "export const app = 2;\n" });

  expect(await reviewLine(repo, back)).toBe(carriedLine(reviewed));
});

test("the carry takes the PR's base from GitHub, never from a remote-tracking ref of the checkout", async () => {
  const { repo, reviewed } = reviewedApp();
  await reviewedPanel(repo, reviewed);
  repo.forgeLocalBase({ "src/slipped.ts": "export const slipped = true;\n" });
  repo.git("merge", "-q", "--no-edit", "origin/main");
  const merged = repo.git("rev-parse", "HEAD").stdout;

  expect(await reviewLine(repo, merged)).toBe(finalReadLine(reviewed, 1));
  expect(netDelta(repo)({ commit: reviewed, baseSha: repo.github.base }, merged, repo.github.base)).toMatchObject({ files: ["src/slipped.ts"] });
});

test("the gate fetches a PR base that the checkout lacks, and carries nothing when it cannot fetch it", async () => {
  const { repo, reviewed } = reviewedApp();
  await reviewedPanel(repo, reviewed);
  const github = join(repo.directory, "github.git");
  repo.git("init", "-q", "--bare", github);
  repo.git("remote", "add", "github", github);
  const moved = repo.git("commit-tree", repo.git("rev-parse", "main^{tree}").stdout, "-p", "main", "-m", "The base moves on GitHub").stdout;
  repo.git("push", "-q", github, `${moved}:refs/heads/main`);
  repo.git("gc", "-q", "--prune=now");
  expect(repo.run(["git", "cat-file", "-e", `${moved}^{commit}`]).code).not.toBe(0);
  const head = repo.commit("Note nothing", {});
  repo.github.base = moved;

  expect(await reviewLine(repo, head, () => ["github"])).toBe(carriedLine(reviewed));
  repo.github.base = "f".repeat(40);
  expect(await reviewLine(repo, head, () => ["github"])).toBe(`review: HEAD not reviewed, last review covered ${short(reviewed)}; the checkout lacks the PR's base ${"f".repeat(7)} and cannot fetch it, so nothing carries`);
});

test("after the base on GitHub drops what a review stood on, that review carries nothing and the gate asks for a full read", async () => {
  const { repo } = reviewedApp();
  const before = repo.github.base;
  repo.advanceBase({ "src/other.ts": "export const other = 3;\n" });
  repo.git("merge", "-q", "--no-edit", "origin/main");
  const reviewed = repo.git("rev-parse", "HEAD").stdout;
  await reviewedPanel(repo, reviewed);
  const dropped = repo.github.base;
  repo.github.base = before;
  const head = repo.commit("Note nothing", {});

  expect(await reviewLine(repo, head)).toBe(`review: HEAD not reviewed, last review covered ${short(reviewed)}; the PR's base on GitHub no longer holds ${short(dropped)}, the base that review stood on, so nothing carries. Read the whole PR again with hedge proof review --scope full and --agent '<your reason>'`);
});

test("a base merge's ledger conflict resolution is part of the net delta", async () => {
  const repo = gitRepo();
  const ledger = "| port | lane |\n| 1 | a |\n";
  repo.commit("Add the ledger", { "testing/ports.md": ledger });
  repo.start();
  const reviewed = repo.commit("Take a port", { "testing/ports.md": `${ledger}| 2 | pr |\n` });
  await reviewedPanel(repo, reviewed);
  repo.advanceBase({ "testing/ports.md": `${ledger}| 3 | base |\n`, "src/other.ts": "export const other = 3;\n" });
  expect(repo.git("merge", "-q", "origin/main").code).toBe(1);
  repo.write({ "testing/ports.md": `${ledger}| 2 | pr |\n| 3 | base |\n` });
  repo.git("add", "-A");
  repo.git("commit", "-q", "--no-edit");
  const merged = repo.git("rev-parse", "HEAD").stdout;

  expect(netDelta(repo)({ commit: reviewed, baseSha: repo.github.base }, merged, repo.github.base)).toMatchObject({ files: ["testing/ports.md"] });
  expect(await reviewLine(repo, merged)).toBe(finalReadLine(reviewed, 1));
});

test("a base merge whose conflict leaves no markers, such as in a binary file, never carries", async () => {
  const repo = gitRepo();
  repo.commit("Add the image", { "art/logo.bin": "logo\0one\n" });
  repo.start();
  const reviewed = repo.commit("Redraw the image", { "art/logo.bin": "logo\0two\n" });
  await reviewedPanel(repo, reviewed);
  repo.advanceBase({ "art/logo.bin": "logo\0three\n" });
  expect(repo.git("merge", "-q", "origin/main").code).toBe(1);
  repo.git("checkout", "-q", "--ours", "art/logo.bin");
  repo.git("add", "-A");
  repo.git("commit", "-q", "--no-edit");
  const merged = repo.git("rev-parse", "HEAD").stdout;

  expect(await reviewLine(repo, merged)).toBe(finalReadLine(reviewed, 1));
});

test("a final read that finds no blocker or major spends no review budget, even past the ceiling", async () => {
  let { repo, reviewed } = reviewedApp();
  await reviewedPanel(repo, reviewed, major);
  const limits = { free: 10, ceiling: 2 };
  for (const [read, count] of [[1, 3], [2, 4], [3, 5]] as const) {
    const head = repo.commit(`Fix ${read}`, { "src/app.ts": `export const app = ${count};\n` });
    const { id } = await finalRead(repo, head, reviewed, unasked, limits);
    expect(id).toBe(`final-${read}`);
    await finish(repo, head, `final-${read}`, clean);
    reviewed = head;
  }
});

test("the final read the carry asks for runs once the budget is spent, and the fixes round after it does not", async () => {
  const { repo, reviewed } = reviewedApp();
  await reviewedPanel(repo, reviewed, major);
  const limits = { free: 10, ceiling: 2 };
  const fixed = repo.commit("Fix 1", { "src/app.ts": "export const app = 3;\n" });
  await finalRead(repo, fixed, reviewed, unasked, limits);
  await finish(repo, fixed, "final-1", major);
  const again = repo.commit("Fix 2", { "src/app.ts": "export const app = 4;\n" });

  expect((await finalRead(repo, again, fixed, unasked, limits)).id).toBe("final-2");
  await finish(repo, again, "final-2", major);
  expect(await reviewLine(repo, again)).toBe("review: HEAD reviewed in final read 2 by gpt-6.2-sol");
  const third = repo.commit("Fix 3", { "src/app.ts": "export const app = 5;\n" });
  await expect(startReview(repo.home, at(third), { scope: "fixes", base: reviewed, arbiter: unasked, limits, netDelta: netDelta(repo), baseSha: repo.github.base })).rejects.toThrow("The review budget of 2 reviews is spent");
});

async function stopped(arbiter: Arbiter) {
  const { repo, reviewed } = reviewedApp();
  await reviewedPanel(repo, reviewed, major);
  const limits = { free: 1, ceiling: 10 };
  const fixed = repo.commit("Fix the count", { "src/app.ts": "export const app = 3;\n" });
  await expect(finalRead(repo, fixed, reviewed, arbiter, limits)).rejects.toThrow(arbiter === escalates ? "The arbiter escalates" : "The arbiter gave no verdict: the arbiter timed out");
  return { repo, reviewed, fixed, limits };
}

test("after an arbiter stop, one final read of the net delta runs without the arbiter, and the next review goes to the user", async () => {
  const { repo, reviewed, limits } = await stopped(escalates);
  const reverted = repo.commit("Revert part of the fix", { "src/app.ts": "export const app = 2;\n", "src/app.test.ts": "expect(app).toBe(2);\n" });
  const confirming = await finalRead(repo, reverted, reviewed, unasked, limits);
  expect(confirming.id).toBe("final-1");
  await finish(repo, reverted, "final-1", major);
  const next = repo.commit("Fix the test", { "src/app.test.ts": "expect(app).toBe(3);\n" });

  await expect(finalRead(repo, next, reverted, continues, limits)).rejects.toThrow("The arbiter stopped the loop, and final read 1 confirmed its stop. hedge proof starts no other review: take each blocker or major of final read 1 to the user");
  expect(existsSync(join(pullRequestDirectory(repo.home, at(next)), "reviews", "final-2"))).toBe(false);
});

test("an arbiter that times out stops nothing: the next final read asks the arbiter again", async () => {
  const { repo, reviewed, fixed, limits } = await stopped(timesOut);

  await expect(finalRead(repo, fixed, reviewed, unasked, limits)).rejects.toThrow("the arbiter was asked");
});

test("a stop grants one confirming read; once it finds nothing, the next read asks the arbiter, and only a new stop grants another", async () => {
  const { repo, reviewed, fixed, limits } = await stopped(escalates);
  expect((await finalRead(repo, fixed, reviewed, unasked, limits)).id).toBe("final-1");
  await finish(repo, fixed, "final-1", clean);
  const next = repo.commit("Tidy the count", { "src/app.ts": "export const app = 4;\n" });

  await expect(finalRead(repo, next, fixed, unasked, limits)).rejects.toThrow("the arbiter was asked");
  await expect(finalRead(repo, next, fixed, escalates, limits)).rejects.toThrow("The arbiter escalates");
  expect((await finalRead(repo, next, fixed, unasked, limits)).id).toBe("final-2");
});

test("two confirming reads of one stop at once: one runs", async () => {
  const { repo, reviewed, fixed, limits } = await stopped(escalates);

  const results = await Promise.allSettled([finalRead(repo, fixed, reviewed, unasked, limits), finalRead(repo, fixed, reviewed, unasked, limits)]);
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
});

const escalate = "cat >/dev/null; echo 'ESCALATE: Round 2 undoes the rename round 1 asked for.'";

async function stoppedCheckout() {
  const pr = await checkout();
  const reviewed = await pr.commit("feature.txt", "new\n");
  for (const round of ["1", "2"]) {
    await pr.hedge("review-start", ...(round === "1" ? ["--scope", "full"] : ["--scope", "fixes", "--base", reviewed]));
    await finishRound(pr, round);
  }
  await pr.commit("feature.txt", "fixed\n");
  pr.env.HEDGE_REVIEW_ARBITER = escalate;
  await expect(pr.hedge("review-start", "--scope", "final", "--base", reviewed)).rejects.toThrow("The arbiter escalates");
  return { pr, reviewed };
}

test("an override clears the arbiter's stop only once its own decision is in the ledger", async () => {
  const { pr, reviewed } = await stoppedCheckout();
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round", "Run one more review round? example/product#42: The arbiter escalates: Round 2 undoes the rename round 1 asked for.");
  await expect(pr.hedge("review-start", "--scope", "final", "--base", reviewed, "--override", `2026-10-25 "Run one more round"`, "--thread", "thread-1")).rejects.toThrow("Not recorded");
  rmSync(join(pr.pullRequest, "reviews/final-1"), { recursive: true });
  hub.state.hub = "up";

  expect((await pr.hedge("review-start", "--scope", "final", "--base", reviewed)).output).toContain("This final read confirms the arbiter's stop");
});

test("a recorded override clears the arbiter's stop, so the next read asks the arbiter again", async () => {
  const { pr, reviewed } = await stoppedCheckout();
  pr.choose("Run one more round", "Run one more review round? example/product#42: The arbiter escalates: Round 2 undoes the rename round 1 asked for.");
  expect((await pr.hedge("review-start", "--scope", "final", "--base", reviewed, "--override", `2026-10-25 "Run one more round"`, "--thread", "thread-1")).code).toBe(0);
  await finishRound(pr, "final-1");
  const read = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "fixed again\n");

  await expect(pr.hedge("review-start", "--scope", "final", "--base", read)).rejects.toThrow("The arbiter escalates");
});

const patchFiles = (patch: string) => [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);

async function panelReviewed(pr: Checkout) {
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewed = await pr.commit("feature.txt", "greet\n");
  const reviewer = fakeModel(pr, "REVIEWER", noFindings);
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  return { reviewed, reviewer };
}

const readPatch = (pr: Checkout, round: string) => readFileSync(join(pr.pullRequest, "reviews", round, "diff.patch"), "utf8");

test("a final read after a base merge sends the reviewer only the test file that changed", async () => {
  const pr = await checkout();
  const { reviewed } = await panelReviewed(pr);
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.test.ts", "expect(greeting).toBe('greet');\n");

  expect((await pr.hedge("gate")).output).toContain(finalReadLine(reviewed, 1));
  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);
  expect(patchFiles(readPatch(pr, "final-1"))).toEqual(["feature.test.ts"]);
});

for (const path of [["review", "--scope", "final"], ["review", "--lens", "correctness", "--scope", "final"]]) {
  test(`${path.join(" ")} reads the whole net delta from the latest reviewed head: a revert to the panel's content and a deleted file stay in its patch`, async () => {
    const pr = await checkout();
    const { reviewed, reviewer } = await panelReviewed(pr);
    reviewer.answer("FINDINGS:\n(none)\nCOVERED: feature.txt, helper.txt\n");
    await pr.commit("helper.txt", "help\n");
    const fixed = await pr.commit("feature.txt", "greet the member\n");
    await pr.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed);
    expect((await pr.hedge("review", "--wait")).code).toBe(0);
    await pr.git("rm", "-q", "helper.txt");
    await pr.commit("feature.txt", "greet\n");

    await pr.hedge(...path, "--base", fixed);
    const patch = readPatch(pr, "final-1");
    expect(patchFiles(patch)).toEqual(["feature.txt", "helper.txt"]);
    expect(patch).toContain("-greet the member\n+greet");
    expect(patch).toContain("deleted file mode");
  });
}

test("a gate in a checkout that lacks HEAD stops before it calls GitHub", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const called = join(pr.home, "gh-called");
  writeFileSync(join(pr.env.PATH!.split(":")[0]!, "gh"), `#!/bin/sh\necho "$*" >> "${called}"\nexit 1\n`, { mode: 0o755 });
  const missing = "0123456789abcdef0123456789abcdef01234567";

  await expect(pr.hedge("gate", "--repo", "example/product", "--pr", "42", "--commit", missing)).rejects.toThrow(`HEAD ${short(missing)} is not in this checkout. Fetch it with git fetch origin pull/42/head, then run the gate again`);
  expect(existsSync(called)).toBe(false);
});

test("when the checkout lacks the reviewed commit, the review carries nothing", async () => {
  const pr = await checkout();
  const missing = "0123456789abcdef0123456789abcdef01234567";
  const reviewedAt = { repository: "example/product", pr: 42, commit: missing };
  const { directory } = await startReview(pr.home, reviewedAt, { scope: "full", arbiter: unasked, limits: roomy, baseSha: await pr.git("rev-parse", "main") });
  writeFileSync(join(directory, "panel.json"), "{}");
  writeFileSync(join(pr.home, "findings.md"), "No findings.\n");
  await finishReview(pr.home, reviewedAt, 1, join(pr.home, "findings.md"), "gpt-6.2-sol");
  await pr.commit("feature.txt", "new\n");

  expect((await pr.hedge("gate")).output).toContain(`review: HEAD not reviewed, last review covered ${short(missing)}; the checkout lacks ${short(missing)}, so nothing carries`);
});
