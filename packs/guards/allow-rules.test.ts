import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../src/testing/git.ts";
import { guard } from "./hooks/guards.ts";
import { narrowedRules } from "./lib/gh.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function homeWith(settings: Record<string, unknown>) {
  const home = temp.make("home-");
  mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
  writeFileSync(join(home, ".local/state/fleet/settings.json"), JSON.stringify({ "guards.person": "Robin", ...settings }));
  return home;
}

const everyRule = narrowedRules.join("\n");
const refusal = (command: string, rules = everyRule) => guard({ tool_name: "Bash", tool_input: { command }, cwd: "/" }, homeWith({ "guards.allow-rules": rules }), temp.make("root-"))?.hookSpecificOutput.permissionDecisionReason;

describe("review-request allow rules", () => {
  test.each([
    "gh api -X POST repos/example/product/pulls/1506/requested_reviewers -f 'reviewers[]=a-reviewer'",
    "gh api -X POST repos/example/product/pulls/1/requested_reviewers -f team_reviewers[]=core -f team_reviewers[]=infra",
    "gh pr edit 1506 --add-reviewer a-reviewer",
    "gh pr edit 1506 --repo example/product --add-reviewer a-reviewer,example/core",
    "gh pr edit https://github.com/example/product/pull/1506 --add-reviewer a-reviewer",
    "cd /x && timeout 30 gh pr edit 1506 -R example/product --add-reviewer a-reviewer",
    "gh pr edit 1506 --add-reviewer a-reviewer > /dev/null",
  ])("lets a bare reviewer request through: %s", (command) => {
    expect(refusal(command)).toBeUndefined();
  });

  test.each([
    "gh api -X POST repos/example/product/pulls/1/reviews -f event=APPROVE -f note=/pulls/1/requested_reviewers x",
    "gh api -X POST repos/example/product/issues/1/comments -f body='see /pulls/1/requested_reviewers here'",
    "gh api -X POST repos/example/product/pulls/1/requested_reviewers -f reviewers[]=a -f body=x",
    "gh api -X POST repos/example/product/pulls/1/requested_reviewers -f reviewers[]=a --jq .url",
    "GH_HOST=github.com gh pr edit 1 --add-reviewer a --body replaced",
    "gh pr edit 1 --title new --add-reviewer a",
    "gh pr edit 1 --add-reviewer a --base main",
    "gh pr edit 1 2 --add-reviewer a",
    "gh pr edit 1 --add-reviewer 'a;b'",
    "gh pr edit 1 --add-reviewer a > packs/guards/hooks/guards.ts",
    "gh api -X POST repos/example/product/pulls/1/requested_reviewers -f reviewers[]=a >> notes.md",
  ])("refuses a command the rule would approve that does more: %s", (command) => {
    expect(refusal(command)).toContain("does more than request reviewers");
  });

  test.each([
    "gh api repos/example/product/pulls/1506/requested_reviewers",
    "gh api -X DELETE repos/example/product/pulls/1506/requested_reviewers -f reviewers[]=a-reviewer",
    "gh pr edit 1506 --remove-reviewer a-reviewer",
    "gh pr edit 1506 --add-label run-ci",
  ])("leaves other reviewer and edit calls alone: %s", (command) => {
    expect(refusal(command)).toBeUndefined();
  });
});

