import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitEnv } from "../../../src/testing/git.ts";
import { localLedger } from "./decision-ledger.ts";
import { remotesOf } from "./proof-checkout.ts";
import { proofCommand } from "./proof-cli.ts";
import { netDeltaIn } from "./proof-delta.ts";
import { finishReview, proofGate, startReview, type Arbiter, type ProofIdentity, type ReviewLimits } from "./proof.ts";
import { checkout, cleanFixtures, fakeModel, finishRound, fixture, hubAt, type Checkout } from "./proof-testing.ts";

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
const fullRead = "Read the whole PR again with hedge proof review --scope full and --agent '<your reason>'";

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
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  const start = () => { github.base = git("rev-parse", "HEAD").stdout; git("update-ref", "refs/remotes/origin/main", github.base); git("checkout", "-q", "-b", "feature"); };
  return { home, cwd, env, run, git, commit, github, start };
}

type Repo = ReturnType<typeof gitRepo>;
const at = (commit: string): ProofIdentity => ({ repository, pr, commit });
const netDelta = (repo: Repo) => netDeltaIn(repo.run, () => remotesOf(repository, repo.run));

async function finish(repo: Repo, commit: string, id: number | `final-${number}`, findings: string) {
  const path = join(repo.home, `findings-${id}.md`);
  writeFileSync(path, findings);
  await finishReview(repo.home, at(commit), id, path, "gpt-6.2-sol");
}

async function firstRound(repo: Repo, commit: string, findings = clean) {
  await startReview(repo.home, at(commit), { scope: "full", arbiter: unasked, limits: roomy, netDelta: netDelta(repo), baseSha: repo.github.base });
  await finish(repo, commit, 1, findings);
}

const finalRead = (repo: Repo, commit: string, base: string, arbiter: Arbiter, limits = roomy) =>
  startReview(repo.home, at(commit), { scope: "final", base, arbiter, limits, netDelta: netDelta(repo), baseSha: repo.github.base });

const fixesRound = (repo: Repo, commit: string, base: string, arbiter: Arbiter, limits = roomy) =>
  startReview(repo.home, at(commit), { scope: "fixes", base, arbiter, limits, netDelta: netDelta(repo), baseSha: repo.github.base });

async function show(repo: Repo, commit: string) {
  const lines: string[] = [];
  await proofCommand(["show", "--repo", repository, "--pr", String(pr), "--commit", commit], { home: repo.home, cwd: repo.cwd, env: repo.env, print: (line) => lines.push(line) });
  return lines[0];
}

function reviewedApp() {
  const repo = gitRepo();
  repo.commit("Add the app", { "src/app.ts": "export const app = 1;\n" });
  repo.start();
  return { repo, reviewed: repo.commit("Count the app", { "src/app.ts": "export const app = 2;\n" }) };
}

test("a final read that finds no blocker or major spends no review budget, so a fixes round still starts past the ceiling", async () => {
  let { repo, reviewed } = reviewedApp();
  await firstRound(repo, reviewed, major);
  const limits = { free: 10, ceiling: 2 };
  for (const [read, count] of [[1, 3], [2, 4], [3, 5]] as const) {
    const head = repo.commit(`Fix ${read}`, { "src/app.ts": `export const app = ${count};\n` });
    expect((await finalRead(repo, head, reviewed, unasked, limits)).id).toBe(`final-${read}`);
    await finish(repo, head, `final-${read}`, clean);
    reviewed = head;
  }
  const next = repo.commit("Fix 4", { "src/app.ts": "export const app = 6;\n" });

  expect((await fixesRound(repo, next, reviewed, unasked, limits)).id).toBe("2");
});

test("the final read the carry asks for runs once the budget is spent, and the fixes round after it does not", async () => {
  const { repo, reviewed } = reviewedApp();
  await firstRound(repo, reviewed, major);
  const limits = { free: 10, ceiling: 2 };
  const fixed = repo.commit("Fix 1", { "src/app.ts": "export const app = 3;\n" });
  await finalRead(repo, fixed, reviewed, unasked, limits);
  await finish(repo, fixed, "final-1", major);
  const again = repo.commit("Fix 2", { "src/app.ts": "export const app = 4;\n" });

  expect((await finalRead(repo, again, fixed, unasked, limits)).id).toBe("final-2");
  await finish(repo, again, "final-2", major);
  const third = repo.commit("Fix 3", { "src/app.ts": "export const app = 5;\n" });
  await expect(fixesRound(repo, third, again, unasked, limits)).rejects.toThrow("The review budget of 2 reviews is spent");
});

