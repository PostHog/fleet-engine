import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptGap, cleanFixtures, checkout, fakeModel, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const token = ["gh", "p_", "a1B2c3D4e5".repeat(4)].join("");
const escapedTooDeeply = `\\u005c${"u005c".repeat(10)}u0061`;

const authorsAnswers = "responses.md";

function storedFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return storedFiles(path);
    return name === authorsAnswers ? [] : [readFileSync(path, "utf8")];
  });
}

const leaked = (pr: Checkout, output: string, value: string) => [output, ...storedFiles(pr.pullRequest)].some((text) => text.includes(value));

async function judged(answer: string) {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr, "- minor | feature.txt:1 | the log prints a token\n");
  writeFileSync(join(pr.repository, "responses.md"), `1. fixed: ${answer}\n`);
  await pr.hedge("respond", "--round", "1", "responses.md");
  await pr.hedge("require", "--none", "--reason", "Docs only");
  return { pr, judge: fakeModel(pr, "JUDGE", verdict()) };
}

async function reviewed(description: string) {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await pr.hedge("require", "--none", "--reason", "Docs only");
  pr.pullRequestState({ body: `Greets new members. Merge risk: medium.\n\n${description}\n` });
  return { pr, reviewer: fakeModel(pr, "REVIEWER", "No findings.\n") };
}

test("the judge gets no prompt that the secret guard matches, and the gate names the kind", async () => {
  const { pr, judge } = await judged(`removed ${token} from the log.`);

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(gate.output).toContain("judge: unavailable (the secret guard matches this prompt: GitHub token)");
  expect(judge.prompts()).toEqual([]);
  expect(leaked(pr, gate.output, token)).toBe(false);
});

test("the judge still gets a prompt the secret guard does not match", async () => {
  const { pr, judge } = await judged("removed the token from the log.");

  expect((await pr.hedge("gate")).code).toBe(0);
  expect(judge.prompts()).toHaveLength(1);
});

test("a single review sends no prompt that the secret guard matches, and fails with the kind", async () => {
  const { pr, reviewer } = await reviewed(`The old token was ${token}.`);

  const review = pr.hedge("review", "--single");
  await expect(review).rejects.toThrow("gave no findings (the secret guard matches this prompt: GitHub token)");
  await expect(review).rejects.not.toThrow(token);
  expect(reviewer.prompts()).toEqual([]);
  expect(leaked(pr, "", token)).toBe(false);
});

test("a single review sends no prompt with text escaped too deeply for the guard to check", async () => {
  const { pr, reviewer } = await reviewed(escapedTooDeeply);

  await expect(pr.hedge("review", "--single")).rejects.toThrow("gave no findings (the secret guard matches this prompt: text escaped too deeply to check)");
  expect(reviewer.prompts()).toEqual([]);
});

test("a single review still sends a prompt the secret guard does not match", async () => {
  const { pr, reviewer } = await reviewed("The old token is gone.");

  expect((await pr.hedge("review", "--single")).code).toBe(0);
  expect(reviewer.prompts()).toHaveLength(1);
});

async function heldWithAcceptedGaps(condition: string[]) {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr, "- minor | feature.txt:1 | the log prints a token\n");
  writeFileSync(join(pr.repository, "responses.md"), `1. fixed: removed ${token} from the log.\n`);
  await pr.hedge("respond", "--round", "1", "responses.md");
  await pr.hedge("require", "--kinds", "prod-shape");
  await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access");
  pr.chooseGap("prod-shape", "No production read access");
  const id = /\[(d-[0-9a-f]+)\]/.exec((await acceptGap(pr, "prod-shape", ...condition)).output)![1]!;
  const judge = fakeModel(pr, "JUDGE", verdict());
  await pr.hedge("gap", "--kind", "judge", "--reason", "The judge prompt quotes a test token");
  pr.chooseGap("judge", "The judge prompt quotes a test token");
  await acceptGap(pr, "judge");
  return { pr, judge, id };
}

test("an accepted judge gap does not pass a gate whose held judge could not check the condition of an accepted gap", async () => {
  const { pr, judge, id } = await heldWithAcceptedGaps(["--condition", "feature.txt reads no stored rows"]);

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(3);
  expect(gate.output).toContain(`judge gap: not accepted (the secret guard held the judge prompt, so no judge checked the condition of decision ${id})`);
  expect(gate.output).toContain(`hedge decision void <id>`);
  expect(judge.prompts()).toEqual([]);
});

test("an accepted judge gap still passes a gate whose held judge had no condition to check", async () => {
  const { pr, judge } = await heldWithAcceptedGaps([]);

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(0);
  expect(gate.output).toContain("judge: unavailable (the secret guard matches this prompt: GitHub token)");
  expect(judge.prompts()).toEqual([]);
});
