import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, isolateGit, tempDirs } from "../testing/git.ts";
import { boxHome, boxMachineFile, engineRoot, fakeMachine, githubRepo, nodeEngine, nodeHas, setUpToAdd, throughSsh } from "./testing.ts";

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

const profileApplied = (home: string) => boxMachineFile(home, node).profileDir === join(boxHome(home, node), ".local/share/hedge/profile");
const linkedHere = ["https://box-1.relay.example"];
const listed = (output: string, say: string) => output.split("\n").filter((line) => line.startsWith(`  · ${say}`)).length;
const endList = (output: string) => output.slice(output.lastIndexOf(`Left for you on ${node}:`));
const notTheProfile = { node: { stepsFail: true } };
const enginePath = (home: string, path: string) => join(boxHome(home, node), ".local/share/hedge/engine", path);

describe("hedge devbox add applies the profile on the node", () => {
  test("runs none of the steps left for the person, though sudo there asks no password", async () => {
    const { home, io, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(0);
    expect([nodeHas(home, node, "allowlist"), nodeHas(home, node, "earlyoom")]).toEqual([false, false]);
    expect(io.output()).not.toContain("  $ ");
  });

  test("goes on to the link step when only steps for the person are left, and lists each one once at the end, as a command that runs over plain SSH", async () => {
    const { home, io, add } = await signedUp(guarded);
    const box = fakeMachine(home, {}, { node: {} });
    expect(await add(box)).toBe(0);
    expect(box.peerLinks.here).toEqual(linkedHere);
    const output = io.output();
    expect(output).toContain(`  · 2 steps are left for you on ${node}. Hedge lists them at the end and runs none of them.`);
    expect(output.indexOf(`  ✓ Link T3 Code here and on ${node}: done`)).toBeLessThan(output.lastIndexOf(`Left for you on ${node}:`));
    const left = endList(output).split("\n");
    expect([left[0], left.at(-1)]).toEqual([`Left for you on ${node}:`, `Do each one, then run hedge apply on ${node}.`]);
    expect(left).toHaveLength(4);
    expect([listed(output, "Install the signed Git allowlist as root"), listed(output, "Install earlyoom as root")]).toEqual([1, 1]);
    const printed = left.slice(1, -1).map((line) => line.slice(line.indexOf(" Run: ") + " Run: ".length));
    expect(printed.map((command) => throughSsh(home, node, command))).toEqual([0, 0]);
    expect([nodeHas(home, node, "allowlist"), nodeHas(home, node, "earlyoom")]).toEqual([true, true]);
  });

  test("still lists the steps left for the person when a later step fails", async () => {
    const { home, io, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: {}, serverWithoutLinkState: ["box"] }))).toBe(1);
    const output = io.output();
    expect(output).toContain(`hedge: ${node} has no T3 Connect address yet.`);
    const left = endList(output).split("\n");
    expect(left.slice(0, 4).filter((line) => line.startsWith("  · Install "))).toHaveLength(2);
    expect(left[3]).toBe(`Do each one, then run hedge apply on ${node}.`);
  });

  test("stops at the profile step, links nothing, when the apply fails for another reason, and a rerun after the fix applies the profile and links the node", async () => {
    const { home, io, add } = await signedUp(guarded);
    const failed = fakeMachine(home, {}, notTheProfile);
    expect(await add(failed)).toBe(1);
    expect(failed.peerLinks).toEqual({ box: [], here: [] });
    expect(io.output()).not.toContain(`Left for you on ${node}:`);
    expect(io.output().slice(io.output().lastIndexOf("hedge: "))).toStartWith(`hedge: The devbox could not apply your profile.`);
    const fixed = fakeMachine(home, {}, { node: { allowlist: true } });
    expect(await add(fixed)).toBe(0);
    expect(profileApplied(home)).toBe(true);
    expect(fixed.peerLinks.here).toEqual(linkedHere);
  });

  test("stops at the profile step, and names what else the node finds, when a check that is no step for the person fails beside one that is", async () => {
    const { home, io, add } = await signedUp(guarded);
    const box = fakeMachine(home, {}, { node: { allowlist: true, oldSystemd: true } });
    expect(await add(box)).toBe(1);
    expect(box.peerLinks).toEqual({ box: [], here: [] });
    const failure = io.output().slice(io.output().lastIndexOf("hedge: ")).split("\n");
    expect(failure[0]).toBe(`hedge: Your profile applied on ${node}, but hedge doctor there finds more than steps for you. Fix what it says, then run hedge devbox add ${node} again.`);
    expect(failure.filter((line) => line.includes("systemd older than 253"))).toHaveLength(1);
    expect(failure.filter((line) => line.startsWith("  · Install earlyoom as root"))).toHaveLength(1);
    expect(io.output()).not.toContain(`Left for you on ${node}:`);
  });

  test("names what hedge doctor on the node finds when the apply fails, though the apply printed none of it", async () => {
    const { home, io, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: { stepsFail: true } }))).toBe(1);
    const failure = io.output().slice(io.output().lastIndexOf("hedge: ")).split("\n");
    expect(failure[0]).toStartWith("hedge: The devbox could not apply your profile.");
    expect(failure.filter((line) => line.includes("systemd older than 253"))).toHaveLength(1);
  });

  test("finishes the profile step, and points to hedge doctor on the node, when the node runs an older Hedge without --to-do", async () => {
    const { home, io, add } = await signedUp(guarded);
    const box = fakeMachine(home, {}, { node: { olderEngine: true } });
    expect(await add(box)).toBe(0);
    expect(io.output()).toContain(`  · ${node} runs an older Hedge, which cannot list the steps left for you. Run hedge doctor on ${node} to see them.`);
    expect(io.output()).not.toContain(`Left for you on ${node}:`);
    expect(profileApplied(home)).toBe(true);
    expect(box.peerLinks.here).toEqual(linkedHere);
  });

  test("takes the steps left from the node's own profile, not from this machine's", async () => {
    const { home, io, add } = await signedUp(guarded);
    const clone = join(boxHome(home, node), ".local/share/hedge/profile");
    git(home, "clone", "-q", githubRepo(home, "nora/hedge-profile"), clone);
    const answers = JSON.parse(readFileSync(join(clone, "hedge.json"), "utf8"));
    writeFileSync(join(clone, "hedge.json"), JSON.stringify({ ...answers, packs: answers.packs.filter((pack: string) => pack !== "guards") }, null, 2) + "\n");
    git(clone, "commit", "-q", "-am", "The node's profile, before guards");
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(0);
    expect([nodeHas(home, node, "allowlist"), nodeHas(home, node, "earlyoom")]).toEqual([false, false]);
    expect(io.output()).not.toContain(`Left for you on ${node}:`);
  });

  test("keeps the installed engine and its packages when the engine sits at this machine's commit, and applies the profile with it", async () => {
    const { home, add } = await signedUp();
    expect(await add(fakeMachine(home, {}, notTheProfile))).toBe(1);
    writeFileSync(enginePath(home, "node_modules/kept"), "");
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(0);
    expect(existsSync(enginePath(home, "node_modules/kept"))).toBe(true);
    expect(nodeEngine(home, node)).toMatchObject({ commit: thisCommit, runs: true });
    expect(profileApplied(home)).toBe(true);
  });

  test("installs again with get.sh when the engine has moved to another commit since the install step", async () => {
    const { home, add } = await signedUp();
    expect(await add(fakeMachine(home, {}, notTheProfile))).toBe(1);
    expect(await add(fakeMachine(home, {}, { node: { engineAt: "1".repeat(40) } }))).toBe(0);
    expect(nodeEngine(home, node)).toMatchObject({ commit: thisCommit, runs: true });
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
    const { home, add } = await signedUp();
    expect(await add(fakeMachine(home, {}, notTheProfile))).toBe(1);
    writeFileSync(join(boxHome(home, node), ".node/packages-missing"), "");
    expect(nodeEngine(home, node)).toMatchObject({ commit: thisCommit, runs: false });
    expect(await add(fakeMachine(home, {}, { node: {} }))).toBe(0);
    expect(nodeEngine(home, node)).toMatchObject({ commit: thisCommit, runs: true });
    expect(profileApplied(home)).toBe(true);
  });
});