test("a fixes round after a final read starts at the final read's head, and the net delta past it holds a revert to the panel's content", async () => {
  const { repo, reviewed } = reviewedApp();
  await firstRound(repo, reviewed, major);
  const read = repo.commit("Fix the count and add a helper", { "src/app.ts": "export const app = 3;\n", "src/helper.ts": "export const help = 1;\n" });
  await finalRead(repo, read, reviewed, unasked);
  await finish(repo, read, "final-1", major);
  const head = repo.commit("Take the count back and tidy the helper", { "src/app.ts": "export const app = 2;\n", "src/helper.ts": "export const help = 2;\n" });

  await expect(fixesRound(repo, head, reviewed, unasked)).rejects.toThrow(`Round 2 needs --base ${read}, the commit of final read 1, the latest finished review`);
  const round = await fixesRound(repo, head, read, unasked);
  expect(round.merged).toMatchObject({ reviewed: read, conflicts: [] });
  expect(repo.git("diff", "--name-only", round.from!, head).stdout.split("\n")).toEqual(["src/app.ts", "src/helper.ts"]);
});

test("a fixes round or final read refuses a net delta it cannot read and names the command that recovers", async () => {
  const { repo, reviewed } = reviewedApp();
  await firstRound(repo, reviewed, major);
  const fixed = repo.commit("Fix the count", { "src/app.ts": "export const app = 3;\n" });
  repo.github.base = "f".repeat(40);

  for (const start of [fixesRound, finalRead]) {
    await expect(start(repo, fixed, reviewed, unasked)).rejects.toThrow(`Cannot read what changed past ${short(reviewed)} and the base: the checkout lacks the PR's base ${"f".repeat(7)} and cannot fetch it, so nothing carries. Fetch it with git fetch origin ${"f".repeat(40)}`);
  }
});

async function stopped(arbiter: Arbiter) {
  const { repo, reviewed } = reviewedApp();
  await firstRound(repo, reviewed, major);
  const limits = { free: 1, ceiling: 10 };
  const fixed = repo.commit("Fix the count", { "src/app.ts": "export const app = 3;\n" });
  await expect(finalRead(repo, fixed, reviewed, arbiter, limits)).rejects.toThrow(arbiter === escalates ? "The arbiter escalates" : "The arbiter gave no verdict: the arbiter timed out");
  return { repo, reviewed, fixed, limits };
}