describe("Trunk comment allow rules", () => {
  test.each([
    "gh api repos/example/product/issues/127175/comments -f body='/trunk merge'",
    'gh api -X POST repos/example/product/issues/127175/comments -f body="/trunk merge"',
    "gh pr comment 127175 --body '/trunk merge'",
    "gh pr comment 127175 --repo example/product --body '/trunk merge'",
    "gh pr comment https://github.com/example/product/pull/127175 --body '/trunk merge'",
    "gh pr comment 127175 -R example/product --body '/trunk cancel'",
    "gh api repos/example/product/issues/127175/comments -f body='/trunk cancel'",
    "cd /x && gh pr comment 127175 --body '/trunk merge'",
  ])("lets one bare Trunk command through: %s", (command) => {
    expect(refusal(command)).toBeUndefined();
  });

  test.each([
    "gh pr comment 1 --body '/trunk merge please'",
    "gh pr comment 1 --body '/trunk merge --priority=high'",
    "gh pr comment 1 --body '/trunk merge\nLGTM'",
    "gh pr comment 1 --body 'lgtm /trunk merge'",
    "gh pr comment 1 --body '/trunk restart'",
    "gh pr comment 1 --body /trunk merge",
    'gh pr comment 1 --body "$(cat notes.md) /trunk merge"',
    "gh api repos/example/product/issues/1/comments -f body='/trunk merge now'",
    "gh pr comment 1 2 --body '/trunk merge'",
    "gh pr comment 1 --body '/trunk merge' --body '/trunk merge'",
    "gh pr comment 1 --edit-last --body '/trunk merge'",
    "gh pr comment 1 --admin --body '/trunk merge'",
    "gh pr comment 1 --body-file notes.md --body '/trunk merge'",
    "gh pr comment 1 --body '/trunk merge' --body-file - <<EOF\nanything\nEOF",
    "gh api repos/example/product/pulls/1/merge -X PUT -f a=repos/example/product/issues/1/comments -f body='/trunk merge'",
    "gh api -X PATCH repos/example/product/issues/comments/9 -f a=repos/x/y/issues/1/comments -f body='/trunk merge'",
    "gh api -X DELETE repos/example/product/issues/1/comments -f body='/trunk merge'",
    "gh api repos/example/product/issues/1/comments -f body='/trunk merge' --jq .html_url",
    "gh api repos/example/product/issues/1/comments -f body='/trunk merge' -f extra=1",
    "gh api repos/example/product/issues/1/comments -f body='/trunk merge' -F body=@notes.md",
    "gh api repos/example/product/issues/1/comments -f body='/trunk merge' --input notes.json",
    "gh api repos/example/product/issues/1/comments -f body='/trunk merge' -H 'X-Other: 1'",
    "gh pr comment 1 --body '/trunk merge' > notes.md",
  ])("refuses a command the rule would approve that does more: %s", (command) => {
    const reason = refusal(command);
    expect(reason).toContain("does more than post one bare Trunk command");
    expect(reason).toContain("Robin's merge word");
  });

  test.each([
    "gh pr merge 1 --admin --squash",
    "gh pr merge 1 --auto",
    "gh api -X PUT repos/example/product/pulls/1/merge",
    "gh api repos/example/product/issues/1/comments --jq '.[] | select(.body==\"/trunk merge\")'",
    "gh pr comment 1 --body 'Thanks, fixed.'",
    "gh api repos/example/product/issues/1/comments -F body=@trunk.md",
  ])("leaves merges, reads, and other comments alone: %s", (command) => {
    expect(refusal(command)).toBeUndefined();
  });
});

describe("guards.allow-rules", () => {
  test("narrows only the rules it lists, so a machine without them keeps its ordinary comments and edits", () => {
    expect(refusal("gh pr comment 1 --body 'the trunk queue failed, retrying'", "")).toBeUndefined();
    expect(refusal("gh pr edit 1 --title new --add-reviewer a", "")).toBeUndefined();
    const trunkOnly = narrowedRules.filter((rule) => rule.includes("trunk")).join("\n");
    expect(refusal("gh pr edit 1 --title new --add-reviewer a", trunkOnly)).toBeUndefined();
    expect(refusal("gh pr comment 1 --body 'the trunk queue failed, retrying'", trunkOnly)).toContain("does more than post one bare Trunk command");
  });

  test("a rule the gh guard cannot narrow refuses shell calls, so no listed rule goes unguarded", () => {
    const reason = refusal("echo hi", `${narrowedRules[0]}\nBash(gh pr merge *)`);
    expect(reason).toContain("could not read their settings");
    expect(reason).toContain("Bash(gh pr merge *)");
  });
});
