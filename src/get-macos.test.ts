import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getShHarness, onLinuxHost, type Sandbox } from "./testing/get-sh.ts";

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

  function launchd(box: Sandbox, options: { failDisable?: string; keepRunning?: string } = {}) {
    const loaded = join(box.root, "loaded");
    const disabled = join(box.root, "disabled");
    const agents = join(box.home, "Library/LaunchAgents");
    writeFileSync(disabled, "");
    box.stub("launchctl", `label=\${2##*/}
case "$1" in
  list) printf -- '-\\t0\\t%s\\n' $(cat "${loaded}") ;;
  bootout) [ "$label" = "${options.keepRunning ?? ""}" ] && exit 5; grep -vx "$label" "${loaded}" > "${loaded}.new"; mv "${loaded}.new" "${loaded}" ;;
  disable) [ "$label" = "${options.failDisable ?? ""}" ] && exit 1; echo "$label" >> "${disabled}" ;;
  print) grep -qx "$label" "${loaded}" || exit 113 ;;
  print-disabled) echo 'disabled services = {'; while read -r off; do printf '\\t"%s" => disabled\\n' "$off"; done < "${disabled}"; echo '}' ;;
esac`);
    const login = () => {
      for (const plist of readdirSync(agents)) {
        const label = plist.replace(/\.plist$/, "");
        const on = readFileSync(loaded, "utf8").split("\n").filter(Boolean);
        if (!readFileSync(disabled, "utf8").split("\n").includes(label) && !on.includes(label)) writeFileSync(loaded, [...on, label, ""].join("\n"));
      }
      return readFileSync(loaded, "utf8").split("\n").filter(Boolean).sort();
    };
    return { loaded, agents, login };
  }

  function earlierJobs(box: Sandbox, options: { failDisable?: string; keepRunning?: string } = {}) {
    const jobs = launchd(box, options);
    mkdirSync(jobs.agents, { recursive: true });
    for (const label of ["dev.fleet.nightly", "dev.hedge.update", "com.apple.other"]) writeFileSync(join(jobs.agents, `${label}.plist`), "<plist/>\n");
    writeFileSync(jobs.loaded, "dev.fleet.nightly\ndev.hedge.update\ncom.fleet.mcphub\ncom.apple.other\n");
    return jobs;
  }

  onLinuxHost("with an earlier Fleet or Hedge on the Mac, stops and turns off each of their launchd jobs, keeps their files, installs nothing, and points at the setup page", () => {
    const box = sandbox("Darwin");
    const jobs = earlierJobs(box);
    mkdirSync(join(box.home, ".local/share/hedge/engine"), { recursive: true });
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
    expect(readdirSync(jobs.agents).sort()).toEqual(["com.apple.other.plist", "dev.fleet.nightly.plist", "dev.hedge.update.plist"]);
    expect(existsSync(join(box.home, ".local/state"))).toBe(false);
    expect(jobs.login()).toEqual(["com.apple.other"]);
  });

  onLinuxHost("exits 1 and names the job when launchd does not turn it off, so it would start again at the next login", () => {
    const box = sandbox("Darwin");
    const jobs = earlierJobs(box, { failDisable: "dev.fleet.nightly" });
    const result = getSh(box, []);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Hedge: launchd still has the job dev.fleet.nightly of an earlier Fleet or Hedge turned on, so it starts again at the next login. Turn it off with: launchctl disable gui/");
    expect(jobs.login()).toContain("dev.fleet.nightly");
  });

  onLinuxHost("says so and exits 1 when a job of an earlier Fleet or Hedge does not stop", () => {
    const box = sandbox("Darwin");
    earlierJobs(box, { keepRunning: "dev.hedge.update" });
    const result = getSh(box, []);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Hedge: the launchd job dev.hedge.update of an earlier Fleet or Hedge still runs. Stop it with: launchctl bootout gui/");
  });
});
