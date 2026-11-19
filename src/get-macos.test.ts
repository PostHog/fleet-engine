import { describe, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { getShHarness, onLinuxHost } from "./testing/get-sh.ts";

const { sandbox, getSh } = getShHarness();

describe("get.sh on macOS", () => {
  onLinuxHost("stops before it installs or writes anything, says that Hedge runs on cloud boxes, and points at the setup page", () => {
    const box = sandbox("Darwin");
    const result = getSh(box, ["--ref", "v0.1.0"]);
    expect(result.code).toBe(1);
    expect(result.output).toBe("Hedge: Hedge runs on cloud boxes, not on a Mac. Your Mac only runs the T3 Code app. To set up your hub, follow https://posthog.github.io/hedge/#start\n");
    expect(result.calls).not.toMatch(/^(curl|xcode-select|brew|open) /m);
    expect(readdirSync(box.home)).toEqual([]);
  });
});
