import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  onLinuxHost("with an earlier Fleet or Hedge on the Mac, stops and turns off each of their launchd jobs, keeps their files, installs nothing, and points at the setup page", () => {
    const box = sandbox("Darwin");
    const agents = join(box.home, "Library/LaunchAgents");
    mkdirSync(agents, { recursive: true });
    for (const label of ["dev.fleet.nightly", "dev.hedge.update", "com.apple.other"]) writeFileSync(join(agents, `${label}.plist`), "<plist/>\n");
    mkdirSync(join(box.home, ".local/share/hedge/engine"), { recursive: true });
    const loaded = join(box.root, "loaded");
    writeFileSync(loaded, "dev.fleet.nightly\ndev.hedge.update\ncom.fleet.mcphub\ncom.apple.other\n");
    box.stub("launchctl", `case "$1" in
  list) printf -- '-\\t0\\t%s\\n' $(cat "${loaded}") ;;
  bootout) label=\${2##*/}; grep -vx "$label" "${loaded}" > "${loaded}.new"; mv "${loaded}.new" "${loaded}" ;;
  disable) ;;
  print) grep -qx "\${2##*/}" "${loaded}" ;;
esac`);
    const result = getSh(box, []);
    expect(result.code).toBe(0);
    expect(result.output).toBe(
      [
        "Hedge: stopped and turned off the launchd job com.fleet.mcphub of an earlier Fleet or Hedge, and kept its files.",
        "Hedge: stopped and turned off the launchd job dev.fleet.nightly of an earlier Fleet or Hedge, and kept its files.",
        "Hedge: stopped and turned off the launchd job dev.hedge.update of an earlier Fleet or Hedge, and kept its files.",
        "Hedge: Hedge runs on cloud boxes, not on a Mac. Your Mac only runs the T3 Code app. To set up your hub, follow https://posthog.github.io/hedge/#start",
        "",
      ].join("\n"),
    );
    expect(result.calls).not.toMatch(/^(curl|xcode-select|brew|open|bun|git) /m);
    expect(result.calls).toContain("launchctl disable gui/");
    expect(readdirSync(agents).sort()).toEqual(["com.apple.other.plist", "dev.fleet.nightly.plist", "dev.hedge.update.plist"]);
    expect(existsSync(join(box.home, ".local/state"))).toBe(false);
  });

  onLinuxHost("says so and exits 1 when a job of an earlier Fleet or Hedge does not stop", () => {
    const box = sandbox("Darwin");
    mkdirSync(join(box.home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(join(box.home, "Library/LaunchAgents/dev.hedge.update.plist"), "<plist/>\n");
    box.stub("launchctl", `case "$1" in list) printf -- '-\\t0\\tdev.hedge.update\\n' ;; print) exit 0 ;; esac`);
    const result = getSh(box, []);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Hedge: the launchd job dev.hedge.update of an earlier Fleet or Hedge still runs. Stop it with: launchctl bootout gui/");
  });
});
