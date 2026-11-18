import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision, LedgerEvent } from "../pull-requests/lib/decision-ledger.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { mergeGate } from "./hooks/merge-gate.ts";
import {
  beforeDeadline, cliReason, exemptList, graphqlReason, mergeGateRisk, mergeIntent, otherEndpointReason, rawReason, shellAliasReason, splitStringReason,
  type GateIO, type IntentIO, type MergeIntent, type Pull,
} from "./lib/merge-gate.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const head = "a".repeat(40);
const lower = "b".repeat(40);
const older = "c".repeat(40);
const exempt = exemptList("own/*, example/notes");
const files: Record<string, string> = { "/work/body.md": "/trunk merge\n", "/work/note.md": "Merged after review.\n", "/work/payload.json": '{"body":"/trunk merge"}' };
const io: IntentIO = {
  readText: (path) => files[path],
  originOf: (cwd) => cwd.startsWith("/work") ? "example/product" : cwd.startsWith("/tooling") ? "own/tooling" : undefined,
  aliases: () => ({ m: "pr merge", say: "pr comment", x: "!gh pr merge 7", c: "pr comment $1" }),
};

const bash = (command: string, cwd = "/work") => mergeIntent({ tool_name: "Bash", tool_input: { command }, cwd }, command, exempt, io);
const mcp = (tool: string, input: Record<string, unknown>) => mergeIntent({ tool_name: tool, tool_input: input }, "", exempt, io);
const target = (repository: string, pr: number) => expect.objectContaining({ repository, pr });

