import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guard } from "../../base/hooks/secret-guard.ts";
import { cleanFixtures, checkout, fakeModel, graded, reviewHead, verdict, acceptGap, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const body = (length: number, seed = 0) => Array.from({ length }, (_, index) => "a1B2c3D4e5"[(index + seed) % 10]).join("");
const token = (seed = 0) => ["gh", "p_", body(36, seed)].join("");
const cookieName = ["metabase", "SESSION"].join(".");
const cookieValue = `${body(8)}-${body(4)}-${body(4)}-${body(4)}-${body(12)}`;
const privateKey = (label: string) => [`-----BEGIN ${label} KEY-----`, body(64), body(64, 3), `-----END ${label} KEY-----`].join("\n");

const guardPasses = (prompt: string) => guard("codex", { hook_event_name: "UserPromptSubmit", prompt }) === undefined;

function storedFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? storedFiles(path) : [readFileSync(path, "utf8")];
  });
}

function leaksIn(pr: Checkout, output: string, prompts: string[], values: string[], stores = ["reviews", "judge"]) {
  const texts = [output, ...prompts, ...stores.flatMap((part) => { try { return storedFiles(join(pr.pullRequest, part)); } catch { return []; } })];
  return values.filter((value) => texts.some((text) => text.includes(value)));
}

type Shape = { name: string; base?: string; head: string; values: string[] };
const shapes: Shape[] = [
  { name: "a value on an added line", head: `token = ${token()}\n`, values: [token()] },
  { name: "a value on a removed line", base: `intro\ntoken = ${token()}\n`, head: "intro\n", values: [token()] },
  { name: "a value on a context line", base: `intro\ntoken = ${token()}\nouttro\n`, head: `intro changed\ntoken = ${token()}\nouttro\n`, values: [token()] },
  { name: "a cookie record in JSON over several lines", head: `[\n  {\n    "name": "${cookieName}",\n    "value": "${cookieValue}"\n  }\n]\n`, values: [cookieValue] },
  { name: "a quoted value", head: `const value = "${token()}";\n`, values: [token()] },
  { name: "a value in a header line", head: `Authorization: Bearer ${token()}\n`, values: [token()] },
  { name: "a value in a URL", head: `https://example.com/callback?token=${token()}&next=1\n`, values: [token()] },
  { name: "two values in one line", head: `${token(1)} ${token(2)}\n`, values: [token(1), token(2)] },
  { name: "a private key split by the diff's prefixes", head: `${privateKey(["RSA", "PRIVATE"].join(" "))}\n`, values: [body(64), body(64, 3)] },
  { name: "the cookie's name with commit hashes elsewhere in the prompt", head: `export const cookie = "${cookieName}";\n`, values: [] },
];

async function shaped(shape: Shape) {
  const pr = await checkout();
  if (shape.base !== undefined) {
    await pr.commit("fixture.txt", shape.base);
    await pr.git("update-ref", "refs/remotes/origin/main", "HEAD");
  }
  await pr.commit("fixture.txt", shape.head);
  await pr.hedge("require", "--none", "--reason", "Test fixture only");
  return pr;
}

test.each(shapes)("the judge gets $name redacted, the guard passes its prompt, and no output or stored file holds the value", async (shape) => {
  const pr = await shaped(shape);
  await reviewHead(pr);
  const judge = fakeModel(pr, "JUDGE", verdict());

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(0);
  const [prompt] = judge.prompts();
  expect(guardPasses(prompt!)).toBe(true);
  expect(leaksIn(pr, gate.output, judge.prompts(), shape.values)).toEqual([]);
});

test.each(shapes)("a single review gets $name redacted, the guard passes its prompt, and no output or stored file holds the value", async (shape) => {
  const pr = await shaped(shape);
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.\n");

  const review = await pr.hedge("review", "--single");
  expect(review.code).toBe(0);
  expect(guardPasses(reviewer.prompts()[0]!)).toBe(true);
  expect(leaksIn(pr, review.output, reviewer.prompts(), shape.values)).toEqual([]);
});

test("the judge prompt names the cookie only in a fixture, so Hedge redacts the long tokens the guard reads as its value and says where the name sits", async () => {
  const pr = await shaped(shapes.at(-1)!);
  await reviewHead(pr);
  const judge = fakeModel(pr, "JUDGE", verdict());

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(0);
  expect(gate.output).toMatch(/judge: Hedge redacted \d+ secret-shaped values from the prompt before the model call: a Metabase session cookie \(at line \d+ of the prompt/);
  expect(gate.output).toContain("this prompt names it at fixture.txt:1.");
  expect(gate.output).toContain("build the test fixture at run time from parts");
  expect(judge.prompts()[0]).toContain("a placeholder is no finding by itself");
});

test("the PR description, earlier findings and answers, and proof files reach the judge redacted", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: `Greets new members. Merge risk: medium.\n\nThe old token was ${token(1)}.\n` });
  await reviewHead(pr, `- minor | feature.txt:1 | the log prints ${token(2)}\n`);
  writeFileSync(join(pr.repository, "responses.md"), `Removed ${token(3)} from the log.\n`);
  await pr.hedge("respond", "--round", "1", "responses.md");
  await pr.hedge("require", "--kinds", "live-run");
  writeFileSync(join(pr.repository, "run.log"), `GET /feature 200 with ${token(4)}\n`);
  await pr.hedge("save", "--kind", "live-run", "run.log");
  const judge = fakeModel(pr, "JUDGE", verdict());

  const gate = await pr.hedge("gate");
  expect(judge.prompts()).toHaveLength(1);
  expect(guardPasses(judge.prompts()[0]!)).toBe(true);
  expect(leaksIn(pr, gate.output, judge.prompts(), [1, 2, 3, 4].map(token), ["judge"])).toEqual([]);
});

