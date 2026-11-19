import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("a devbox setting whose push comes after another machine's stops and keeps its commit, and after git pull --rebase the same command run again saves it on top", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    await changeOnFirstCommit(home, 'await Bun.write("about-me.md", "# Changed on another machine\\n");');

    const stopped = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: ${profilePath(home)}: another machine pushed to your profile before setup could. ${profilePath(home)} and origin both have changes the other lacks. Bring it up to date with git -C ${profilePath(home)} pull --rebase --autostash, or drop setup's commit, then run the same hedge setup command again.`);
    expect(JSON.parse(await spawnGit(profilePath(home), "show", "HEAD:hedge.json")).settings).toEqual({ "orchestration.loopProject": "~/code/app" });
    expect((await pushedAnswers(home)).settings).toEqual({});
    await spawnGit(profilePath(home), "pull", "-q", "--rebase");
    expect((await hedgeSetup(home, devboxArgs, [""], fakeMachine(home))).code).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "orchestration.loopProject": "~/code/app" });
    expect(await spawnGit(home, "--git-dir", githubRepo(home, "nora/hedge-profile"), "show", "main:about-me.md")).toBe("# Changed on another machine");
  });

  test("the advice after a devbox setting's push comes after another machine's works with a staged change to another file, and the same command run again saves the setting", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    await changeOnFirstCommit(home, 'await Bun.write("about-me.md", "# Changed on another machine\\n");');
    writeFileSync(join(profilePath(home), "notes.md"), "# My own notes\n");
    await spawnGit(profilePath(home), "add", "notes.md");

    const stopped = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(stopped.code).toBe(1);
    const advice = /git -C (\S+) (pull --rebase\S*(?: --autostash)?)/.exec(stopped.output);
    expect(advice?.[1]).toBe(profilePath(home));
    await spawnGit(profilePath(home), ...advice![2]!.split(" "), "-q");
    await hedgeSetup(home, devboxArgs, [""], fakeMachine(home));
    expect((await pushedAnswers(home)).settings).toEqual({ "orchestration.loopProject": "~/code/app" });
    expect(await spawnGit(home, "--git-dir", githubRepo(home, "nora/hedge-profile"), "show", "main:about-me.md")).toBe("# Changed on another machine");
    expect(readFileSync(join(profilePath(home), "notes.md"), "utf8")).toBe("# My own notes\n");
    expect((await spawnGit(home, "--git-dir", githubRepo(home, "nora/hedge-profile"), "ls-tree", "--name-only", "main")).split("\n")).not.toContain("notes.md");
  });

  test("stops when another machine changes the same devbox setting before the push, and after setup's commit is dropped the same command run again saves this run's answer", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    await changeOnFirstCommit(home, 'profile.settings = { ...profile.settings, "orchestration.loopProject": value };');

    const stopped = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: ${profilePath(home)}: another machine pushed to your profile before setup could.`);
    expect((await pushedAnswers(home)).settings).toEqual({ "orchestration.loopProject": "after" });
    await spawnGit(profilePath(home), "reset", "-q", "--keep", "@{upstream}");
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
    expect(stopped.output).toContain(`hedge: another machine saved your profile in ${profilePath(home)} while setup ran. Run the same hedge setup command again: it starts from the profile as it is now.`);
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

  test("stops before it saves a devbox setting when another machine removed hedge.json while setup asks it, and writes no new hedge.json", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    const elsewhere = join(temp.make("elsewhere-"), "profile");
    await spawnGit(home, "clone", "-q", githubRepo(home, "nora/hedge-profile"), elsewhere);
    const removeElsewhere = async () => {
      await spawnGit(elsewhere, "rm", "-q", "hedge.json");
      await spawnGit(elsewhere, "commit", "-q", "-m", "Remove hedge.json on another machine");
      await spawnGit(elsewhere, "push", "-q");
    };

    const stopped = await hedgeSetup(home, devboxArgs, [async () => (await removeElsewhere(), "~/code/app")], fakeMachine(home));

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: ${profilePath(home)}: your profile's hedge.json was removed on origin. Restore it there, then run the same hedge setup command again.`);
    expect((await spawnGit(home, "--git-dir", githubRepo(home, "nora/hedge-profile"), "ls-tree", "--name-only", "main")).split("\n")).not.toContain("hedge.json");
    expect(existsSync(join(profilePath(home), "hedge.json"))).toBe(false);
  });

  test("stops before it saves a devbox setting when another machine removed hedge.json while setup asks it, and saves nothing to the fleet.json the profile still has", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    const elsewhere = join(temp.make("elsewhere-"), "profile");
    await spawnGit(home, "clone", "-q", githubRepo(home, "nora/hedge-profile"), elsewhere);
    writeFileSync(join(elsewhere, "fleet.json"), readFileSync(join(elsewhere, "hedge.json")));
    await spawnGit(elsewhere, "add", "fleet.json");
    await spawnGit(elsewhere, "commit", "-q", "-m", "Keep a fleet.json from before the rename");
    await spawnGit(elsewhere, "push", "-q");
    const removeElsewhere = async () => {
      await spawnGit(elsewhere, "rm", "-q", "hedge.json");
      await spawnGit(elsewhere, "commit", "-q", "-m", "Remove hedge.json on another machine");
      await spawnGit(elsewhere, "push", "-q");
    };

    const stopped = await hedgeSetup(home, devboxArgs, [async () => (await removeElsewhere(), "~/code/app")], fakeMachine(home));

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: ${profilePath(home)}: your profile's hedge.json was removed on origin. Restore it there, then run the same hedge setup command again.`);
    expect(JSON.parse(await spawnGit(home, "--git-dir", githubRepo(home, "nora/hedge-profile"), "show", "main:fleet.json")).settings).toEqual({});
    expect(JSON.parse(readFileSync(join(profilePath(home), "fleet.json"), "utf8")).settings).toEqual({});
  });

  test("stops before it saves a devbox setting when another machine adds hedge.json beside the fleet.json setup read while setup asks it, and saves the setting to neither file", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    const elsewhere = join(temp.make("elsewhere-"), "profile");
    await spawnGit(home, "clone", "-q", githubRepo(home, "nora/hedge-profile"), elsewhere);
    await spawnGit(elsewhere, "mv", "hedge.json", "fleet.json");
    await spawnGit(elsewhere, "commit", "-q", "-m", "Keep only a fleet.json from before the rename");
    await spawnGit(elsewhere, "push", "-q");
    const addElsewhere = async () => {
      writeFileSync(join(elsewhere, "hedge.json"), readFileSync(join(elsewhere, "fleet.json")));
      await spawnGit(elsewhere, "add", "hedge.json");
      await spawnGit(elsewhere, "commit", "-q", "-m", "Add hedge.json on another machine");
      await spawnGit(elsewhere, "push", "-q");
    };

    const stopped = await hedgeSetup(home, devboxArgs, [async () => (await addElsewhere(), "~/code/app")], fakeMachine(home));

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: another machine saved your profile in ${profilePath(home)} while setup ran. Run the same hedge setup command again: it starts from the profile as it is now.`);
    const origin = githubRepo(home, "nora/hedge-profile");
    for (const name of ["fleet.json", "hedge.json"]) {
      expect(JSON.parse(await spawnGit(home, "--git-dir", origin, "show", `main:${name}`)).settings).toEqual({});
      expect(JSON.parse(readFileSync(join(profilePath(home), name), "utf8")).settings).toEqual({});
    }
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
