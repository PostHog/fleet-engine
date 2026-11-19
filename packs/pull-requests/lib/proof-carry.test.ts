import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitEnv } from "../../../src/testing/git.ts";
import { localLedger } from "./decision-ledger.ts";
import { remotesOf } from "./proof-checkout.ts";
import { proofCommand } from "./proof-cli.ts";
import { netDeltaIn } from "./proof-delta.ts";
import { finishReview, startReview, type Arbiter, type ProofIdentity, type ReviewLimits } from "./proof.ts";
import type { Decision } from "./decision-ledger.ts";
import { checkout, cleanFixtures, fakeModel, finishRound, fixture, graded, hubAt, reviewHead, settings, verdict, type Checkout } from "./proof-testing.ts";

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

test("a fixes round or final read refuses a net delta it cannot read and names the command that recovers", async () => {
  const { repo, reviewed } = reviewedApp();
  await firstRound(repo, reviewed, major);
  const fixed = repo.commit("Fix the count", { "src/app.ts": "export const app = 3;\n" });
  repo.github.base = "f".repeat(40);

  for (const start of [fixesRound, finalRead]) {
    await expect(start(repo, fixed, reviewed, unasked)).rejects.toThrow(`Cannot read what changed past ${short(reviewed)} and the base: the checkout lacks the PR's base ${"f".repeat(7)} and cannot fetch it, so nothing carries. Fetch it with git fetch origin ${"f".repeat(40)}`);
  }
});

test("a final read refused for a full read once the review budget is spent names the user's --override, not --agent", async () => {
  const { repo, reviewed } = reviewedApp();
  await firstRound(repo, reviewed, major);
  const fixed = repo.commit("Fix the count", { "src/app.ts": "export const app = 3;\n" });
  repo.github.base = repo.git("commit-tree", "HEAD^{tree}", "-m", "A base that GitHub rewrote").stdout;

  const refused = await finalRead(repo, fixed, reviewed, unasked, { free: 10, ceiling: 1 }).catch((error: Error) => error.message);
  expect(refused).toContain(`the PR's base on GitHub no longer holds ${short(repo.git("rev-parse", "main").stdout)}, the base that review stood on, so nothing carries. The review budget of 1 reviews is spent, so only the user's --override reads the whole PR again.`);
  expect(refused).toContain(`When they choose "Run one more round", run hedge proof review --scope full with --override`);
  expect(refused).not.toContain("--agent");
});

const usersOverride = { mark: "👤", id: "override-under-test" } as Decision;

for (const [scope, decision] of [["final", undefined], ["final", usersOverride], ["fixes", usersOverride]] as const) {
  test(`a ${scope === "final" ? "final read" : "fixes round"}${decision ? " with the user's --override" : ""} refused for a full read after a confirming read found a major names the user's --override, not --agent`, async () => {
    const { repo, reviewed, fixed, limits } = await stopped(escalates);
    await finalRead(repo, fixed, reviewed, unasked, limits);
    await finish(repo, fixed, "final-1", major);
    const next = repo.commit("Fix it again", { "src/app.ts": "export const app = 4;\n" });
    repo.github.base = repo.git("commit-tree", "HEAD^{tree}", "-m", "A base that GitHub rewrote").stdout;

    const refused = await startReview(repo.home, at(next), { scope, base: fixed, decision, arbiter: unasked, limits, netDelta: netDelta(repo), baseSha: repo.github.base }).catch((error: Error) => error.message);
    expect(refused).toContain("The arbiter stopped the loop, and final read 1 confirmed its stop, so only the user's --override reads the whole PR again.");
    expect(refused).toContain(`When they choose "Run one more round", run hedge proof review --scope full with --override`);
    expect(refused).not.toContain("--agent");
  });
}

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

test("an override whose ledger append failed leaves the arbiter's stop, so a later read still confirms it", async () => {
  const { pr, reviewed } = await stoppedCheckout();
  hubAt(pr, "drops appends");
  pr.choose("Run one more round", question);
  await expect(pr.hedge("review-start", "--scope", "final", "--base", reviewed, ...override)).rejects.toThrow("Not recorded");
  await pr.commit("feature.txt", "fixed again\n");

  const started = JSON.parse((await pr.hedge("review-start", "--scope", "final", "--base", reviewed)).output);
  expect(started.confirms).toStartWith("This final read confirms the arbiter's stop (Round 2 undoes the rename round 1 asked for)");
});

