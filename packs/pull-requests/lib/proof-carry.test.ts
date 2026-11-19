import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitEnv } from "../../../src/testing/git.ts";
import { localLedger } from "./decision-ledger.ts";
import { baseRefs, cleanBaseMerge } from "./proof-checkout.ts";
import { netDeltaIn } from "./proof-delta.ts";
import { finishReview, proofGate, pullRequestDirectory, startReview, type Arbiter, type ProofIdentity, type ReviewLimits } from "./proof.ts";
import { cleanFixtures, fixture } from "./proof-testing.ts";

afterEach(cleanFixtures);

const repository = "example/product";
const pr = 7;
const major = "FINDINGS:\n- src/app.ts:1 | major | Correctness | the count is off by one | count from zero | anchor: app\nCOVERED: src/app.ts\n";
const clean = "FINDINGS:\n- src/app.ts:1 | minor | Design | a name reads plain | rename it | anchor: app\nCOVERED: src/app.ts\n";
const continues: Arbiter = async () => ({ verdict: "continue", reason: "", model: "arbiter-under-test" });
const escalates: Arbiter = async () => ({ verdict: "escalate", reason: "Final read 1 asks to undo the fix round 1 asked for", model: "arbiter-under-test" });
const unasked: Arbiter = async () => { throw new Error("the arbiter was asked"); };
const roomy: ReviewLimits = { free: 10, ceiling: 10 };

