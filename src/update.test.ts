import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileFile } from "./pack/types.ts";
import { isolateGit, spawnGit, template, tempDirs } from "./testing/git.ts";
import { spawnAsync } from "./testing/spawn.ts";
import { noticePath, readNotice, update } from "./update.ts";
import { main } from "./cli.ts";
import { spawnRunner, type CommandRunner } from "./adapters/run.ts";
import { engineRoot, fakeMachine, pushedAnswers, scripted } from "./setup/testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const engineRemotes = new Map<string, (target: string) => Promise<string>>();

function engineRemote(tags: string[]) {
  const key = tags.join(" ");
  const built = engineRemotes.get(key) ?? template(async (dir) => {
    await spawnGit(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "engine" }));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    writeFileSync(join(dir, "presets.json"), JSON.stringify([{ id: "bare", name: "Bare", blurb: "Base only.", packs: [], workflows: {} }]));
    mkdirSync(join(dir, "templates/profile"), { recursive: true });
    copyFileSync(join(engineRoot, "templates/profile/install.sh"), join(dir, "templates/profile/install.sh"));
    mkdirSync(join(dir, "packs/base"), { recursive: true });
    writeFileSync(join(dir, "packs/base/pack.json"), JSON.stringify({ schema: 1, name: "base", summary: "Base." }));
    for (const tag of tags) {
      writeFileSync(join(dir, "VERSION"), tag);
      await spawnGit(dir, "add", ".");
      await spawnGit(dir, "commit", "-q", "-m", tag);
      await spawnGit(dir, "tag", tag);
    }
    writeFileSync(join(dir, "VERSION"), "main");
    await spawnGit(dir, "commit", "-q", "-am", "main");
  });
  engineRemotes.set(key, built);
  return built(temp.make("engine-remote-"));
}

async function engineCheckout(remote: string, ref: string) {
  const dir = temp.make("engine-");
  await spawnGit(dir, "init", "-q");
  await spawnGit(dir, "remote", "add", "origin", remote);
  await spawnGit(dir, "fetch", "-q", "--depth", "1", "origin", ref);
  await spawnGit(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
  return dir;
}

async function onGithub(engineDir: string, slug: string, remote: string) {
  const url = `https://github.com/${slug}.git`;
  await spawnGit(engineDir, "remote", "set-url", "origin", url);
  await spawnGit(engineDir, "config", `url.${remote}.insteadOf`, url);
  return url;
}

async function pinSavedBySetup(engineDir: string) {
  const home = temp.make("home-");
  const box = fakeMachine(home);
  const io = scripted(["", ""]);
  const code = await main(["setup", "--preset", "bare", "--plan", "claude"], { home, engineRoot: engineDir, platform: "linux", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: box.machine, clock: box.clock, doctor: async () => 0, env: {}, timeZone: "UTC" } });
  if (code !== 0) throw new Error(`hedge setup failed:\n${io.output()}`);
  return (await pushedAnswers(home)).engine;
}

const originOf = async (engineDir: string) => (await spawnGit(engineDir, "config", "--get", "remote.origin.url")).trim();

async function run(engineDir: string, engine: ProfileFile["engine"], profileDir = temp.make("profile-")) {
  const home = temp.make("home-");
  const lines: string[] = [];
  let applied = 0;
  let appliedProfile: string | undefined;
  const runApply = async () => {
    applied++;
    const answers = join(profileDir, "hedge.json");
    appliedProfile = existsSync(answers) ? readFileSync(answers, "utf8") : undefined;
    return 0;
  };
  const code = await update({ home, engineDir, profileDir, engine, print: (line) => lines.push(line), runApply });
  return { code, home, applied, appliedProfile, output: lines.join("\n"), version: await Bun.file(join(engineDir, "VERSION")).text() };
}

