import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, isolateGit, tempDirs } from "../testing/git.ts";
import { boxHome, boxMachineFile, engineRoot, fakeMachine, githubRepo, machineFile, nodeEngine, nodeHas, nodeLauncher, setUpToAdd } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const node = "coder.hedge-node-1";
const guarded = ["--add", "guards", "--workflows", "git-allowlist=on,oom-survival=on"];
const thisCommit = Bun.spawnSync(["git", "-C", engineRoot, "rev-parse", "HEAD"]).stdout.toString().trim();

async function signedUp(setupArgs: string[] = []) {
  const home = temp.make("home-");
  return { home, ...(await setUpToAdd(home, node, setupArgs)) };
}

const lastLine = (output: string) => output.split("\n").at(-1);
const profileApplied = (home: string) => boxMachineFile(home, node).profileDir === join(boxHome(home, node), ".local/share/hedge/profile");
const profileStepDone = (home: string) => (machineFile(home).setup?.done ?? []).includes(`devbox:${node}:profile`);
const onNodeShell = (home: string, command: string) => Bun.spawnSync(["sh", "-c", command], { env: { HOME: boxHome(home, node), PATH: `${join(boxHome(home, node), ".node/bin")}:/usr/bin:/bin`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "ignore", stderr: "ignore" }).exitCode;

const personDidSteps = (home: string) => ["allowlist", "earlyoom"].forEach((state) => writeFileSync(join(boxHome(home, node), ".node", state), ""));
const enginePath = (home: string, path: string) => join(boxHome(home, node), ".local/share/hedge/engine", path);

describe("hedge devbox add applies the profile on the node", () => {
  test("runs none of the steps left for the person, though sudo there asks no password, and keeps the profile step open", async () => {
    const { home, io, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(1);
    expect([nodeHas(home, node, "allowlist"), nodeHas(home, node, "earlyoom")]).toEqual([false, false]);
    expect(io.output()).not.toContain("  $ ");
    expect(profileStepDone(home)).toBe(false);
  });

  test("keeps the profile step open and lists the steps left last, as commands that run over plain SSH", async () => {
    const { home, io, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(1);
    expect(profileStepDone(home)).toBe(false);
    const left = io.output().slice(io.output().lastIndexOf("hedge: "));
    expect(left).toStartWith(`hedge: Your profile applied on ${node}, but steps are left for you there. Do each one, then run hedge devbox add ${node} again. Left for you:`);
    expect(lastLine(io.output())).toStartWith("  · Install earlyoom as root");
    const printed = left.split("\n").slice(1).map((line) => line.match(/ Run: ssh -t \S+ '(.*)'$/)?.[1]?.replaceAll(`'\\''`, "'") ?? "");
    expect(printed).toHaveLength(2);

    expect(printed.map((command) => onNodeShell(home, command))).toEqual([0, 0]);
    expect([nodeHas(home, node, "allowlist"), nodeHas(home, node, "earlyoom")]).toEqual([true, true]);
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(0);
    expect(profileStepDone(home)).toBe(true);
  });

  test("finishes the profile step, and points to hedge doctor on the node, when the node runs an older Hedge without --to-do", async () => {
    const { home, io, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: { olderEngine: true } }))).toBe(0);
    expect(io.output()).toContain(`  · ${node} runs an older Hedge, which cannot list the steps left for you. Run hedge doctor on ${node} to see them.`);
    expect(profileApplied(home)).toBe(true);
    expect(profileStepDone(home)).toBe(true);
  });

  test("takes the steps left from the node's own profile, not from this machine's", async () => {
    const { home, add } = await signedUp(guarded);
    const clone = join(boxHome(home, node), ".local/share/hedge/profile");
    git(home, "clone", "-q", githubRepo(home, "nora/hedge-profile"), clone);
    const answers = JSON.parse(readFileSync(join(clone, "hedge.json"), "utf8"));
    writeFileSync(join(clone, "hedge.json"), JSON.stringify({ ...answers, packs: answers.packs.filter((pack: string) => pack !== "guards") }, null, 2) + "\n");
    git(clone, "commit", "-q", "-am", "The node's profile, before guards");
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(0);
    expect([nodeHas(home, node, "allowlist"), nodeHas(home, node, "earlyoom")]).toEqual([false, false]);
    expect(profileStepDone(home)).toBe(true);
  });

  test("keeps the installed engine and its packages when the engine sits at this machine's commit, and applies the profile with it", async () => {
    const { home, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(1);
    writeFileSync(enginePath(home, "node_modules/kept"), "");
    personDidSteps(home);
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(0);
    expect(existsSync(enginePath(home, "node_modules/kept"))).toBe(true);
    expect(nodeEngine(home, node)).toEqual({ commit: thisCommit, launcher: nodeLauncher, runs: true });
    expect(profileApplied(home)).toBe(true);
  });

  test("leaves the engine at the commit get.sh installs, with a launcher that runs, when that is another commit", async () => {
    const { home, add } = await signedUp();
    expect(await add(fakeMachine(home, {}, { node: { installs: "0".repeat(40) } }))).toBe(0);
    expect(nodeEngine(home, node)).toEqual({ commit: "0".repeat(40), launcher: nodeLauncher, runs: true });
    expect(profileApplied(home)).toBe(true);
  });

  test("finishes on the next run an install that stopped before the engine's packages", async () => {
    const { home, add } = await signedUp();
    expect(await add(fakeMachine(home, {}, { node: { installFails: true } }))).toBe(1);
    expect(nodeEngine(home, node)).toMatchObject({ commit: thisCommit, runs: false });
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(0);
    expect(nodeEngine(home, node).runs).toBe(true);
    expect(profileApplied(home)).toBe(true);
  });

  test("installs again with get.sh when the engine sits at this machine's commit but its launcher does not run", async () => {
    const { home, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(1);
    writeFileSync(join(boxHome(home, node), ".node/packages-missing"), "");
    personDidSteps(home);
    expect(nodeEngine(home, node)).toMatchObject({ commit: thisCommit, runs: false });
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(0);
    expect(nodeEngine(home, node)).toEqual({ commit: thisCommit, launcher: nodeLauncher, runs: true });
    expect(profileApplied(home)).toBe(true);
    expect(profileStepDone(home)).toBe(true);
  });
});
