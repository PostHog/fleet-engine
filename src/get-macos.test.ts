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

  function launchd(box: Sandbox, options: { failDisable?: string[]; keepRunning?: string[]; printDisabledFails?: boolean } = {}) {
    const loaded = join(box.root, "loaded");
    const disabled = join(box.root, "disabled");
    const agents = join(box.home, "Library/LaunchAgents");
    writeFileSync(disabled, "");
    box.stub("launchctl", `label=\${2##*/}
case "$1" in
  list) printf -- '-\\t0\\t%s\\n' $(cat "${loaded}") ;;
  bootout) case " ${(options.keepRunning ?? []).join(" ")} " in *" $label "*) exit 5 ;; esac; grep -vx "$label" "${loaded}" > "${loaded}.new"; mv "${loaded}.new" "${loaded}" ;;
  disable) case " ${(options.failDisable ?? []).join(" ")} " in *" $label "*) exit 1 ;; esac; echo "$label" >> "${disabled}" ;;
  print) grep -qx "$label" "${loaded}" || exit 113 ;;
  print-disabled) echo 'disabled services = {'; while read -r off; do printf '\\t"%s" => disabled\\n' "$off"; done < "${disabled}"; echo '}'; ${options.printDisabledFails ? "exit 1" : ":"} ;;
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

  function earlierJobs(box: Sandbox, options: { failDisable?: string[]; keepRunning?: string[]; printDisabledFails?: boolean } = {}) {
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

  onLinuxHost("with --dry-run, names each launchd job of an earlier Fleet or Hedge it would stop and turn off, and leaves every job as it was", () => {
    const box = sandbox("Darwin");
    const jobs = earlierJobs(box);
    const result = getSh(box, ["--", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.output).toBe(
      [
        ...["com.fleet.mcphub", "dev.fleet.nightly", "dev.hedge.update"].map((label) => `Hedge: This is a preview, so Hedge did not stop or turn off the launchd job ${label} of an earlier Fleet or Hedge. Without --dry-run, get.sh stops it and turns it off.`),
        "Hedge: Hedge runs on cloud boxes, not on a Mac. Your Mac only runs the T3 Code app. To set up your hub, follow https://posthog.github.io/hedge/#start",
        "",
      ].join("\n"),
    );
    expect(jobs.login()).toEqual(["com.apple.other", "com.fleet.mcphub", "dev.fleet.nightly", "dev.hedge.update"]);
  });

  for (const [why, args, stub] of [
    ["an unknown flag", ["--dry-run"], undefined],
    ["an unknown flag after --", ["--", "--force"], undefined],
    ["an unknown flag after -- next to --dry-run", ["--", "--dry-run", "--force"], undefined],
    ["sudo", [], "echo 0"],
  ] as const) {
    onLinuxHost(`with ${why}, stops before it touches a launchd job`, () => {
      const box = sandbox("Darwin");
      const jobs = earlierJobs(box);
      if (stub) box.stub("id", stub);
      const result = getSh(box, [...args]);
      expect(result.code).toBe(1);
      expect(result.output).not.toContain("launchd job");
      expect(jobs.login()).toEqual(["com.apple.other", "com.fleet.mcphub", "dev.fleet.nightly", "dev.hedge.update"]);
    });
  }

  onLinuxHost("still turns off each later job when launchd does not stop or turn off two jobs, prints each command a job needs, then exits 1 and names each job once", () => {
    const box = sandbox("Darwin");
    const jobs = earlierJobs(box, { keepRunning: ["com.fleet.mcphub"], failDisable: ["com.fleet.mcphub", "dev.fleet.nightly"] });
    const result = getSh(box, []);
    expect(result.code).toBe(1);
    const uid = result.output.match(/gui\/(\d+)\//)?.[1];
    expect(result.output).toBe(
      [
        `Hedge: the launchd job com.fleet.mcphub of an earlier Fleet or Hedge still runs. Stop it with: launchctl bootout gui/${uid}/com.fleet.mcphub`,
        `Hedge: launchd still has the job com.fleet.mcphub of an earlier Fleet or Hedge turned on, so it starts again at the next login. Turn it off with: launchctl disable gui/${uid}/com.fleet.mcphub`,
        `Hedge: launchd still has the job dev.fleet.nightly of an earlier Fleet or Hedge turned on, so it starts again at the next login. Turn it off with: launchctl disable gui/${uid}/dev.fleet.nightly`,
        "Hedge: stopped and turned off the launchd job dev.hedge.update of an earlier Fleet or Hedge, and kept its files.",
        "Hedge: these launchd jobs of an earlier Fleet or Hedge are not off yet: com.fleet.mcphub, dev.fleet.nightly. Run the commands above, then run get.sh again.",
        "",
      ].join("\n"),
    );
    expect(jobs.login()).toEqual(["com.apple.other", "com.fleet.mcphub", "dev.fleet.nightly"]);
  });

  onLinuxHost("does not take a job as turned off when launchctl print-disabled lists it but fails", () => {
    const box = sandbox("Darwin");
    earlierJobs(box, { printDisabledFails: true });
    const result = getSh(box, []);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("stopped and turned off");
    expect(result.output).toEndWith("Hedge: these launchd jobs of an earlier Fleet or Hedge are not off yet: com.fleet.mcphub, dev.fleet.nightly, dev.hedge.update. Run the commands above, then run get.sh again.\n");
  });

  onLinuxHost("says so and exits 1 when a job of an earlier Fleet or Hedge does not stop", () => {
    const box = sandbox("Darwin");
    earlierJobs(box, { keepRunning: ["dev.hedge.update"] });
    const result = getSh(box, []);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Hedge: the launchd job dev.hedge.update of an earlier Fleet or Hedge still runs. Stop it with: launchctl bootout gui/");
    expect(result.output).toEndWith("Hedge: these launchd jobs of an earlier Fleet or Hedge are not off yet: dev.hedge.update. Run the commands above, then run get.sh again.\n");
  });
});