test("after an arbiter stop, one final read of the net delta runs without the arbiter, and the next review goes to the user", async () => {
  const { repo, reviewed, limits } = await stopped(escalates);
  const reverted = repo.commit("Revert part of the fix", { "src/app.ts": "export const app = 2;\n", "src/app.test.ts": "expect(app).toBe(2);\n" });
  expect((await finalRead(repo, reverted, reviewed, unasked, limits)).id).toBe("final-1");
  await finish(repo, reverted, "final-1", major);
  const next = repo.commit("Fix the test", { "src/app.test.ts": "expect(app).toBe(3);\n" });

  await expect(finalRead(repo, next, reverted, continues, limits)).rejects.toThrow("The arbiter stopped the loop, and final read 1 confirmed its stop. hedge proof starts no other review: take each blocker or major of final read 1 to the user");
  expect(await show(repo, next)).toStartWith(`final read on ${short(reverted)}: finished by gpt-6.2-sol`);
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

test("an escalation that arrives after the reviews moved on saves no stop, so a confirmed stop still holds", async () => {
  const { repo, reviewed } = reviewedApp();
  await firstRound(repo, reviewed, major);
  const limits = { free: 1, ceiling: 10 };
  const fixed = repo.commit("Fix the count", { "src/app.ts": "export const app = 3;\n" });
  const late: Arbiter = async () => {
    await expect(finalRead(repo, fixed, reviewed, escalates, limits)).rejects.toThrow("The arbiter escalates");
    await finalRead(repo, fixed, reviewed, unasked, limits);
    await finish(repo, fixed, "final-1", major);
    return escalates("");
  };

  await expect(finalRead(repo, fixed, reviewed, late, limits)).rejects.toThrow("The reviews changed while the arbiter weighed them, so its verdict is dropped");
  const next = repo.commit("Fix it again", { "src/app.ts": "export const app = 4;\n" });
  await expect(finalRead(repo, next, fixed, unasked, limits)).rejects.toThrow("final read 1 confirmed its stop");
});

const escalate = "cat >/dev/null; echo 'ESCALATE: Round 2 undoes the rename round 1 asked for.'";
const override = ["--override", `2026-10-25 "Run one more round"`, "--thread", "thread-1"];
const question = "Run one more review round? example/product#42: The arbiter escalates: Round 2 undoes the rename round 1 asked for.";

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

test("review-start prints one JSON document, which names a confirming read", async () => {
  const { pr, reviewed } = await stoppedCheckout();

  const started = JSON.parse((await pr.hedge("review-start", "--scope", "final", "--base", reviewed)).output);
  expect(started).toMatchObject({ round: "final", id: "final-1" });
  expect(started.confirms).toStartWith("This final read confirms the arbiter's stop (Round 2 undoes the rename round 1 asked for)");
});

test("an override clears the arbiter's stop only once its own decision is in the ledger", async () => {
  const { pr, reviewed } = await stoppedCheckout();
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round", question);
  await expect(pr.hedge("review-start", "--scope", "final", "--base", reviewed, ...override)).rejects.toThrow("Not recorded");
  rmSync(join(pr.pullRequest, "reviews", "final-1"), { recursive: true });
  hub.state.hub = "up";

  expect(JSON.parse((await pr.hedge("review-start", "--scope", "final", "--base", reviewed)).output).confirms).toStartWith("This final read confirms the arbiter's stop");
});

test("a recorded override clears the arbiter's stop, so the next read asks the arbiter again", async () => {
  const { pr, reviewed } = await stoppedCheckout();
  pr.choose("Run one more round", question);
  expect((await pr.hedge("review-start", "--scope", "final", "--base", reviewed, ...override)).code).toBe(0);
  await finishRound(pr, "final-1");
  const read = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "fixed again\n");

  await expect(pr.hedge("review-start", "--scope", "final", "--base", read)).rejects.toThrow("The arbiter escalates");
});

const patchFiles = (patch: string) => [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);
const readPatch = (pr: Checkout, round: string) => readFileSync(join(pr.pullRequest, "reviews", round, "diff.patch"), "utf8");
const covering = (...files: string[]) => `FINDINGS:\n(none)\nCOVERED: ${files.join(", ")}\n`;

async function panelReviewed(pr: Checkout, file = "feature.txt", content = "greet\n") {
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewed = await pr.commit(file, content);
  const reviewer = fakeModel(pr, "REVIEWER", covering(file));
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  return { reviewed, reviewer };
}

const reviewLine = async (pr: Checkout, cwd = pr.repository) => (await pr.hedgeIn(cwd, "gate")).output.split("\n").find((line) => line.startsWith("review:"));
const carried = (reviewed: string) => `review: HEAD carried from ${short(reviewed)}: nothing changed past it and the base (round 1 by `;
const finalReadLine = (reviewed: string, files: number) => `review: HEAD not reviewed, last review covered ${short(reviewed)}; ${files} file(s) changed past it and the base. Read them with hedge proof review --scope final --base ${reviewed}`;
const noteNothing = (pr: Checkout) => pr.git("commit", "-q", "--allow-empty", "-m", "Note nothing").then(() => pr.git("rev-parse", "HEAD"));

test("a clean merge of the base carries the review, writes its receipt, and needs no final read", async () => {
  const pr = await checkout();
  const { reviewed } = await panelReviewed(pr);
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const merged = await pr.git("rev-parse", "HEAD");

  expect(await reviewLine(pr)).toStartWith(carried(reviewed));
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "carried", `${merged}.json`), "utf8"))).toMatchObject({ commit: merged, from: reviewed });
  await expect(pr.hedge("review-start", "--scope", "final", "--base", reviewed)).rejects.toThrow(`HEAD needs no final read: nothing changed past ${short(reviewed)} and the base`);
});

test("a change and its revert by content carry the review", async () => {
  const pr = await checkout();
  const { reviewed } = await panelReviewed(pr);
  await pr.commit("fix.txt", "a fix\n");
  await pr.git("rm", "-q", "fix.txt");
  await pr.commit("feature.txt", "greet the member\n");
  await pr.commit("feature.txt", "greet\n");

  expect(await reviewLine(pr)).toStartWith(carried(reviewed));
});