describe("hedge update", () => {
  test.each(["PostHog/fleet-engine", "Silthus/fleet-engine", "https://github.com/PostHog/fleet-engine"])("keeps the Hedge origin when the profile still names %s, this engine's repository from before the rename", async (repo) => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    const hedge = await onGithub(engineDir, "PostHog/hedge", remote);

    const result = await run(engineDir, { repo, ref: "v0.1.0", channel: "release" });

    expect(result.code).toBe(0);
    expect(result.version).toBe("v0.1.1");
    expect(await originOf(engineDir)).toBe(hedge);
  });

  test("follows a fork that the profile names, such as Acme/fleet-engine, away from the Hedge origin", async () => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1"]);
    const fork = temp.make("fork-");
    await spawnGit(fork, "clone", "-q", remote, ".");
    writeFileSync(join(fork, "VERSION"), "v0.1.3");
    await spawnGit(fork, "commit", "-q", "-am", "fork release");
    await spawnGit(fork, "tag", "v0.1.3");
    const engineDir = await engineCheckout(remote, "v0.1.0");
    await onGithub(engineDir, "PostHog/hedge", remote);
    await spawnGit(engineDir, "config", `url.${fork}.insteadOf`, "https://github.com/Acme/fleet-engine.git");

    const result = await run(engineDir, { repo: "Acme/fleet-engine", ref: "v0.1.0", channel: "release" });

    expect(result.output).toContain("The engine now comes from Acme/fleet-engine.");
    expect(result.code).toBe(0);
    expect(result.version).toBe("v0.1.3");
    expect(await originOf(engineDir)).toBe("https://github.com/Acme/fleet-engine.git");
  });

  async function hedgeReleaseWithOlderFork() {
    const remote = await engineRemote(["v0.1.0", "v0.1.5"]);
    const fork = temp.make("fork-");
    await spawnGit(fork, "clone", "-q", await engineRemote(["v0.1.0"]), ".");
    writeFileSync(join(fork, "VERSION"), "fork v0.1.2");
    await spawnGit(fork, "commit", "-q", "-am", "fork release");
    await spawnGit(fork, "tag", "v0.1.2");
    const engineDir = await engineCheckout(remote, "v0.1.5");
    await spawnGit(engineDir, "fetch", "-q", "--tags", "origin");
    await onGithub(engineDir, "PostHog/hedge", remote);
    return { engineDir, fork };
  }

  test("follows a fork whose newest release is older than the Hedge release it ran", async () => {
    const { engineDir, fork } = await hedgeReleaseWithOlderFork();
    await spawnGit(engineDir, "config", `url.${fork}.insteadOf`, "https://github.com/Acme/fleet-engine.git");

    const result = await run(engineDir, { repo: "Acme/fleet-engine", ref: "v0.1.0", channel: "release" });

    expect(result.output).toContain("The engine now comes from Acme/fleet-engine.");
    expect(result.code).toBe(0);
    expect(result.version).toBe("fork v0.1.2");
  });

  test("after the fork cannot be fetched, keeps the Hedge origin, and the next update still moves to the fork's release", async () => {
    const { engineDir, fork } = await hedgeReleaseWithOlderFork();
    const hedge = await originOf(engineDir);
    await spawnGit(engineDir, "config", `url.${join(fork, "gone")}.insteadOf`, "https://github.com/Acme/fleet-engine.git");

    const failed = await run(engineDir, { repo: "Acme/fleet-engine", ref: "v0.1.0", channel: "release" });

    expect(failed).toMatchObject({ code: 1, version: "v0.1.5" });
    expect(await originOf(engineDir)).toBe(hedge);

    await spawnGit(engineDir, "config", "--remove-section", `url.${join(fork, "gone")}`);
    await spawnGit(engineDir, "config", `url.${fork}.insteadOf`, "https://github.com/Acme/fleet-engine.git");
    const retried = await run(engineDir, { repo: "Acme/fleet-engine", ref: "v0.1.0", channel: "release" });

    expect(retried).toMatchObject({ code: 0, version: "fork v0.1.2" });
    expect(await originOf(engineDir)).toBe("https://github.com/Acme/fleet-engine.git");
  });

  test("after the fork's packages do not install, keeps the Hedge origin, and the next update moves to the fork's fixed release", async () => {
    const { engineDir, fork } = await hedgeReleaseWithOlderFork();
    const hedge = await originOf(engineDir);
    await spawnGit(engineDir, "config", `url.${fork}.insteadOf`, "https://github.com/Acme/fleet-engine.git");
    const forkRelease = async (version: string, packageJson: object) => {
      writeFileSync(join(fork, "package.json"), JSON.stringify(packageJson));
      writeFileSync(join(fork, "VERSION"), `fork ${version}`);
      await spawnGit(fork, "commit", "-q", "-am", version);
      await spawnGit(fork, "tag", version);
    };
    await forkRelease("v0.1.3", { name: "engine", dependencies: { missing: "file:./missing" } });

    const failed = await run(engineDir, { repo: "Acme/fleet-engine", ref: "v0.1.0", channel: "release" });

    expect(failed).toMatchObject({ code: 1, version: "v0.1.5", output: expect.stringContaining("so the update was rolled back") });
    expect(await originOf(engineDir)).toBe(hedge);

    await forkRelease("v0.1.4", { name: "engine" });
    const retried = await run(engineDir, { repo: "Acme/fleet-engine", ref: "v0.1.0", channel: "release" });

    expect(retried).toMatchObject({ code: 0, version: "fork v0.1.4" });
    expect(await originOf(engineDir)).toBe("https://github.com/Acme/fleet-engine.git");
  });

  test("leaves a tag the user made with the name of the release it moves to on the user's commit, and hedge setup saves that release as the engine pin", async () => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    const users = await spawnGit(engineDir, "rev-parse", "HEAD");
    await spawnGit(engineDir, "tag", "v0.1.1");

    const result = await run(engineDir, { repo: remote, ref: "v0.1.0", channel: "release" });
    const again = await run(engineDir, { repo: remote, ref: "v0.1.0", channel: "release" });

    expect(result).toMatchObject({ code: 0, version: "v0.1.1" });
    expect(await spawnGit(engineDir, "rev-parse", "refs/tags/v0.1.1")).toBe(users);
    expect(await pinSavedBySetup(engineDir)).toEqual({ repo: "PostHog/hedge", ref: "v0.1.1", channel: "release" });
    expect(again.output).toContain("Engine is at v0.1.1.");
  });

  test("after a fork's release with the same version does not install, hedge setup still saves the release that stays installed", async () => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    await onGithub(engineDir, "PostHog/hedge", remote);
    expect(await run(engineDir, { repo: "PostHog/hedge", ref: "v0.1.0", channel: "release" })).toMatchObject({ code: 0, version: "v0.1.1" });
    const fork = temp.make("fork-");
    await spawnGit(fork, "clone", "-q", remote, ".");
    writeFileSync(join(fork, "package.json"), JSON.stringify({ name: "engine", dependencies: { missing: "file:./missing" } }));
    writeFileSync(join(fork, "VERSION"), "fork v0.1.1");
    await spawnGit(fork, "commit", "-q", "-am", "fork v0.1.1");
    await spawnGit(fork, "tag", "-f", "v0.1.1");
    await spawnGit(engineDir, "config", `url.${fork}.insteadOf`, "https://github.com/Acme/fleet-engine.git");

    const failed = await run(engineDir, { repo: "Acme/fleet-engine", ref: "v0.1.0", channel: "release" });

    expect(failed).toMatchObject({ code: 1, version: "v0.1.1", output: expect.stringContaining("so the update was rolled back") });
    expect(await pinSavedBySetup(engineDir)).toEqual({ repo: "PostHog/hedge", ref: "v0.1.1", channel: "release" });
  });

  test("hedge triage --print names the release that hedge update installed", async () => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    expect(await run(engineDir, { repo: remote, ref: "v0.1.0", channel: "release" })).toMatchObject({ code: 0, version: "v0.1.1" });
    const io = scripted([]);
    const capture: CommandRunner = async (command, options) => (command[0] === "git" && command[2] === engineDir ? spawnRunner(command, options) : { code: 1, stdout: "", stderr: "not found" });

    const code = await main(["triage", "--print"], { home: temp.make("home-"), engineRoot: engineDir, platform: "linux", env: {}, print: io.terminal.print, terminal: io.terminal, capture, hostname: () => "box", run: async () => 0 });

    expect(code).toBe(0);
    expect(io.output()).toContain("- Engine: v0.1.1\n");
  });

  test("keeps a tag the user made in the engine checkout when it moves to a newer release", async () => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    await spawnGit(engineDir, "tag", "my-notes");

    const result = await run(engineDir, { repo: remote, ref: "v0.1.0", channel: "release" });

    expect(result).toMatchObject({ code: 0, version: "v0.1.1" });
    expect(await spawnGit(engineDir, "tag", "--list", "my-notes")).toBe("my-notes");
  });

  test("moves the release channel to the newest tag of its major and reports a new major", async () => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1", "v0.2.0", "v1.0.0"]);
    const result = await run(await engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 0, applied: 1 });
    expect(result.version).toBe("v0.2.0");
    expect(result.output).toContain("Hedge v1.0.0 is out. It is a new major version, so this update stays on v0.");
    expect(await readNotice(result.home)).toStartWith("Hedge v1.0.0 is out.");
  });

  test("clears the notice when no new major exists", async () => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1"]);
    const result = await run(await engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result.version).toBe("v0.1.1");
    expect(existsSync(noticePath(result.home))).toBe(false);
  });

  test("moves the track channel to main", async () => {
    const remote = await engineRemote(["v0.1.0", "v1.0.0"]);
    const result = await run(await engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "main", channel: "track" });
    expect(result.version).toBe("main");
    expect(result.applied).toBe(1);
  });

  test("fast-forwards the profile before it applies", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const profileRemote = temp.make("profile-remote-");
    await spawnGit(profileRemote, "init", "-q", "-b", "main");
    writeFileSync(join(profileRemote, "hedge.json"), "{}\n");
    await spawnGit(profileRemote, "add", ".");
    await spawnGit(profileRemote, "commit", "-q", "-m", "start");
    const profileDir = temp.make("profile-");
    await spawnGit(profileDir, "clone", "-q", profileRemote, ".");
    writeFileSync(join(profileRemote, "hedge.json"), '{"plan":"claude"}\n');
    await spawnGit(profileRemote, "commit", "-q", "-am", "answers");
    await run(await engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" }, profileDir);
    expect(await Bun.file(join(profileDir, "hedge.json")).text()).toBe('{"plan":"claude"}\n');
  });

  test("applies the last profile but fails when the profile does not fast-forward", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const profileRemote = temp.make("profile-remote-");
    await spawnGit(profileRemote, "init", "-q", "-b", "main");
    writeFileSync(join(profileRemote, "hedge.json"), "{}\n");
    await spawnGit(profileRemote, "add", ".");
    await spawnGit(profileRemote, "commit", "-q", "-m", "start");
    const profileDir = temp.make("profile-");
    await spawnGit(profileDir, "clone", "-q", profileRemote, ".");
    writeFileSync(join(profileRemote, "hedge.json"), '{"plan":"claude"}\n');
    await spawnGit(profileRemote, "commit", "-q", "-am", "answers");
    writeFileSync(join(profileDir, "hedge.json"), '{"plan":"local"}\n');
    await spawnGit(profileDir, "commit", "-q", "-am", "local answers");
    const result = await run(await engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" }, profileDir);
    expect(result).toMatchObject({ code: 1, appliedProfile: '{"plan":"local"}\n', output: expect.stringContaining("your profile did not fast-forward") });
  });

  test("does not apply when the engine cannot be fetched", async () => {
    const engineDir = await engineCheckout(await engineRemote(["v0.1.0"]), "v0.1.0");
    await spawnGit(engineDir, "remote", "set-url", "origin", join(temp.make(), "gone"));
    const result = await run(engineDir, { repo: "gone", ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0 });
    expect(result.output).toContain("could not fetch the engine");
  });

  test("refuses an engine checkout with local changes", async () => {
    const engineDir = await engineCheckout(await engineRemote(["v0.1.0", "v0.1.1"]), "v0.1.0");
    writeFileSync(join(engineDir, "VERSION"), "patched");
    const result = await run(engineDir, { repo: "unused", ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0, output: expect.stringContaining("has local changes") });
    expect(result.version).toBe("patched");
  });

  test("follows the profile's engine repository", async () => {
    const original = await engineRemote(["v0.1.0"]);
    const engineDir = await engineCheckout(original, "v0.1.0");
    const moved = temp.make("engine-moved-");
    await spawnGit(moved, "clone", "-q", original, ".");
    writeFileSync(join(moved, "VERSION"), "v0.2.0");
    await spawnGit(moved, "commit", "-q", "-am", "v0.2.0");
    await spawnGit(moved, "tag", "v0.2.0");
    const result = await run(engineDir, { repo: moved, ref: "v0.1.0", channel: "release" });
    expect(result.output).toContain(`The engine now comes from ${moved}.`);
    expect(result.version).toBe("v0.2.0");
  });

  test("keeps a token in the profile's engine URL out of its messages when it follows that repository", async () => {
    const original = await engineRemote(["v0.1.0"]);
    const engineDir = await engineCheckout(original, "v0.1.0");
    const moved = temp.make("engine-moved-");
    await spawnGit(moved, "clone", "-q", original, ".");
    writeFileSync(join(moved, "VERSION"), "v0.2.0");
    await spawnGit(moved, "commit", "-q", "-am", "v0.2.0");
    await spawnGit(moved, "tag", "v0.2.0");
    const withToken = "https://hedge:s3cret-token@git.example.invalid/engine.git";
    await spawnGit(engineDir, "config", `url.${moved}.insteadOf`, withToken);
    const result = await run(engineDir, { repo: withToken, ref: "v0.1.0", channel: "release" });
    expect(result.version).toBe("v0.2.0");
    expect(result.output).toContain("The engine now comes from https://git.example.invalid/engine.git.");
    expect(result.output).not.toContain("s3cret-token");
  });

  test("never moves an engine that is not on a release back to one", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const result = await run(await engineCheckout(remote, "main"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 0, applied: 1, output: expect.stringContaining("is not a release, so hedge update does not move it back") });
    expect(result.version).toBe("main");
  });

  test("installs the packages the new engine needs before it applies", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    mkdirSync(join(remote, "dep"));
    writeFileSync(join(remote, "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
    writeFileSync(join(remote, "package.json"), JSON.stringify({ name: "engine", dependencies: { dep: "file:./dep" } }));
    expect((await spawnAsync([process.execPath, "install"], { cwd: remote })).exitCode).toBe(0);
    writeFileSync(join(remote, "VERSION"), "v0.2.0");
    await spawnGit(remote, "add", ".");
    await spawnGit(remote, "commit", "-q", "-m", "v0.2.0");
    await spawnGit(remote, "tag", "v0.2.0");
    const result = await run(engineDir, { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 0, applied: 1, version: "v0.2.0" });
    expect(existsSync(join(engineDir, "node_modules", "dep", "package.json"))).toBe(true);
    expect(await spawnGit(engineDir, "status", "--porcelain")).toBe("");
  });

  test("stops before apply when the engine's packages do not install", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    writeFileSync(join(remote, "package.json"), JSON.stringify({ name: "engine", dependencies: { missing: "file:./missing" } }));
    writeFileSync(join(remote, "VERSION"), "v0.2.0");
    await spawnGit(remote, "commit", "-q", "-am", "v0.2.0");
    await spawnGit(remote, "tag", "v0.2.0");
    const before = await spawnGit(engineDir, "rev-parse", "HEAD");
    const result = await run(engineDir, { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0, version: "v0.1.0" });
    expect(await spawnGit(engineDir, "rev-parse", "HEAD")).toBe(before);
    expect(result.output).toContain(`could not install the engine's packages in ${engineDir}, so the update was rolled back. The engine stays at ${before.slice(0, 7)}.\n`);
  });

  test("puts back the old engine's packages when the new engine's install fails halfway", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const release = async (version: string, dep: string, scripts?: Record<string, string>) => {
      mkdirSync(join(remote, "dep"), { recursive: true });
      writeFileSync(join(remote, "dep", "package.json"), JSON.stringify({ name: "dep", version: dep }));
      writeFileSync(join(remote, "package.json"), JSON.stringify({ name: "engine", dependencies: { dep: "file:./dep" }, ...(scripts ? { scripts } : {}) }));
      expect((await spawnAsync([process.execPath, "install", "--ignore-scripts"], { cwd: remote })).exitCode).toBe(0);
      writeFileSync(join(remote, "VERSION"), version);
      await spawnGit(remote, "add", ".");
      await spawnGit(remote, "commit", "-q", "-m", version);
      await spawnGit(remote, "tag", version);
    };
    await release("v0.1.1", "1.0.0");
    await release("v0.2.0", "2.0.0", { postinstall: "exit 1" });
    const engineDir = await engineCheckout(remote, "v0.1.1");
    expect((await spawnAsync([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: engineDir })).exitCode).toBe(0);
    const installed = () => JSON.parse(readFileSync(join(engineDir, "node_modules", "dep", "package.json"), "utf8")).version;
    expect(installed()).toBe("1.0.0");
    const result = await run(engineDir, { repo: remote, ref: "v0.1.1", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0, version: "v0.1.1" });
    expect(installed()).toBe("1.0.0");
  });

  test("stops before apply when the track checkout fails", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    writeFileSync(join(engineDir, ".git", "index.lock"), "");
    const result = await run(engineDir, { repo: remote, ref: "main", channel: "track" });
    expect(result).toMatchObject({ code: 1, applied: 0, output: expect.stringContaining("could not check out main") });
    expect(result.version).toBe("v0.1.0");
  });
});

