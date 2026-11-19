import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { changeOnFirstCommit as changeOnFirstCommitIn, fakeMachine, hedgeSetup, githubRepo, pushedAnswers } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

async function nameHub(profile: string) {
  const answers = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
  if (answers.hub) return;
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...answers, hub: "coder.hedge-hub" }, null, 2) + "\n");
  await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
  await spawnGit(profile, "push", "-q");
}

describe("hedge setup with a devbox", () => {
  test("asks the settings only a devbox needs once a devbox is added, saves them to the profile before the box applies it, and a run without a person lists them", async () => {
    const question = "? Which T3 project do the loops and the PR digest run in?";
    const args = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on"];
    const alone = temp.make("home-");
    expect((await hedgeSetup(alone, [...args, "--devbox", "skip"], ["", ""], fakeMachine(alone))).output).not.toContain(question);

    const home = temp.make("home-");
    const result = await hedgeSetup(home, [...args, "--devbox", "node-1"], ["", "", "~/code/app"], fakeMachine(home));
    expect(result.code).toBe(0);
    const output = result.output;
    expect(output.indexOf(question)).toBeGreaterThan(output.indexOf("  ✓ node-1"));
    expect(output.indexOf(question)).toBeLessThan(output.indexOf("▶ Install Hedge on node-1"));
    expect((await pushedAnswers(home)).settings["orchestration.loopProject"]).toBe("~/code/app");

    const later = temp.make("home-");
    const waiting = await hedgeSetup(later, ["--non-interactive", ...args, "--devbox", "node-9"], [], fakeMachine(later));
    expect(waiting.code).toBe(2);
    expect(waiting.output).toContain("  --set orchestration.loopProject=<value>   Which T3 project do the loops and the PR digest run in?");
  });

  test("a devbox setting whose push failed is pushed on the next run before the box is installed", async () => {
    const args = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on", "--devbox", "node-1"];
    const home = temp.make("home-");
    expect((await hedgeSetup(home, args, ["", ""], fakeMachine(home))).code).toBe(130);
    const rejecting = join(githubRepo(home, "nora/hedge-profile"), "hooks/pre-receive");
    writeFileSync(rejecting, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect((await hedgeSetup(home, args, ["~/code/app"], fakeMachine(home))).output).toContain("could not push answers");

    const blocked = await hedgeSetup(home, ["--non-interactive", ...args], [], fakeMachine(home));
    expect(blocked.output).toContain("could not push answers: ! [remote rejected] HEAD -> main (pre-receive hook declined). Fix that, then try again.");
    expect(blocked.output).not.toContain("▶ Install Hedge on node-1");

    rmSync(rejecting);
    expect((await hedgeSetup(home, ["--non-interactive", ...args], [], fakeMachine(home))).code).toBe(0);
    expect((await pushedAnswers(home)).settings["orchestration.loopProject"]).toBe("~/code/app");
  });

  const devboxArgs = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on", "--devbox", "node-1"];

  const changeOnFirstCommit = (home: string, change: string) => changeOnFirstCommitIn(home, join(temp.make("elsewhere-"), "profile"), change);

  test("a devbox setting saved while another machine changes a setting keeps that machine's value", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    const publishNow = await changeOnFirstCommit(home, 'profile.settings = { ...profile.settings, "elsewhere.setting": value };');
    publishNow("before");

    const resumed = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(resumed.code).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "elsewhere.setting": "after", "orchestration.loopProject": "~/code/app" });
  });

  test("stops when another machine changes the same devbox setting before the push, and the same command run again saves this run's answer", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    await changeOnFirstCommit(home, 'profile.settings = { ...profile.settings, "orchestration.loopProject": value };');

    const stopped = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: ${profilePath(home)}: another machine saved your profile while this command ran. Run the same command again: it starts from the profile as it is now.`);
    expect((await pushedAnswers(home)).settings).toEqual({ "orchestration.loopProject": "after" });
    expect((await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home))).code).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "orchestration.loopProject": "~/code/app" });
  });

  test("stops when another machine changes a devbox setting while setup asks it, and the same command run again keeps that machine's value", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    const publish = await changeOnFirstCommit(home, 'profile.settings = { ...profile.settings, "orchestration.loopProject": value };');
    rmSync(join(profilePath(home), ".git/hooks/post-commit"));
    publish("old-project");

    const stopped = await hedgeSetup(home, devboxArgs, [() => (publish("new-project"), "")], fakeMachine(home));

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: ${profilePath(home)}: another machine saved your profile while this command ran. Run the same command again: it starts from the profile as it is now.`);
    expect((await pushedAnswers(home)).settings).toEqual({ "orchestration.loopProject": "new-project" });
    expect((await hedgeSetup(home, devboxArgs, [""], fakeMachine(home))).code).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "orchestration.loopProject": "new-project" });
  });

  test("stops before it saves a devbox setting when hedge.json has a staged change, and keeps that change", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    const file = join(profilePath(home), "hedge.json");
    const committed = readFileSync(file, "utf8");
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(committed), settings: { "local.setting": "mine" } }, null, 2)}\n`);
    await spawnGit(profilePath(home), "add", "hedge.json");
    writeFileSync(file, committed);
    const staged = await spawnGit(profilePath(home), "show", ":hedge.json");

    const resumed = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(resumed.code).toBe(1);
    expect(resumed.output).toContain(`${profilePath(home)}: hedge.json has changes that are not committed. Commit or discard them, then try again.`);
    expect(await spawnGit(profilePath(home), "show", ":hedge.json")).toBe(staged);
    expect((await pushedAnswers(home)).settings).toEqual({});
  });

  test("stops before it saves a devbox setting when hedge.json has a change that is not committed, and keeps that change", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    await changeOnFirstCommit(home, 'profile.settings = { ...profile.settings, "elsewhere.setting": value };');
    const file = join(profilePath(home), "hedge.json");
    const edited = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, `${JSON.stringify({ ...edited, settings: { ...edited.settings, "local.setting": "mine" } }, null, 2)}\n`);
    const before = readFileSync(file, "utf8");

    const resumed = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(resumed.code).toBe(1);
    expect(resumed.output).toContain(`${profilePath(home)}: hedge.json has changes that are not committed. Commit or discard them, then try again.`);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((await pushedAnswers(home)).settings).toEqual({});
  });

  test("hedge setup --devbox lists the node in the profile, and the hub takes it before the node asks it for a credential and links it in T3 Code once the node runs T3", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home);
    const result = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "coder.hedge-node-1"], ["", "", ""], box, undefined, 0, "linux", nameHub);
    expect(result.code).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-node-1"]);
    expect(box.hubUpdates).toEqual(["coder.hedge-hub"]);
    expect(box.credentials).toEqual([{ node: "coder.hedge-node-1", issued: true }]);
    expect(result.output).toContain("✓ The hub, coder.hedge-hub, took coder.hedge-node-1: its disk watch, tunnels and credentials include it now.");
    expect(box.hubLinked).toEqual(["coder.hedge-node-1"]);
    expect(result.output).toContain("✓ The hub, coder.hedge-hub, linked coder.hedge-node-1 in T3 Code.");
  });

  test("hedge setup run again has the hub take the node, then applies the node's profile and links it from the hub, when the hub could not take it on an earlier run that stopped or finished", async () => {
    for (const [polls, firstCode] of [[{ "box:github": 1 }, 2], [{}, 0]] as const) {
      const home = temp.make("home-");
      const args = ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "coder.hedge-node-1"];
      for (const hubUpdateFails of ["hedge update: the engine has local changes.", undefined]) {
        const failing = fakeMachine(home, polls, hubUpdateFails ? { hubUpdateFails } : { hubDown: true });
        expect((await hedgeSetup(home, args, [], failing, undefined, 0, "linux", nameHub)).code).toBe(firstCode);
      }
      const box = fakeMachine(home);
      expect((await hedgeSetup(home, args, [], box, undefined, 0, "linux", nameHub)).code).toBe(0);
      expect(box.hubUpdates).toEqual(["coder.hedge-hub"]);
      expect(box.credentials).toEqual([{ node: "coder.hedge-node-1", issued: true }]);
      expect(box.hubLinked).toEqual(["coder.hedge-node-1"]);
    }
  });
});