test("the carry takes the PR's base from GitHub, never from a remote-tracking ref of the checkout", async () => {
  const pr = await checkout();
  const { reviewed } = await panelReviewed(pr);
  pr.githubBase(await pr.git("rev-parse", "main"));
  await pr.advanceBase("slipped.txt", "a base GitHub never had\n");
  await pr.git("merge", "-q", "--no-edit", "main");

  expect(await reviewLine(pr)).toBe(finalReadLine(reviewed, 1));
});

test("a full read starts at the PR's base on GitHub, so a base that GitHub rewound puts the commits it dropped in the patch", async () => {
  const pr = await checkout();
  await pr.hedge("require", "--none", "--reason", "docs only");
  const before = await pr.git("rev-parse", "main");
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.txt", "greet\n");
  pr.githubBase(before);
  fakeModel(pr, "REVIEWER", covering("base.md", "feature.txt"));

  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect(patchFiles(readPatch(pr, "1"))).toEqual(["base.md", "feature.txt"]);
});

test("after the base on GitHub drops what a review stood on, that review carries nothing, and a final read is refused for a full read", async () => {
  const pr = await checkout();
  const before = await pr.git("rev-parse", "main");
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const dropped = await pr.git("rev-parse", "main");
  const { reviewed } = await panelReviewed(pr);
  pr.githubBase(before);
  await noteNothing(pr);

  const rewound = `the PR's base on GitHub no longer holds ${short(dropped)}, the base that review stood on, so nothing carries. ${fullRead}`;
  expect(await reviewLine(pr)).toBe(`review: HEAD not reviewed, last review covered ${short(reviewed)}; ${rewound}`);
  await expect(pr.hedge("review", "--scope", "final", "--base", reviewed)).rejects.toThrow(`Cannot read what changed past ${short(reviewed)} and the base: ${rewound}`);
});

test("the gate refuses its result when the PR's base on GitHub moves between its reads", async () => {
  const pr = await checkout();
  await panelReviewed(pr);
  pr.whileGithubReadsPull(`printf '%s' ${"f".repeat(40)} > "$(dirname "$0")/base-sha"`);

  const gate = await pr.hedge("gate");
  expect(gate.code).not.toBe(0);
  expect(gate.output).toContain(`head: the PR's base on GitHub moved from ${short(await pr.git("rev-parse", "main"))} to fffffff while the gate ran; run the gate again`);
});

test("a base merge's ledger conflict resolution is part of the net delta", async () => {
  const pr = await checkout();
  const { reviewed } = await panelReviewed(pr, "shared.txt", "one\n| 2 | pr |\n");
  await pr.advanceBase("shared.txt", "one\n| 3 | base |\n");
  await pr.git("merge", "-q", "main");
  writeFileSync(join(pr.repository, "shared.txt"), "one\n| 2 | pr |\n| 3 | base |\n");
  await pr.git("add", "shared.txt");
  await pr.git("commit", "-q", "--no-edit");

  expect(await reviewLine(pr)).toBe(finalReadLine(reviewed, 1));
});

test("a conflict that leaves no markers, such as in a binary file, never carries, and its final read shows both sides and needs the file covered", async () => {
  const pr = await checkout();
  await pr.advanceBase("logo.bin", "logo\0one\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const { reviewed, reviewer } = await panelReviewed(pr, "logo.bin", "logo\0two\n");
  await pr.advanceBase("logo.bin", "logo\0three\n");
  await pr.git("merge", "-q", "main");
  await pr.git("checkout", "-q", "--ours", "logo.bin");
  await pr.git("add", "logo.bin");
  await pr.git("commit", "-q", "--no-edit");
  const base = await pr.git("rev-parse", "main");

  expect(await reviewLine(pr)).toBe(finalReadLine(reviewed, 1));
  reviewer.answer(covering("feature.txt"));
  await pr.hedge("review", "--lens", "correctness", "--scope", "final", "--base", reviewed);
  expect((await pr.hedge("review", "--wait")).output).toContain("COVERED misses logo.bin");
  expect(readPatch(pr, "final-1")).toContain(`# Conflict in logo.bin: the merge of the reviewed head ${reviewed} with the base ${base} leaves it in conflict, and HEAD resolves it`);
  expect(reviewer.prompts().at(-1)).toContain("# HEAD against the base:");
});

test("a review that recorded no base, as the base version wrote it, carries nothing and asks for a final read, which runs", async () => {
  const pr = await checkout();
  const { reviewed, reviewer } = await panelReviewed(pr);
  const round = join(pr.pullRequest, "reviews", "1", "round.json");
  const { baseSha, ...unrecorded } = JSON.parse(readFileSync(round, "utf8"));
  expect(baseSha).toBe(await pr.git("rev-parse", "main"));
  writeFileSync(round, JSON.stringify(unrecorded));
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");

  expect(await reviewLine(pr)).toBe(`review: HEAD not reviewed, last review covered ${short(reviewed)}; that review recorded no base, so nothing carries. Read what changed past it with hedge proof review --scope final --base ${reviewed}`);
  reviewer.answer("No findings.\n");
  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);
  expect(await reviewLine(pr)).toStartWith("review: HEAD reviewed in final read 1");
});

