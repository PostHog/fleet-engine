import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import { legacyPaths } from "./legacy.ts";
import { cliFixtures, repoRoot } from "./testing/cli.ts";
import { tempDirs } from "./testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const { profileDir, hedge } = cliFixtures(temp);

const isLink = (path: string) => lstatSync(path).isSymbolicLink();
const stateOf = (home: string) => JSON.parse(readFileSync(join(home, ".local/state/hedge/state.json"), "utf8")) as { groups: Record<string, Record<string, unknown>> };

function beforeTheRename(home: string) {
  for (const [before, after] of legacyPaths) if (existsSync(join(home, after))) renameSync(join(home, after), join(home, before));
  const path = join(home, ".local/state/fleet/state.json");
  const state = JSON.parse(readFileSync(path, "utf8")) as { version: number; groups: Record<string, Record<string, unknown>> };
  const entries = Object.fromEntries(Object.entries(state.groups.hedge!).map(([target, entry]) => [target.replace(/^\.config\/hedge\//, ".config/fleet/"), entry]));
  writeFileSync(path, JSON.stringify({ version: state.version, groups: { fleet: entries } }));
}

describe("hedge apply on a machine from before the rename", () => {
  test("moves each old folder to its new name, leaves a link at the old name, and takes over the files it wrote there", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    expect((await hedge(["apply", "--profile", profile], home)).code).toBe(0);
    beforeTheRename(home);
    writeFileSync(join(home, ".config/fleet/kept.txt"), "mine\n");

    const result = await hedge(["apply", "--profile", profile], home);

    expect(result.code).toBe(0);
    expect(result.output).toContain("moved ~/.config/fleet to ~/.config/hedge");
    expect(result.output).toContain("moved ~/.local/state/fleet to ~/.local/state/hedge");
    expect(isLink(join(home, ".config/fleet"))).toBe(true);
    expect(readlinkSync(join(home, ".config/fleet"))).toBe("hedge");
    expect(readFileSync(join(home, ".config/fleet/kept.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(home, ".config/hedge/kept.txt"), "utf8")).toBe("mine\n");
    const state = stateOf(home);
    expect(Object.keys(state.groups)).toEqual(["hedge"]);
    expect(Object.keys(state.groups.hedge!).filter((target) => target.startsWith(".config/fleet/"))).toEqual([]);
    expect(Object.keys(state.groups.hedge!)).toContain(".config/hedge/hooks/run.sh");
    expect((await hedge(["apply", "--profile", profile], home)).output).not.toContain("moved");
  });

  test("on a machine set up after the rename, moves nothing and makes no old names", async () => {
    const home = temp.make("home-");
    const result = await hedge(["apply", "--profile", profileDir()], home);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("moved");
    for (const [before] of legacyPaths) expect(existsSync(join(home, before))).toBe(false);
  });

  test("when the old and the new folder are both there, the new one wins and the old one stays as it is", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/old.txt"), "old\n");
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/new.txt"), "new\n");

    const result = await hedge(["apply", "--profile", profileDir()], home);

    expect(result.code).toBe(0);
    expect(result.output).not.toContain("moved ~/.config/fleet");
    expect(isLink(join(home, ".config/fleet"))).toBe(false);
    expect(readFileSync(join(home, ".config/fleet/old.txt"), "utf8")).toBe("old\n");
    expect(existsSync(join(home, ".config/hedge/old.txt"))).toBe(false);
    expect(readFileSync(join(home, ".config/hedge/new.txt"), "utf8")).toBe("new\n");
  });

  test("a dry run moves nothing", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    await hedge(["apply", "--profile", profileDir(), "--dry-run"], home);
    expect(isLink(join(home, ".config/fleet"))).toBe(false);
    expect(existsSync(join(home, ".config/hedge"))).toBe(false);
  });
});

describe("a profile from before the rename", () => {
  test("applies from fleet.json when hedge.json is not there", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    renameSync(join(profile, "hedge.json"), join(profile, "fleet.json"));
    expect((await hedge(["apply", "--profile", profile], home)).code).toBe(0);
    expect(existsSync(join(home, ".config/hedge/hooks/run.sh"))).toBe(true);
  });

  test("reads hedge.json when both are there", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    writeFileSync(join(profile, "fleet.json"), "not json");
    expect((await hedge(["apply", "--profile", profile], home)).code).toBe(0);
  });
});

describe("FLEET_ variables from before the rename", () => {
  test("set each HEDGE_ variable that is unset, and leave a set one as it is", async () => {
    const env: Record<string, string | undefined> = { FLEET_PROOF_REVIEWER: "reviewer", FLEET_MODELS: "old", HEDGE_MODELS: "new" };
    await main(["--help"], { home: temp.make("home-"), engineRoot: repoRoot, platform: "linux", env, print: () => {} });
    expect(env.HEDGE_PROOF_REVIEWER).toBe("reviewer");
    expect(env.HEDGE_MODELS).toBe("new");
  });
});