function gitRepo() {
  const directory = fixture("hedge-proof-carry-");
  const [home, cwd, bin] = ["home", "repo", "bin"].map((name) => join(directory, name));
  for (const path of [home, cwd, bin]) mkdirSync(path);
  const ghCalls = join(directory, "gh-calls");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${ghCalls}"\necho '{"base":{"ref":"main"}}'\n`, { mode: 0o755 });
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
  const commit = (message: string, files: Record<string, string>) => { write(files); git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD").stdout; };
  const advanceBase = (files: Record<string, string>) => {
    git("checkout", "-q", "main");
    commit("Change the base", files);
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "feature");
  };
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  return { home, run, git, write, commit, advanceBase, ghCalls, start: () => { git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-q", "-b", "feature"); } };
}

type Repo = ReturnType<typeof gitRepo>;
const at = (commit: string): ProofIdentity => ({ repository, pr, commit });
const netDelta = (repo: Repo) => netDeltaIn(repo.run, () => baseRefs(at(""), repo.run));

async function finish(repo: Repo, commit: string, id: number | `final-${number}`, findings: string) {
  const path = join(repo.home, `findings-${id}.md`);
  writeFileSync(path, findings);
  await finishReview(repo.home, at(commit), id, path, "gpt-6.2-sol");
}

async function reviewedPanel(repo: Repo, commit: string, findings = clean) {
  const { directory } = await startReview(repo.home, at(commit), { scope: "full", arbiter: unasked, limits: roomy });
  writeFileSync(join(directory, "panel.json"), "{}");
  await finish(repo, commit, 1, findings);
}

const finalRead = (repo: Repo, commit: string, base: string, arbiter: Arbiter, limits = roomy) =>
  startReview(repo.home, at(commit), { scope: "final", base, arbiter, limits, netDelta: netDelta(repo) });

async function reviewLine(repo: Repo, commit: string) {
  const gate = await proofGate(repo.home, at(commit), {
    ci: () => ({ state: "green", detail: "1 check(s)" }), pushedHead: () => ({ commit, body: "" }), ledger: localLedger(repo.home),
    cleanBaseMerge: cleanBaseMerge(at(commit), repo.run), netDelta: netDelta(repo),
  });
  return gate.lines.find((line) => line.startsWith("review:"));
}

test("a clean merge of the base carries the review, writes its receipt, and needs no final read", async () => {
  const repo = gitRepo();
  repo.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  repo.start();
  const reviewed = repo.commit("Count the app", { "src/app.ts": "export const app = 2;\n" });
  await reviewedPanel(repo, reviewed);
  repo.advanceBase({ "src/other.ts": "export const other = 3;\n" });
  repo.git("merge", "-q", "--no-edit", "origin/main");
  const merged = repo.git("rev-parse", "HEAD").stdout;

  expect(await reviewLine(repo, merged)).toBe(`review: HEAD carried from ${reviewed.slice(0, 7)}: nothing changed past it and the base (round 1 by gpt-6.2-sol)`);
  expect(JSON.parse(readFileSync(join(pullRequestDirectory(repo.home, at(merged)), "carried", `${merged}.json`), "utf8"))).toMatchObject({ commit: merged, from: reviewed });
  await expect(finalRead(repo, merged, reviewed, unasked)).rejects.toThrow(`HEAD needs no final read: nothing changed past ${reviewed.slice(0, 7)} and the base`);
});

test("a change and its revert by content carry the review", async () => {
  const repo = gitRepo();
  repo.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  repo.start();
  const reviewed = repo.commit("Count the app", { "src/app.ts": "export const app = 2;\n" });
  await reviewedPanel(repo, reviewed);
  repo.commit("Try a fix", { "src/app.ts": "export const app = 3;\n", "src/fix.ts": "export const fix = true;\n" });
  repo.git("rm", "-q", "src/fix.ts");
  const back = repo.commit("Take the fix back", { "src/app.ts": "export const app = 2;\n" });

  expect(await reviewLine(repo, back)).toBe(`review: HEAD carried from ${reviewed.slice(0, 7)}: nothing changed past it and the base (round 1 by gpt-6.2-sol)`);
});

test("a test-only change takes a final read of just that file", async () => {
  const repo = gitRepo();
  repo.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  repo.start();
  const reviewed = repo.commit("Count the app", { "src/app.ts": "export const app = 2;\n" });
  await reviewedPanel(repo, reviewed);
  repo.advanceBase({ "src/other.ts": "export const other = 3;\n" });
  repo.git("merge", "-q", "--no-edit", "origin/main");
  const tested = repo.commit("Test the count", { "src/app.test.ts": "expect(app).toBe(2);\n" });

  expect(await reviewLine(repo, tested)).toBe(`review: HEAD not reviewed, last review covered ${reviewed.slice(0, 7)}; 1 file(s) changed past it and the base. Read them with hedge proof review --scope final --base ${reviewed}`);
  expect(netDelta(repo)(reviewed, tested)?.files).toEqual(["src/app.test.ts"]);
  const range = repo.run(["git", "diff", "--name-only", `${netDelta(repo)(reviewed, tested)!.tree}..${tested}`]);
  expect(range.stdout.trim().split("\n")).toEqual(["src/app.test.ts"]);
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

  expect(netDelta(repo)(reviewed, merged)?.files).toEqual(["testing/ports.md"]);
  expect(await reviewLine(repo, merged)).toBe(`review: HEAD not reviewed, last review covered ${reviewed.slice(0, 7)}; 1 file(s) changed past it and the base. Read them with hedge proof review --scope final --base ${reviewed}`);
});

test("a final read that finds no blocker or major spends no review budget, even past the ceiling", async () => {
  const repo = gitRepo();
  repo.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  repo.start();
  let reviewed = repo.commit("Count the app", { "src/app.ts": "export const app = 2;\n" });
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

test("a final read that finds a major spends the review budget", async () => {
  const repo = gitRepo();
  repo.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  repo.start();
  const reviewed = repo.commit("Count the app", { "src/app.ts": "export const app = 2;\n" });
  await reviewedPanel(repo, reviewed, major);
  const limits = { free: 10, ceiling: 2 };
  const fixed = repo.commit("Fix 1", { "src/app.ts": "export const app = 3;\n" });
  await finalRead(repo, fixed, reviewed, unasked, limits);
  await finish(repo, fixed, "final-1", major);
  const again = repo.commit("Fix 2", { "src/app.ts": "export const app = 4;\n" });

  await expect(finalRead(repo, again, fixed, unasked, limits)).rejects.toThrow("The review budget of 2 reviews is spent");
});

test("after an arbiter stop, one final read of the net delta runs without the arbiter, and the next review goes to the user", async () => {
  const repo = gitRepo();
  repo.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  repo.start();
  const reviewed = repo.commit("Count the app", { "src/app.ts": "export const app = 2;\n" });
  await reviewedPanel(repo, reviewed, major);
  const limits = { free: 1, ceiling: 10 };
  const fixed = repo.commit("Fix the count", { "src/app.ts": "export const app = 3;\n" });
  await expect(finalRead(repo, fixed, reviewed, escalates, limits)).rejects.toThrow("The arbiter escalates");

  const reverted = repo.commit("Revert part of the fix", { "src/app.ts": "export const app = 2;\n", "src/app.test.ts": "expect(app).toBe(2);\n" });
  const confirming = await finalRead(repo, reverted, reviewed, unasked, limits);
  expect(confirming.id).toBe("final-1");
  await finish(repo, reverted, "final-1", major);
  const next = repo.commit("Fix the test", { "src/app.test.ts": "expect(app).toBe(3);\n" });

  await expect(finalRead(repo, next, reverted, continues, limits)).rejects.toThrow("The arbiter stopped the loop, and final read 1 confirmed its stop. hedge proof starts no other review: take each blocker or major of final read 1 to the user");
  expect(existsSync(join(pullRequestDirectory(repo.home, at(next)), "reviews", "final-2"))).toBe(false);
});

test("when the checkout lacks HEAD or the reviewed commit, the review carries nothing and the gate never asks GitHub for the base branch", async () => {
  const repo = gitRepo();
  repo.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  repo.start();
  const present = repo.commit("Count the app", { "src/app.ts": "export const app = 2;\n" });
  const missing = "0123456789abcdef0123456789abcdef01234567";

  await reviewedPanel(repo, present);
  expect(await reviewLine(repo, missing)).toBe(`review: HEAD not reviewed, last review covered ${present.slice(0, 7)}`);

  const other = gitRepo();
  other.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  other.start();
  const head = other.commit("Count the app", { "src/app.ts": "export const app = 2;\n" });
  await reviewedPanel(other, missing);
  expect(await reviewLine(other, head)).toBe(`review: HEAD not reviewed, last review covered ${missing.slice(0, 7)}`);

  expect([existsSync(repo.ghCalls), existsSync(other.ghCalls)]).toEqual([false, false]);
});