describe("hedge update with a profile in a Fleet path", () => {
  async function machine(withCopy: boolean) {
    const home = temp.make("home-");
    const remote = await engineRemote(["v0.1.0"]);
    const profileRemote = temp.make("profile-remote-");
    await spawnGit(profileRemote, "init", "-q", "-b", "main");
    writeFileSync(join(profileRemote, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: remote, ref: "v0.1.0", channel: "release" }, sources: [], packs: [], plan: "both", settings: {}, workflows: {} }));
    await spawnGit(profileRemote, "add", ".");
    await spawnGit(profileRemote, "commit", "-q", "-m", "start");
    const old = join(home, ".local/share/fleet/profile");
    const copy = join(home, ".local/share/hedge/profile");
    for (const dir of withCopy ? [old, copy] : [old]) mkdirSync(dir, { recursive: true }), await spawnGit(dir, "clone", "-q", profileRemote, ".");
    await spawnGit(profileRemote, "commit", "-q", "--allow-empty", "-m", "newer answers");
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "devbox", profileDir: old }));
    const head = async (dir: string) => (await spawnAsync(["git", "-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    const lines: string[] = [];
    const code = await main(["update"], { home, engineRoot: await engineCheckout(remote, "v0.1.0"), platform: "linux", env: {}, print: (line) => lines.push(line) });
    return { code, output: lines.join("\n"), old: await head(old), copy: withCopy ? await head(copy) : undefined, newest: await head(profileRemote) };
  }

  test("pulls the Hedge copy and leaves the old profile as it was", async () => {
    const result = await machine(true);
    expect(result.copy).toBe(result.newest);
    expect(result.old).not.toBe(result.newest);
  });

  test("refuses before it pulls when the profile has no Hedge copy", async () => {
    const result = await machine(false);
    expect(result.code).toBe(1);
    expect(result.output).toContain("is in a Fleet path from before the rename, so Hedge does not use it.");
    expect(result.old).not.toBe(result.newest);
  });
});