test("a final read after a base merge sends the reviewer only the test file that changed", async () => {
  const pr = await checkout();
  const { reviewed } = await panelReviewed(pr);
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.test.ts", "expect(greeting).toBe('greet');\n");

  expect(await reviewLine(pr)).toBe(finalReadLine(reviewed, 1));
  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);
  expect(patchFiles(readPatch(pr, "final-1"))).toEqual(["feature.test.ts"]);
});

for (const path of [["review", "--scope", "final"], ["review", "--lens", "correctness", "--scope", "final"]]) {
  test(`${path.join(" ")} reads the whole net delta from the latest reviewed head: a revert to the panel's content and a deleted file stay in its patch`, async () => {
    const pr = await checkout();
    const { reviewed, reviewer } = await panelReviewed(pr);
    reviewer.answer(covering("feature.txt", "helper.txt"));
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

test("a reviewer miss after a final read replays in hedge proof eval", async () => {
  const pr = await checkout();
  const { reviewed, reviewer } = await panelReviewed(pr);
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.txt", "greet the member\n");
  reviewer.answer("No findings.\n");
  await pr.hedge("review", "--scope", "final", "--base", reviewed);
  await pr.hedge("miss", "--source", "human", "--finding", "The greeting drops the member's name");
  pr.env.HEDGE_PROOF_EVAL_JUDGE = "cat >/dev/null; echo 'NOT NAMED: the review names nothing'";

  expect((await pr.hedge("eval")).output).toContain("example/product#42 (human): missed: the review names nothing");
  const replayed = reviewer.prompts().at(-1)!;
  expect(replayed).toContain("-greet\n+greet the member");
  expect(replayed).not.toContain("base.md");
});

const missing = "0123456789abcdef0123456789abcdef01234567";

for (const named of [["--repo", "example/product", "--pr", "42"], []]) {
  test(`a gate in a checkout that lacks HEAD stops before it calls GitHub${named.length ? "" : ", even before it looks up the PR"}`, async () => {
    const pr = await checkout();
    await pr.commit("feature.txt", "new\n");
    const called = join(pr.home, "gh-called");
    writeFileSync(join(pr.env.PATH!.split(":")[0]!, "gh"), `#!/bin/sh\necho "$*" >> "${called}"\nexit 1\n`, { mode: 0o755 });
    const fetch = named.length ? "git fetch origin pull/42/head" : `git fetch origin ${missing}`;

    await expect(pr.hedge("gate", ...named, "--commit", missing)).rejects.toThrow(`HEAD ${short(missing)} is not in this checkout. Fetch it with ${fetch}, then run the gate again`);
    expect(existsSync(called)).toBe(false);
  });
}

test("in a checkout that lacks the reviewed commit, the review carries nothing", async () => {
  const pr = await checkout();
  const { reviewed } = await panelReviewed(pr);
  const other = join(pr.home, "other");
  await pr.git("clone", "-q", "--no-local", "--single-branch", "--branch", "main", pr.repository, other);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", other, ...args], { env: pr.env }).stdout.toString().trim();
  git("remote", "set-url", "origin", "https://github.com/example/product.git");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "feature");
  git("commit", "-q", "--allow-empty", "-m", "Work elsewhere");
  pr.githubHead(git("rev-parse", "HEAD"));

  expect(await reviewLine(pr, other)).toBe(`review: HEAD not reviewed, last review covered ${short(reviewed)}; the checkout lacks ${short(reviewed)}, so nothing carries. Fetch it with git fetch origin ${reviewed}`);
});