test("a single review gets the PR description redacted and says where the value sat", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.pullRequestState({ body: `Greets new members. Merge risk: medium.\n\nThe old token was ${token()}.\n` });
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.\n");

  const review = await pr.hedge("review", "--single");
  expect(guardPasses(reviewer.prompts()[0]!)).toBe(true);
  expect(leaksIn(pr, review.output, reviewer.prompts(), [token()])).toEqual([]);
  expect(review.output).toMatch(/Hedge redacted 1 secret-shaped value from the prompt before the model call: a GitHub token \(at line \d+ of the prompt, in <pr-description>\)/);
});

test("each panel lens gets the PR description redacted, its stored brief holds no value, and the panel names what it redacted", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.pullRequestState({ body: `Greets new members. Merge risk: medium.\n\nThe old token was ${token()}.\n` });
  const reviewer = fakeModel(pr, "REVIEWER", "FINDINGS:\nCOVERED: feature.txt\n");

  await pr.hedge("review", "--lens", "correctness");
  const wait = await pr.hedge("review", "--wait");
  expect(wait.code).toBe(0);
  expect(reviewer.prompts().length).toBeGreaterThan(0);
  expect(reviewer.prompts().every(guardPasses)).toBe(true);
  expect(leaksIn(pr, wait.output, reviewer.prompts(), [token()])).toEqual([]);
  expect(wait.output).toContain("Hedge redacted 1 secret-shaped value from the prompt before the model call: a GitHub token");
});

test("the arbiter gets the judge's failure reasons redacted", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: `feature.txt logs ${token()}`, citations: [] } }));
  const arbiterPrompts = join(pr.home, "arbiter-prompt");
  pr.env.HEDGE_REVIEW_ARBITER = `cat > "${arbiterPrompts}"; echo CONTINUE`;

  for (const answer of ["First.\n", "Second.\n", "Third.\n"]) {
    writeFileSync(join(pr.repository, "responses.md"), answer);
    await pr.hedge("respond", "--round", "1", "responses.md");
    await pr.hedge("gate");
  }
  const prompt = readFileSync(arbiterPrompts, "utf8");
  expect(prompt).toContain("feature.txt logs [redacted GitHub token]");
  expect(guardPasses(prompt)).toBe(true);
});

const unredactable = Array.from({ length: 65 }, (_, index) => `${token()}${String(index).padStart(3, "0")}`).join("\n");

test("a judge prompt Hedge cannot fully redact is never sent, the gate names why, and only the user accepts that judge gap", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr, `${unredactable}\n`);
  writeFileSync(join(pr.repository, "responses.md"), "1. rejected: each line is a test token.\n");
  await pr.hedge("respond", "--round", "1", "responses.md");
  await pr.hedge("require", "--none", "--reason", "Docs only");
  const judge = fakeModel(pr, "JUDGE", verdict());

  const held = await pr.hedge("gate");
  expect(held.code).toBe(1);
  expect(held.output).toContain("judge: unavailable (Hedge did not send the prompt to the model: Hedge's secret guard blocks a prompt that holds a GitHub token, and Hedge could not redact it.");
  expect(held.output).toContain("an agent never decides a judge gap for a judge that saw no prompt");
  expect(held.output).not.toContain("--mark 🤖");
  expect(judge.prompts()).toEqual([]);

  await pr.hedge("gap", "--kind", "judge", "--reason", "The findings quote test tokens");
  await pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#42", "--question", "Accept the judge gap?", "--answer", "Accept it", "--rejected", "Ask the user", "--reason", "The findings quote test tokens");
  const agent = await pr.hedge("gate");
  expect(agent.code).toBe(3);
  expect(agent.output).toContain("judge gap: not accepted (an agent never decides a judge gap for a judge that saw no prompt): The findings quote test tokens");

  pr.chooseGap("judge", "The findings quote test tokens");
  await acceptGap(pr, "judge");
  const user = await pr.hedge("gate");
  expect(user.code).toBe(0);
  expect(user.output.split("\n").at(-1)).toContain("judge: unavailable accepted by the user");
  expect(judge.prompts()).toEqual([]);
});

test("a review prompt Hedge cannot fully redact is never sent, and the error names the kind, never a value", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.pullRequestState({ body: `Greets new members. Merge risk: medium.\n\n${unredactable}\n` });
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.\n");

  const review = pr.hedge("review", "--single");
  await expect(review).rejects.toThrow("gave no findings (Hedge did not send the prompt to the model: Hedge's secret guard blocks a prompt that holds a GitHub token, and Hedge could not redact it.");
  await expect(review).rejects.not.toThrow(token());
  expect(reviewer.prompts()).toEqual([]);
});