describe("which calls enqueue or merge", () => {
  test.each([
    ["gh pr comment 7 --repo example/product --body '/trunk merge'"],
    ["gh pr comment 7 --repo example/product --body /trunk\\ merge"],
    ["gh pr comment 7 -R example/product -b '/trunk merge'"],
    ["gh pr comment 7 --repo=example/product --body='/trunk merge'"],
    ["gh issue comment 7 --repo example/product --body '/trunk merge'"],
    ["gh pr comment https://github.com/example/product/pull/7 --body '/trunk merge'"],
    ["gh pr comment 7 --body '/trunk merge'"],
    ["GH_REPO=example/product gh pr comment 7 --body '/trunk merge'"],
    ["gh pr comment 7 --repo example/product --body-file body.md"],
    ["gh pr comment 7 --repo example/product --body-file - <<'EOF'\n/trunk merge\nEOF"],
    ["printf '/trunk merge' > new.md && gh pr comment 7 --repo example/product -F new.md"],
    ["sh -c \"gh pr comment 7 --repo example/product --body '/trunk merge'\""],
    ["cd /work && gh pr comment 7 --body '/trunk merge'"],
    ["gh api repos/example/product/issues/7/comments -f body='/trunk merge'"],
    ["gh api -X POST repos/example/product/issues/7/comments -F 'body=/trunk merge'"],
    ["gh api repos/example/product/issues/7/comments -F body=@body.md"],
    ["gh api repos/example/product/issues/7/comments --input payload.json"],
    ["gh api repos/{owner}/{repo}/issues/7/comments -f body='/trunk merge'"],
    ["gh api -X PUT repos/example/product/pulls/7/merge"],
    ["gh pr merge 7 --repo example/product --squash"],
    ["gh pr merge 7 --repo example/product --auto --squash"],
    ["gh pr merge 7 --repo example/product --squash --disable-auto=false"],
    ["printf '/trunk merge' | gh pr comment 7 -R example/product -F -"],
    ["cat payload.json | gh api repos/example/product/issues/7/comments --input -"],
    ["gh m 7 -R example/product --squash"],
    ["gh say 7 -R example/product --body '/trunk merge'"],
    ["gh pr comment 7 --repo example/product --body '  /trunk merge'"],
    ["gh pr comment 7 --repo example/product --body $'Ready.\\r\\n/trunk merge'"],
  ])("%s targets example/product#7", (command) => {
    expect(bash(command)).toEqual({ targets: [target("example/product", 7)] });
  });

  test.each([
    ["gh pr comment 7 --repo example/product --body '/trunk cancel'"],
    ["gh pr comment 7 --repo example/product --body 'Waiting for CI before the next step.'"],
    ["gh pr comment 7 --repo example/product --body-file note.md"],
    ["gh pr merge 7 --repo example/product --disable-auto"],
    ["gh api repos/example/product/pulls/7/merge"],
    ["gh api repos/example/product/issues/7/comments"],
    ["gh pr view 7 --repo example/product"],
    ["gh pr comment 7 --repo own/tooling --body '/trunk merge'"],
    ["gh pr merge 7 --repo Example/Notes --squash"],
    ["curl -s https://api.github.com/repos/example/product/pulls/7/merge"],
    ["echo done"],
  ])("%s enqueues nothing the gate checks", (command) => {
    expect(bash(command)).toEqual({ targets: [] });
  });

  test.each([
    ["trunk merge 7", cliReason],
    ["~/.cache/trunk/trunk merge --pr 7", cliReason],
    ["curl -X POST https://api.github.com/repos/example/product/issues/7/comments -d '{\"body\":\"/trunk merge\"}'", rawReason],
    ["curl -X PUT https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["curl -sXPUT https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["curl -sd '{}' https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", graphqlReason],
    ["gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'", graphqlReason],
    ["gh api graphql -f query='mutation { addComment(input: {subjectId: \"x\", body: \"/trunk merge\"}) { clientMutationId } }'", graphqlReason],
    ["gh api -X PATCH repos/example/product/issues/comments/1 -f body='/trunk merge'", otherEndpointReason],
    ["gh pr review 7 --repo example/product --comment -b '/trunk merge'", otherEndpointReason],
    ["env -S 'gh pr merge 7 -R example/product --squash'", splitStringReason],
    ["env --split-string='gh pr merge 7 -R example/product'", splitStringReason],
    ["gh x", shellAliasReason],
    ["gh c 7 --body '/trunk merge'", shellAliasReason],
  ])("%s is refused outright", (command, reason) => {
    expect(bash(command).refusal).toBe(reason);
  });

  test("a cd before the call moves it to that checkout's repository, out of an exempt one", () => {
    expect(bash("cd /work/product && gh pr merge 7 --squash", "/tooling")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("cd /tooling && gh pr merge 7 --squash", "/work")).toEqual({ targets: [] });
    expect(bash("(cd /tooling) && gh pr merge 7 --squash", "/work")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("(cd /tooling; true); gh pr merge 7", "/work")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("pushd /work/product && gh pr merge 7", "/tooling")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("pushd /tooling && popd && gh pr merge 7", "/work")).toEqual({ targets: [target("example/product", 7)] });
  });

  test("a merge or enqueue that names no PR is refused, since the gate cannot check it", () => {
    expect(bash("gh pr comment --body '/trunk merge'").refusal).toContain("without naming the PR");
    expect(bash("gh pr merge --squash").refusal).toContain("without naming the PR");
    expect(bash("gh pr comment 7 --body '/trunk merge'", "/elsewhere").refusal).toContain("without naming the PR");
  });

  test("GitHub MCP tools: a comment that posts /trunk merge and a merge tool target the PR", () => {
    expect(mcp("mcp__github__add_issue_comment", { owner: "example", repo: "product", issue_number: 7, body: "/trunk merge" })).toEqual({ targets: [target("example/product", 7)] });
    expect(mcp("mcp__plugin_github_github__merge_pull_request", { owner: "example", repo: "product", pullNumber: 7 })).toEqual({ targets: [target("example/product", 7)] });
    expect(mcp("mcp__github__add_issue_comment", { owner: "example", repo: "product", issue_number: 7, body: "Thanks" })).toEqual({ targets: [] });
    expect(mcp("mcp__github__merge_pull_request", { owner: "example", repo: "product" }).refusal).toContain("without naming the PR");
    expect(mcp("mcp__github__create_pull_request_review", { owner: "example", repo: "product", pullNumber: 7, body: "/trunk merge" }).refusal).toBe(otherEndpointReason);
    expect(mcp("mcp__plugin_github_github__merge_pull_request", { repository_full_name: "example/product", pr_number: 7 })).toEqual({ targets: [target("example/product", 7)] });
  });

  test("GitHub MCP reads and PR body edits that name /trunk merge enqueue nothing", () => {
    expect(mcp("mcp__github__search_issues", { query: "/trunk merge", owner: "example", repo: "product" })).toEqual({ targets: [] });
    expect(mcp("mcp__github__update_pull_request", { owner: "example", repo: "product", pullNumber: 7, body: "Steps:\n/trunk merge once green" })).toEqual({ targets: [] });
    expect(mcp("mcp__github__get_pull_request_merge_status", { owner: "example", repo: "product", pullNumber: 7 })).toEqual({ targets: [] });
  });
});

const pulls: Record<number, Pull> = {
  7: { head, base: "layer-1", defaultBranch: "main", open: true },
  6: { head: lower, base: "main", defaultBranch: "main", open: true },
  9: { head, base: "main", defaultBranch: "main", open: true },
};
const gatePass = (pr: number, commit: string): LedgerEvent => ({ type: "gate", repository: "Example/Product", pr, commit, machine: "box-2", at: "2026-11-16T08:00:00Z" });
const override = (commit: string, mark: Decision["mark"] = "👤", pr = 9): LedgerEvent => ({
  type: "decide", decision: {
    id: `o-${commit.slice(0, 1)}-${mark}`, at: "2026-11-16T08:00:00Z", class: "merge", mark, question: `Merge example/product#${pr} without a gate pass?`, answer: "Override",
    scope: { prs: [`example/product#${pr}`], kinds: ["gate-override"], condition: `${commit}: incident fix, the gate's judge is down` }, where: { thread: "t", message: `m-${commit.slice(0, 1)}`, machine: "hub" },
  },
});

function gate({ local = [] as string[], ledger = [] as LedgerEvent[], hubDown = false, github = true } = {}): GateIO {
  return {
    pull: async (_repository, pr) => { if (!github) throw new Error("GitHub answered 502"); return pulls[pr]; },
    pullFor: async (_repository, branch) => branch === "layer-1" ? 6 : undefined,
    localPass: async (_repository, pr, commit) => local.includes(`${pr}@${commit}`),
    ledger: async () => { if (hubDown) throw new Error("hub unreachable over SSH"); return ledger; },
  };
}
const one = (pr: number, via = "gh pr comment"): MergeIntent => ({ targets: [{ repository: "example/product", pr, via }] });
const risk = (intent: MergeIntent, io: GateIO) => mergeGateRisk(intent, io, "Robin");

describe("the gate pass each layer needs", () => {
  test("a gate pass at the head on this machine lets the enqueue through", async () => {
    expect(await risk(one(9), gate({ local: [`9@${head}`] }))).toBeUndefined();
  });

  test("no gate run or a failed gate refuses it and names the gate command at the full head and whom to ask", async () => {
    const refusal = await risk(one(9), gate());
    expect(refusal).toContain("has not passed at the head of example/product#9");
    expect(refusal).toContain(`fleet proof gate --repo example/product --pr 9 --commit ${head}`);
    expect(refusal).toContain("ask Robin with the question tool");
  });

  test("a pass another machine copied to the ledger counts, but only at the PR's current head", async () => {
    expect(await risk(one(9), gate({ ledger: [gatePass(9, head)] }))).toBeUndefined();
    expect(await risk(one(9), gate({ ledger: [gatePass(9, older)] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ ledger: [gatePass(8, head)] }))).toContain("has not passed");
  });

  test("the top layer of a stack needs every open layer below it to pass at its own head", async () => {
    const refusal = await risk(one(7), gate({ local: [`7@${head}`] }));
    expect(refusal).toContain("example/product#6 (a lower layer of example/product#7)");
    expect(refusal).toContain(`--pr 6 --commit ${lower}`);
    expect(await risk(one(7), gate({ local: [`7@${head}`, `6@${lower}`] }))).toBeUndefined();
  });

  test("a closed layer in the middle is followed, so an open layer below it still needs its pass", async () => {
    const walk = {
      ...gate({ local: [`7@${head}`] }),
      pull: async (_r: string, pr: number) => pr === 6 ? { ...pulls[6]!, base: "layer-0", open: false } : pr === 5 ? { head: older, base: "main", defaultBranch: "main", open: true } : pulls[pr],
      pullFor: async (_r: string, branch: string) => branch === "layer-1" ? 6 : branch === "layer-0" ? 5 : undefined,
    };
    const refusal = await risk(one(7), walk);
    expect(refusal).toContain(`--pr 5 --commit ${older}`);
    expect(refusal).not.toContain("product#6");
  });

  test("a stack deeper than the walk, or one that loops, is refused, not passed", async () => {
    const chain = (pr: number): Pull => ({ head, base: `layer-${pr - 1}`, defaultBranch: "main", open: true });
    const deep = { ...gate(), pull: async (_r: string, pr: number) => chain(pr), pullFor: async (_r: string, branch: string) => Number(branch.slice(6)), localPass: async () => true };
    expect(await risk(one(100), deep)).toContain("deeper than 12 PRs");
    expect(await risk(one(100), { ...deep, pullFor: async () => 100 })).toContain("loops back to #100");
  });

  test("an unreadable ledger refuses a PR without a local pass and says why", async () => {
    expect(await risk(one(9), gate({ hubDown: true }))).toContain("decision ledger could not be read");
    expect(await risk(one(9), gate({ hubDown: true, local: [`9@${head}`] }))).toBeUndefined();
  });

  test("GitHub not answering refuses the merge; a comment on an issue, which is no PR, passes", async () => {
    expect(await risk(one(9), gate({ github: false }))).toContain("could not check it");
    expect(await risk(one(404), gate())).toBeUndefined();
    expect(await risk(one(404, "gh pr merge"), gate())).toContain("could not check it");
  });

  test("the person's override counts at its head only, and a 🤖, other PR's or voided one never counts", async () => {
    expect(await risk(one(9), gate({ ledger: [override(head)] }))).toBeUndefined();
    expect(await risk(one(9), gate({ ledger: [override(older)] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ ledger: [override(head, "🤖")] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ ledger: [override(head, "👤", 8)] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ ledger: [override(head), { type: "void", id: "o-a-👤", reason: "pushed", at: "2026-11-16T09:00:00Z" }] }))).toContain("has not passed");
  });

  test("a refusal from reading the call needs no GitHub read", async () => {
    expect(await risk({ targets: [], refusal: cliReason }, gate({ github: false }))).toBe(cliReason);
  });

  test("a check that runs past the deadline is refused, never let through", async () => {
    expect(await beforeDeadline(() => new Promise(() => {}), 5)).toContain("could not read GitHub and the decision ledger in time");
    expect(await beforeDeadline(async () => { throw new Error("boom"); }, 1_000)).toContain("the merge gate failed (boom)");
  });
});

describe("the PreToolUse hook", () => {
  const homeWith = (settings?: unknown) => {
    const home = temp.make("home-");
    if (settings !== undefined) {
      mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
      writeFileSync(join(home, ".local/state/fleet/settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    }
    return home;
  };
  const call = (command: string) => ({ tool_name: "Bash", tool_input: { command }, cwd: "/work" });

  test("denies an enqueue without a gate pass and lets other calls through without reading GitHub", async () => {
    const reads: number[] = [];
    const watched = { ...gate(), pull: async (repository: string, pr: number) => { reads.push(pr); return gate().pull(repository, pr); } };
    const where = { home: homeWith({ "guards.person": "Robin" }), env: {}, gate: watched, intent: io };
    const denied = await mergeGate(call("gh pr comment 9 --repo example/product --body '/trunk merge'"), where);
    expect(denied?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied?.hookSpecificOutput.permissionDecisionReason).toContain("ask Robin");
    expect(await mergeGate(call("gh pr view 9 --repo example/product"), where)).toBeUndefined();
    expect(await mergeGate(call("gh pr comment 9 --repo example/product --body '/trunk merge'"), { ...where, gate: gate({ local: [`9@${head}`] }) })).toBeUndefined();
    expect(reads).toEqual([9]);
  });

  test("guards.merge-gate-exempt lets the listed repositories merge without a gate pass", async () => {
    const where = (settings: unknown) => ({ home: homeWith(settings), env: {}, gate: gate(), intent: io });
    expect(await mergeGate(call("gh pr merge 9 --repo own/tooling"), where({ "guards.merge-gate-exempt": "own/*" }))).toBeUndefined();
    expect(await mergeGate(call("gh pr merge 9 --repo own/tooling"), where({}))).toBeDefined();
  });

  test("settings it cannot read refuse a merge rather than skip the gate, and leave other calls alone", async () => {
    const broken = { home: homeWith("{not json"), env: {}, gate: gate({ local: [`9@${head}`] }), intent: io };
    const denied = await mergeGate(call("gh pr merge 9 --repo own/tooling"), broken);
    expect(denied?.hookSpecificOutput.permissionDecisionReason).toContain("could not read its settings");
    expect(await mergeGate(call("gh pr view 9 --repo example/product"), broken)).toBeUndefined();
    expect(await mergeGate({ tool_name: "Read", tool_input: { file_path: "/work/body.md" } }, broken)).toBeUndefined();
    expect(await mergeGate(call("gh pr merge 9 --repo own/tooling"), { home: homeWith({ "guards.merge-gate-exempt": 7 }), env: {}, gate: gate(), intent: io })).toBeDefined();
  });
});

test("the merge-gate workflow installs the hook, and the installed script refuses an enqueue it cannot check", async () => {
  const engine = await engineSource();
  const plan = (on: boolean) => resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["guards"], workflows: { "merge-gate": on } }, devbox);
  const hookSource = (files: ({ target: string } & ({ source: string } | { content: string }))[]) => {
    const file = files.find((item) => item.target === ".config/fleet/hooks/PreToolUse/merge-gate.ts");
    return file && "source" in file ? file.source : undefined;
  };
  expect(hookSource(plan(false).files)).toBeUndefined();
  const source = hookSource(plan(true).files);
  expect(source).toEndWith("packs/guards/hooks/merge-gate.ts");
  const child = Bun.spawn([process.execPath, source!, "claude"], {
    env: { ...process.env, HOME: temp.make("home-") }, stdin: new Blob([JSON.stringify({ tool_name: "Bash", tool_input: { command: "trunk merge 7" }, cwd: "/" })]), stdout: "pipe",
  });
  const answer = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(answer.hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: cliReason });
});
