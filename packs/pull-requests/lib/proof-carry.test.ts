import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitEnv } from "../../../src/testing/git.ts";
import { remotesOf } from "./proof-checkout.ts";
import { proofCommand } from "./proof-cli.ts";
import { netDeltaIn } from "./proof-delta.ts";
import { finishReview, startReview, type Arbiter, type ProofIdentity, type ReviewLimits } from "./proof.ts";
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
  const { repo, reviewed } = reviewedApp();
  await firstRound(repo, reviewed, major);
  const limits = { free: 10, ceiling: 2 };
  let latest = reviewed;
  for (const [read, count] of [[1, 3], [2, 4], [3, 5]] as const) {
    const head = repo.commit(`Fix ${read}`, { "src/app.ts": `export const app = ${count};\n` });
    expect((await finalRead(repo, head, latest, unasked, limits)).id).toBe(`final-${read}`);
    await finish(repo, head, `final-${read}`, clean);
    latest = head;
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
  await expect(fixesRound(repo, third, reviewed, unasked, limits)).rejects.toThrow("The review budget of 2 reviews is spent");
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

test("files that a killed review command leaves beside the reviews lock and the arbiter's stop keep the gate's saved result", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict());
  expect((await pr.hedge("gate")).code).toBe(0);
  for (const left of ["reviews.lock.claim-killed", "arbiter-stop.json.killed"]) writeFileSync(join(pr.pullRequest, left), `{"pid":1}`);

  expect((await pr.decide("report", "--pr", "example/product#42")).output).not.toContain("the gate has not run at HEAD");
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

test("an override clears no arbiter stop: after a confirming read found a major, every later review still takes the user's --override", async () => {
  const { pr, reviewed } = await stoppedCheckout();
  const confirming = await pr.git("rev-parse", "HEAD");
  await pr.hedge("review-start", "--scope", "final", "--base", reviewed);
  await finishRound(pr, "final-1");
  await pr.commit("feature.txt", "fixed again\n");
  pr.choose("Run one more round", question);
  expect((await pr.hedge("review-start", "--scope", "final", "--base", confirming, ...override)).code).toBe(0);
  await finishRound(pr, "final-2");
  const read = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "fixed once more\n");

  await expect(pr.hedge("review-start", "--scope", "final", "--base", read)).rejects.toThrow("The arbiter stopped the loop, and final read 1 confirmed its stop. hedge proof starts no other review");
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
  return panel;
}

test("a conflict never carries, a binary one that leaves no markers too", async () => {
  const pr = await checkout();
  const { reviewed } = await conflicted(pr);

  expect(await reviewLine(pr)).toBe(finalReadLine(reviewed, 2));
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
  expect(await reviewLine(pr)).toBe(`review: HEAD not reviewed, last review covered ${short(reviewed)}; the checkout lacks the PR's base fffffff and cannot fetch it, so nothing carries. Fetch it with git fetch origin ${"f".repeat(40)}, or read what changed past it with hedge proof review --scope final --base ${reviewed}`);
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

  expect(await reviewLine(pr, other)).toBe(`review: HEAD not reviewed, last review covered ${short(reviewed)}; the checkout lacks ${short(reviewed)}, so nothing carries. Fetch it with git fetch origin ${reviewed}, or read what changed past it with hedge proof review --scope final --base ${reviewed}`);
});
