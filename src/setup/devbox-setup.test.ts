import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { fakeMachine, hedgeSetup, githubRepo, pushedAnswers } from "./testing.ts";

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
    expect(blocked.output).toContain("could not push answers: ! [remote rejected] main -> main (pre-receive hook declined). Fix that, then try again.");
    expect(blocked.output).not.toContain("▶ Install Hedge on node-1");

    rmSync(rejecting);
    expect((await hedgeSetup(home, ["--non-interactive", ...args], [], fakeMachine(home))).code).toBe(0);
    expect((await pushedAnswers(home)).settings["orchestration.loopProject"]).toBe("~/code/app");
  });

  test("a devbox setting saved while another machine changes a setting keeps that machine's value", async () => {
    const args = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on", "--devbox", "node-1"];
    const home = temp.make("home-");
    expect((await hedgeSetup(home, args, ["", ""], fakeMachine(home))).code).toBe(130);
    const elsewhere = join(temp.make("elsewhere-"), "profile");
    await spawnGit(home, "clone", "-q", githubRepo(home, "nora/hedge-profile"), elsewhere);
    const publish = join(elsewhere, "..", "publish.ts");
    writeFileSync(publish, `const [file, value] = process.argv.slice(2);\nconst profile = await Bun.file(file).json();\nprofile.settings = { ...profile.settings, "elsewhere.setting": value };\nawait Bun.write(file, JSON.stringify(profile, null, 2) + "\\n");\n`);
    const setElsewhere = `'${process.execPath}' '${publish}' hedge.json`;
    expect(Bun.spawnSync(["sh", "-c", `cd '${elsewhere}' && ${setElsewhere} before && git commit -q -am 'Set a setting on another machine' && git push -q`], { env: gitEnv }).exitCode).toBe(0);
    const marker = join(elsewhere, "..", "published");
    const hook = `#!/bin/sh\n[ -e '${marker}' ] && exit 0\ntouch '${marker}'\nunset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX\ncd '${elsewhere}' && git pull -q && ${setElsewhere} after && git commit -q -am 'Change that setting on another machine' && git push -q\n`;
    writeFileSync(join(profilePath(home), ".git/hooks/post-commit"), hook, { mode: 0o755 });

    const resumed = await hedgeSetup(home, args, ["~/code/app"], fakeMachine(home));

    expect(resumed.code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "elsewhere.setting": "after", "orchestration.loopProject": "~/code/app" });
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
