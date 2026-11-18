import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fold, localLedger, type LedgerEvent } from "./decision-ledger.ts";
import { checkout, cleanFixtures, ledgerDecisions, reviewHead } from "./proof-testing.ts";

afterEach(cleanFixtures);

const ledgerFile = (home: string) => join(home, ".local/state/fleet/decisions.jsonl");
const events = (home: string): Record<string, unknown>[] =>
  existsSync(ledgerFile(home)) ? readFileSync(ledgerFile(home), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

test("a gate pass lands in the decision ledger at HEAD, and a failed gate leaves none", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  const failed = await pr.fleet("gate");
  expect(failed.code).toBe(1);
  expect(events(pr.home).filter((event) => event.type === "gate")).toEqual([]);

  await pr.fleet("require", "--none", "--reason", "docs only");
  const passed = await pr.fleet("gate");
  expect(passed.code).toBe(0);
  expect(passed.output).toContain("merge gate: pass recorded in the decision ledger");
  expect(passed.output.split("\n").at(-1)).toStartWith("gate: pass");
  const head = await pr.git("rev-parse", "HEAD");
  expect(events(pr.home).filter((event) => event.type === "gate")).toEqual([expect.objectContaining({ type: "gate", repository: "example/product", pr: 42, commit: head })]);
});

test("the ledger keeps a well-formed gate pass, drops a malformed one, and decisions ignore both", async () => {
  const home = join(await checkout().then((pr) => pr.home), "ledger");
  mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
  const pass = { type: "gate", repository: "example/product", pr: 42, commit: "a".repeat(40), machine: "box", at: "2026-11-16T08:00:00Z" };
  const broken = [{ ...pass, commit: "abc123" }, { ...pass, pr: 0 }, { ...pass, repository: "nobody" }, { ...pass, machine: "" }];
  writeFileSync(ledgerFile(home), [pass, ...broken].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const read: LedgerEvent[] = await localLedger(home).read();
  expect(read).toEqual([pass as LedgerEvent]);
  expect(fold(read)).toEqual([]);
});

test("a valued option given twice is refused before anything is recorded, so a later --mark 🤖 cannot slip past the 👤 rules", async () => {
  const pr = await checkout();
  pr.chooseGap("judge", "the judge is down");
  await expect(pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#42", "--mark", "🤖", "--question", "q", "--answer", "a", "--rejected", "r", "--reason", "why"))
    .rejects.toThrow("--mark given twice");
  await expect(pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#42", "--thread", "a", "--thread", "b")).rejects.toThrow("--thread given twice");
  expect(ledgerDecisions(pr)).toEqual([]);
});

test("a gate override is the user's 👤 answer for one PR at one full head, with the incident and why", async () => {
  const pr = await checkout();
  const head = "a".repeat(40);
  const override = (...args: string[]) => pr.decide("record", "--class", "merge", "--kind", "gate-override", "--pr", "example/product#42", ...args);
  await expect(override("--mark", "🤖", "--condition", `${head}: incident fix now`, "--question", "q", "--answer", "a", "--rejected", "r", "--reason", "x")).rejects.toThrow("An agent never overrides the merge gate");
  await expect(override("--mark", "👍", "--condition", `${head}: incident fix now`)).rejects.toThrow("--mark 👤");
  await expect(override("--mark", "👤")).rejects.toThrow("full 40-character head sha");
  await expect(override("--mark", "👤", "--condition", "abc123: incident fix now")).rejects.toThrow("full 40-character head sha");
  await expect(override("--mark", "👤", "--pr", "example/product#41", "--condition", `${head}: incident fix now`)).rejects.toThrow("one --pr");
  await expect(pr.decide("record", "--mark", "👤", "--class", "merge", "--kind", "ci", "--pr", "example/product#42")).rejects.toThrow("only --kind gate-override");
  expect(ledgerDecisions(pr)).toEqual([]);

  pr.choose("Override the gate", `Merge example/product#42 at ${head} without a gate pass (gate-override)? The incident cannot wait.`);
  const recorded = await override("--mark", "👤", "--condition", `${head}: incident fix, the judge is down`);
  expect(recorded.code).toBe(0);
  expect(ledgerDecisions(pr).at(-1)).toMatchObject({ class: "merge", mark: "👤", scope: { prs: ["example/product#42"], kinds: ["gate-override"], condition: `${head}: incident fix, the judge is down` } });
});
