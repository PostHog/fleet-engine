import { afterEach, describe, expect, test } from "bun:test";
import { tempDirs } from "../../src/testing/git.ts";
import { guard } from "./hooks/guards.ts";
import { exitMaskRisk } from "./lib/exit-mask.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

describe("the exit-status mask guard", () => {
  test.each([
    "fleet proof gate --pr 1 2>&1 | tail -20",
    "~/.local/bin/fleet proof review --pr 1 | tee /tmp/review.log",
    "fleet proof save --kind live-run /tmp/x | grep -v debug",
    "git push origin HEAD 2>&1 | tail -3",
    "git -C repo push | head",
    "git commit -m 'Fix the gate' | grep -c changed",
    "gh pr ready 12 && gh pr merge 12 --squash 2>&1 | tail -5",
    "gh run watch 123 --exit-status | jq .",
    "git commit -m x; git push",
    'fleet proof gate --pr 1 > /tmp/gate.log 2>&1\necho "gate exit $?" >> /tmp/gate.log',
    "bash -c 'git push | tail -2'",
  ])("refuses a hidden exit status: %s", (command) => {
    expect(exitMaskRisk(command, "Robin")).toContain("hides the exit status");
  });

  test.each([
    "git push origin HEAD",
    "git commit -m 'a; b | tail' && git push",
    "set -o pipefail; fleet proof gate --pr 1 | tail -20",
    "set -euo pipefail\ngit push | tail -3",
    'git push 2>&1 | tail -3; echo "${PIPESTATUS[0]}"',
    "set -e; git commit -m x; git push",
    "if git push; then echo pushed; fi",
    "git push > /tmp/push.log 2>&1 && tail /tmp/push.log",
    "gh run watch 123 | tail",
    "git log --oneline | head -3",
    "git push;",
    'git push && echo "pushed $?"',
  ])("allows a visible exit status: %s", (command) => {
    expect(exitMaskRisk(command, "Robin")).toBeUndefined();
  });

  test("the shell hook refuses with the fix", () => {
    const call = { tool_name: "Bash", tool_input: { command: "gh run watch 123 --exit-status | tail -3" }, cwd: "/" };
    expect(guard(call, temp.make("home-"), temp.make("root-"))?.hookSpecificOutput.permissionDecisionReason).toContain("set -o pipefail");
  });
});