test("an override's retry, once the hub is back, records it and clears the arbiter's stop", async () => {
  const { pr, reviewed } = await stoppedCheckout();
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round", question);
  const start = ["review-start", "--scope", "final", "--base", reviewed, ...override];
  await expect(pr.hedge(...start)).rejects.toThrow("Not recorded");
  hub.state.hub = "up";

  const resumed = JSON.parse((await pr.hedge(...start)).output);
  expect(resumed).toMatchObject({ round: "final", id: "final-1" });
  expect(resumed.confirms).toBeUndefined();
  await finishRound(pr, "final-1");
  const read = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "fixed again\n");
  await expect(pr.hedge("review-start", "--scope", "final", "--base", read)).rejects.toThrow("The arbiter escalates");
});

test("an override clears only the stop it was reserved against: a stop that a fixes round saves while its ledger append fails stays", async () => {
  const { pr, reviewed } = await stoppedCheckout();
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round", question);
  const start = ["review-start", "--scope", "final", "--base", reviewed, ...override];
  await expect(pr.hedge(...start)).rejects.toThrow("Not recorded");
  await pr.hedge("require", "--none", "--reason", "docs only");
  await expect(pr.hedge("review", "--single", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("The arbiter escalates");
  hub.state.hub = "up";
  await pr.hedge(...start);
  await finishRound(pr, "final-1");
  const read = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "fixed again\n");

  const started = JSON.parse((await pr.hedge("review-start", "--scope", "final", "--base", read)).output);
  expect(started.confirms).toStartWith("This final read confirms the arbiter's stop (Round 2 undoes the rename round 1 asked for)");
});

const proofEntry = resolve(import.meta.dir, "../commands/proof.ts");
const spawnHedge = (pr: Checkout, ...args: string[]) =>
  Bun.spawn([process.execPath, proofEntry, ...args], { cwd: pr.repository, env: { ...pr.env, HOME: pr.home, HEDGE_DEBUG: "" }, stdout: "pipe", stderr: "pipe" });
const finished = async (child: ReturnType<typeof spawnHedge>) => {
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};

const shellWord = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
const hedgeLine = (...args: string[]) => [process.execPath, proofEntry, ...args].map(shellWord).join(" ");
const busy = (holder: number, pr: Checkout) => `Process ${holder}, another hedge proof command, works on the reviews in ${pr.pullRequest} and holds its lock ${join(pr.pullRequest, "reviews.lock")}. Wait for it to end, then run this command again`;

test("a hedge process that starts a final read while another weighs its arbiter waits for it, then confirms the stop the first one saved", async () => {
  const pr = await checkout();
  const reviewed = await pr.commit("feature.txt", "new\n");
  for (const round of ["1", "2"]) {
    await pr.hedge("review-start", ...(round === "1" ? ["--scope", "full"] : ["--scope", "fixes", "--base", reviewed]));
    await finishRound(pr, round);
  }
  await pr.commit("feature.txt", "fixed\n");
  const second = join(pr.home, "second.log");
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; if mkdir '${pr.home}/asked' 2>/dev/null; then ${hedgeLine("review-start", "--scope", "final", "--base", reviewed)} > '${second}' 2>&1; fi; echo 'ESCALATE: Round 2 undoes the rename round 1 asked for.'`;

  const first = spawnHedge(pr, "review-start", "--scope", "final", "--base", reviewed);
  expect((await finished(first)).stderr).toContain("The arbiter escalates: Round 2 undoes the rename round 1 asked for.");
  expect(readFileSync(second, "utf8")).toContain(busy(first.pid, pr));
  const confirming = JSON.parse((await pr.hedge("review-start", "--scope", "final", "--base", reviewed)).output);
  expect(confirming.confirms).toStartWith("This final read confirms the arbiter's stop (Round 2 undoes the rename round 1 asked for)");
});

test("review-finish while hedge proof review --single reads the same round waits for it, so the reviewer's findings land and the author's do not", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.hedge("require", "--none", "--reason", "docs only");
  await pr.commit("feature.txt", "greet\n");
  writeFileSync(join(pr.repository, "findings.md"), "The author's findings.\n");
  const finishing = join(pr.home, "finish.log");
  pr.env.HEDGE_PROOF_REVIEWER = `cat >/dev/null; ${hedgeLine("review-finish", "--round", "1", "--reviewer", "gpt-6.2-sol", "findings.md")} > '${finishing}' 2>&1; echo "exit $?" >> '${finishing}'; echo 'No findings, the greeting is right.'`;

  const review = spawnHedge(pr, "review", "--single");
  const reviewed = await finished(review);
  expect(reviewed.code).toBe(0);
  expect(reviewed.stdout).toContain("No findings, the greeting is right.");
  expect(readFileSync(finishing, "utf8")).toContain(busy(review.pid, pr));
  expect(readFileSync(finishing, "utf8")).toEndWith("exit 1\n");
  await expect(pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.2-sol", "findings.md")).rejects.toThrow("Round 1 already has other findings");
});

test("an arbiter escalation keeps the gate's saved result", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict());
  expect((await pr.hedge("gate")).code).toBe(0);
  const notGated = "the gate has not run at HEAD";
  expect((await pr.decide("report", "--pr", "example/product#42")).output).not.toContain(notGated);
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 0 });
  pr.env.HEDGE_REVIEW_ARBITER = escalate;

  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", head)).rejects.toThrow("The arbiter escalates");
  expect((await pr.decide("report", "--pr", "example/product#42")).output).not.toContain(notGated);
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

async function panelReviewed(pr: Checkout, files: Record<string, string> = { "feature.txt": "greet\n" }) {
  await pr.hedge("require", "--none", "--reason", "docs only");
  for (const [file, content] of Object.entries(files)) await pr.commit(file, content);
  const reviewed = await pr.git("rev-parse", "HEAD");
  const reviewer = fakeModel(pr, "REVIEWER", covering(...Object.keys(files)));
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
  expect(await reviewLine(pr)).toBe(`review: HEAD not reviewed, last review covered ${short(reviewed)}; ${rewound}, or with the user's --override once the review budget is spent`);
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
  const { reviewed } = await panelReviewed(pr, { "shared.txt": "one\n| 2 | pr |\n" });
  await pr.advanceBase("shared.txt", "one\n| 3 | base |\n");
  await pr.git("merge", "-q", "main");
  writeFileSync(join(pr.repository, "shared.txt"), "one\n| 2 | pr |\n| 3 | base |\n");
  await pr.git("add", "shared.txt");
  await pr.git("commit", "-q", "--no-edit");

  expect(await reviewLine(pr)).toBe(finalReadLine(reviewed, 1));
});

const list = "the $HOME list.txt";

async function conflicted(pr: Checkout) {
  await pr.advanceBase("logo.bin", "logo\0one\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const panel = await panelReviewed(pr, { "logo.bin": "logo\0two\n", [list]: "the reviewed side\n" });
  await pr.git("checkout", "-q", "main");
  await pr.commit("logo.bin", "logo\0three\n");
  await pr.commit(list, "the base side\n");
  await pr.git("update-ref", "refs/remotes/origin/main", "HEAD");
  await pr.git("checkout", "-q", "feature");
  await pr.git("merge", "-q", "main");
  await pr.git("checkout", "-q", "--ours", "logo.bin");
  writeFileSync(join(pr.repository, list), "the reviewed side and the base side\n");
  await pr.git("add", "logo.bin", list);
  await pr.git("commit", "-q", "--no-edit");
  return { ...panel, base: await pr.git("rev-parse", "main") };
}

test("a conflict never carries, a binary one that leaves no markers too, and its final read shows HEAD against each side and needs the file covered", async () => {
  const pr = await checkout();
  const { reviewed, reviewer, base } = await conflicted(pr);

  expect(await reviewLine(pr)).toBe(finalReadLine(reviewed, 2));
  reviewer.answer(covering(list));
  await pr.hedge("review", "--lens", "correctness", "--scope", "final", "--base", reviewed);
  expect((await pr.hedge("review", "--wait")).output).toContain("COVERED misses logo.bin");
  const brief = reviewer.prompts().at(-1)!;
  const conflict = brief.slice(brief.indexOf(`# Conflict in ${list}: `));
  expect(conflict).toContain(`the merge of the reviewed head ${reviewed} with the base ${base} leaves it in conflict, and HEAD resolves it.`);
  expect(conflict).toMatch(/# HEAD against the reviewed head:\n[^#]*-the reviewed side\n\+the reviewed side and the base side\n[^#]*# HEAD against the base:\n[^#]*-the base side\n\+the reviewed side and the base side\n/);
  expect(brief).toContain("# Conflict in logo.bin: ");
});

test("the conflict brief quotes each git show argument, so a file name with a space, a $ and a quote reads as one word", async () => {
  const pr = await checkout();
  const name = "it's $HOME.txt";
  await pr.advanceBase(name, "one\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const { reviewed, reviewer } = await panelReviewed(pr, { [name]: "two\n" });
  await pr.advanceBase(name, "three\n");
  await pr.git("merge", "-q", "main");
  writeFileSync(join(pr.repository, name), "two and three\n");
  await pr.git("add", name);
  await pr.git("commit", "-q", "--no-edit");
  reviewer.answer(covering(name));
  await pr.hedge("review", "--scope", "final", "--base", reviewed);

  const [, reviewedSide, baseSide] = /Read both sides with (.*) and (git show .*)\.\n/.exec(reviewer.prompts().at(-1)!)!;
  const show = (command: string) => Bun.spawnSync(["sh", "-c", command!], { cwd: pr.repository, env: pr.env }).stdout.toString();
  expect([show(reviewedSide!), show(baseSide!)]).toEqual(["two\n", "three\n"]);
});

const fakeToken = ["gh", "p_", "x1".repeat(18)].join("");

test("a secret in the name of a directory with a REVIEW.md on the base reaches no prompt: not the panel's lens, the final read of its conflict, nor the eval replay", async () => {
  const pr = await checkout();
  const directory = `keys-${fakeToken}`;
  const name = `${directory}/list.txt`;
  const shown = (path: string) => path.replace(fakeToken, "[redacted GitHub token]");
  mkdirSync(join(pr.repository, directory));
  await pr.advanceBase(`${directory}/REVIEW.md`, "Check each key.\n");
  await pr.advanceBase(name, "one\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewed = await pr.commit(name, "two\n");
  const reviewer = fakeModel(pr, "REVIEWER", covering(shown(name)));
  await pr.hedge("review", "--lens", "correctness");
  const waited = await pr.hedge("review", "--wait");
  expect(waited.code).toBe(0);
  expect(waited.output).not.toContain(fakeToken);
  await pr.advanceBase(name, "three\n");
  await pr.git("merge", "-q", "main");
  writeFileSync(join(pr.repository, name), "two and three\n");
  await pr.git("add", name);
  await pr.git("commit", "-q", "--no-edit");
  reviewer.answer("No findings.\n");
  await pr.hedge("review", "--scope", "final", "--base", reviewed);
  await pr.hedge("miss", "--source", "human", "--finding", "The list drops the reviewed side");
  pr.env.HEDGE_PROOF_EVAL_JUDGE = judgedMissed;

  expect((await pr.hedge("eval")).output).toContain("missed: the review names nothing");
  const prompts = reviewer.prompts();
  for (const prompt of prompts) {
    expect(prompt).toContain(`### ${shown(directory)}/REVIEW.md\n\nCheck each key.`);
    expect(prompt).not.toContain(fakeToken);
  }
  for (const prompt of prompts.slice(-2)) expect(prompt).toContain(`# Conflict in ${shown(name)}: `);
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

const majorFinding = "FINDINGS:\n- feature.txt:1 | major | Correctness | the greeting drops the name | greet by name | anchor: greet\nCOVERED: feature.txt\n";

test("a fixes round after a final read starts at the final read's head, so its reviewer gets a revert to the panel's content and the helper change", async () => {
  const pr = await checkout();
  const { reviewed, reviewer } = await panelReviewed(pr);
  await pr.commit("helper.txt", "help\n");
  const read = await pr.commit("feature.txt", "greet the member\n");
  reviewer.answer(majorFinding);
  await pr.hedge("review", "--scope", "final", "--base", reviewed);
  await pr.commit("helper.txt", "help more\n");
  await pr.commit("feature.txt", "greet\n");
  reviewer.answer("No findings.\n");

  await expect(pr.hedge("review", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(`Round 2 needs --base ${read}, the commit of final read 1, the latest finished review`);
  await pr.hedge("review", "--scope", "fixes", "--base", read);
  const brief = reviewer.prompts().at(-1)!;
  expect(brief).toContain("-greet the member\n+greet\n");
  expect(brief).toContain("-help\n+help more\n");
});

const failingReviewer = "cat >/dev/null; echo 'the reviewer broke' >&2; exit 3";

for (const path of [["review", "--single"], ["review", "--lens", "correctness"]]) {
  test(`${path.join(" ")} retried after the base on GitHub took in a PR commit reads the range and REVIEW.md of the base its round recorded`, async () => {
    const pr = await checkout();
    await pr.hedge("require", "--none", "--reason", "docs only");
    await pr.advanceBase("REVIEW.md", "Check the recorded rule.\n");
    await pr.git("merge", "-q", "--no-edit", "main");
    const absorbed = await pr.commit("feature.txt", "greet\n");
    await pr.commit("helper.txt", "help\n");
    pr.env.HEDGE_PROOF_REVIEWER = failingReviewer;
    await pr.hedge(...path).catch(() => undefined);
    await pr.git("checkout", "-q", "main");
    await pr.git("merge", "-q", "--ff-only", absorbed);
    await pr.commit("REVIEW.md", "Check the moved rule.\n");
    pr.githubBase(await pr.git("rev-parse", "HEAD"));
    await pr.git("checkout", "-q", "feature");
    const reviewer = fakeModel(pr, "REVIEWER", covering("feature.txt", "helper.txt"));

    await pr.hedge(...path);
    if (path.includes("--lens")) await pr.hedge("review", "--wait");
    const brief = reviewer.prompts().at(-1)!;
    expect(patchFiles(readPatch(pr, "1"))).toEqual(["feature.txt", "helper.txt"]);
    expect(brief).toContain("Check the recorded rule.");
    expect(brief).not.toContain("Check the moved rule.");
  });
}

const olderHedge = (pr: Checkout, round: string, drop: string) => {
  const path = join(pr.pullRequest, "reviews", round, "round.json");
  const { [drop]: _, ...older } = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify(older));
};

for (const lens of [[], ["--lens", "correctness"]]) {
  test(`an unfinished final ${lens.length ? "panel" : "read"} that an older Hedge reserved is refused by review and review --wait, and runs again once its directory is deleted`, async () => {
    const pr = await checkout();
    const { reviewed } = await panelReviewed(pr);
    await pr.commit("feature.txt", "greet the member\n");
    pr.env.HEDGE_PROOF_REVIEWER = failingReviewer;
    const command = ["review", ...lens, "--scope", "final", "--base", reviewed];
    await pr.hedge(...command).catch(() => undefined);
    olderHedge(pr, "final-1", "merged");

    const refusal = `Review final-1 was reserved by an older Hedge, which recorded no merged start or base on GitHub, so it cannot resume. Delete it with rm -rf '${join(pr.pullRequest, "reviews", "final-1")}', then run the hedge proof review command you ran for it again`;
    await expect(pr.hedge(...command)).rejects.toThrow(refusal);
    await expect(pr.hedge("review", "--wait")).rejects.toThrow(refusal);
    expect(Bun.spawnSync(["sh", "-c", /rm -rf '[^']*'/.exec(refusal)![0]]).exitCode).toBe(0);
    fakeModel(pr, "REVIEWER", covering("feature.txt"));
    expect((await pr.hedge(...command)).code).toBe(0);
    if (lens.length) expect((await pr.hedge("review", "--wait")).code).toBe(0);
    expect(await reviewLine(pr)).toStartWith("review: HEAD reviewed in final read 1");
  });
}

test("a final read whose --base is a clean merge of a base GitHub never had reads from the latest reviewed head, so the merged commits stay in its patch", async () => {
  const pr = await checkout();
  const { reviewed } = await panelReviewed(pr);
  pr.githubBase(await pr.git("rev-parse", "main"));
  await pr.advanceBase("slipped.txt", "a base GitHub never had\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const merge = await pr.git("rev-parse", "HEAD");
  await noteNothing(pr);

  expect((await pr.hedge("review", "--scope", "final", "--base", merge)).code).toBe(0);
  expect(patchFiles(readPatch(pr, "final-1"))).toEqual(["slipped.txt"]);
});

test("the gate fetches a PR base that the checkout lacks from a remote of the PR's repository, and carries nothing when it cannot fetch it", async () => {
  const pr = await checkout();
  const { reviewed } = await panelReviewed(pr);
  const github = join(pr.home, "github.com", "example", "product.git");
  await pr.git("init", "-q", "--bare", github);
  await pr.git("push", "-q", github, "main:refs/heads/main");
  const onGithub = (...args: string[]) => Bun.spawnSync(["git", "-C", github, ...args], { env: pr.env }).stdout.toString().trim();
  const moved = onGithub("commit-tree", "main^{tree}", "-p", "main", "-m", "The base moves on GitHub");
  onGithub("update-ref", "refs/heads/main", moved);
  await pr.git("remote", "set-url", "origin", github);
  await noteNothing(pr);
  pr.githubBase(moved);

  expect(Bun.spawnSync(["git", "cat-file", "-e", `${moved}^{commit}`], { cwd: pr.repository, env: pr.env }).exitCode).not.toBe(0);
  expect(await reviewLine(pr)).toStartWith(carried(reviewed));
  pr.githubBase("f".repeat(40));
  expect(await reviewLine(pr)).toBe(`review: HEAD not reviewed, last review covered ${short(reviewed)}; the checkout lacks the PR's base fffffff and cannot fetch it, so nothing carries. Fetch it with git fetch origin ${"f".repeat(40)}`);
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

const judgedMissed = "cat >/dev/null; echo 'NOT NAMED: the review names nothing'";

test("a reviewer miss after a final read replays in hedge proof eval with the patch the reviewer read and the REVIEW.md of the PR's base", async () => {
  const pr = await checkout();
  await pr.advanceBase("REVIEW.md", "Check the base rule.\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const { reviewed, reviewer } = await panelReviewed(pr, { "REVIEW.md": "Check the PR rule.\n", "feature.txt": "greet\n" });
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.txt", "greet the member\n");
  reviewer.answer("No findings.\n");
  await pr.hedge("review", "--scope", "final", "--base", reviewed);
  await pr.hedge("miss", "--source", "human", "--finding", "The greeting drops the member's name");
  pr.env.HEDGE_PROOF_EVAL_JUDGE = judgedMissed;

  expect((await pr.hedge("eval")).output).toContain("example/product#42 (human): missed: the review names nothing");
  const replayed = reviewer.prompts().at(-1)!;
  expect(replayed).toContain(readPatch(pr, "final-1"));
  expect(patchFiles(readPatch(pr, "final-1"))).toEqual(["feature.txt"]);
  expect(replayed).toContain("Check the base rule.");
  expect(replayed).not.toContain("Check the PR rule.");
});

test("a reviewer miss after a final read of a conflict replays HEAD against each side, as the reviewer read it", async () => {
  const pr = await checkout();
  const { reviewed, reviewer } = await conflicted(pr);
  reviewer.answer(covering("logo.bin", list));
  await pr.hedge("review", "--scope", "final", "--base", reviewed);
  await pr.hedge("miss", "--source", "human", "--finding", "The list drops the reviewed side");
  pr.env.HEDGE_PROOF_EVAL_JUDGE = judgedMissed;

  expect((await pr.hedge("eval")).output).toContain("missed: the review names nothing");
  expect(readPatch(pr, "final-1")).toContain("# Conflict in logo.bin: ");
  expect(reviewer.prompts().at(-1)).toContain(readPatch(pr, "final-1"));
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
