import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { boxHome, engineRoot, fakeMachine, hedgeSetup, machineFile, nodeHas, nodeLog, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const node = "coder.hedge-node-1";
const guarded = ["--add", "guards", "--workflows", "git-allowlist=on,oom-survival=on"];

async function signedUp(setupArgs: string[] = []) {
  const home = temp.make("home-");
  expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude", ...setupArgs], ["", ""])).code).toBe(0);
  const io = scripted([]);
  const add = (box: ReturnType<typeof fakeMachine>) => main(["devbox", "add", node], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
  return { home, io, add };
}

async function nameHub(home: string, hub: string) {
  const profile = profilePath(home);
  const answers = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...answers, hub }, null, 2) + "\n");
  await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
  await spawnGit(profile, "push", "-q");
}

const lastLine = (output: string) => output.split("\n").at(-1);

describe("hedge devbox add signs the workspace in to Coder", () => {
  test("at the workspace's own agent address when it cannot reach this machine's Coder address", async () => {
    const { home, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "http://coder.internal" });
    expect(await add(box)).toBe(0);
    expect(box.coderSsh).toEqual(["http://coder.internal"]);
  });

  test("and removes the token it made when the sign-in there fails", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderLoginFails: true });
    expect(await add(box)).toBe(1);
    expect(io.output()).toContain(`Coder did not sign in on ${node}: invalid token`);
    expect(box.coderTokens()).toEqual([]);
  });

  test("and makes no token when the workspace reaches Coder at no address", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "https://elsewhere.example" });
    expect(await add(box)).toBe(1);
    expect(io.output()).toContain(`${node} reaches Coder neither at https://coder.example.com nor at its own agent address`);
    expect(box.coderTokens()).toEqual([]);
  });
});

describe("hedge devbox add applies the profile on the node", () => {
  test("runs the node's root steps itself when sudo there asks no password", async () => {
    const { home, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: { rootSteps: ["allowlist", "earlyoom"] } }))).toBe(0);
    expect([nodeHas(home, node, "allowlist"), nodeHas(home, node, "earlyoom")]).toEqual([true, true]);
  });

  test("lists the steps left for the person once, at the end, when sudo there asks a password", async () => {
    const { home, io, add } = await signedUp(guarded);
    expect(await add(fakeMachine(home, {}, { node: { password: true, rootSteps: ["allowlist", "earlyoom"] } }))).toBe(1);
    const left = io.output().slice(io.output().lastIndexOf("hedge: "));
    expect(left).toContain(`Do what is left for you on ${node}, and fix what it says above, then run hedge devbox add ${node} again. Left for you:`);
    expect(left).toContain(`  · Install the signed Git allowlist as root.`);
    expect(left).toContain(`Run: ssh -t ${node} 'hedge guards allowlist stage ~/.local/state/hedge/git-allowlist && sudo sh ~/.local/state/hedge/git-allowlist/install.sh'`);
    expect(lastLine(io.output())).toStartWith("  · Install earlyoom as root");
    expect(lastLine(io.output())).toEndWith(`Run: ssh -t ${node} 'sudo sh ~/.local/share/hedge/guards/earlyoom.sh'`);
  });

  test("keeps the node's engine when it runs this machine's engine commit, and applies the profile with it", async () => {
    const { home, add } = await signedUp();
    const commit = Bun.spawnSync(["git", "-C", engineRoot, "rev-parse", "HEAD"]).stdout.toString().trim();
    expect(await add(fakeMachine(home, {}, { node: { engineAt: commit } }))).toBe(0);
    expect(nodeLog(home, node)).toEqual([`hedge apply --profile ${join(boxHome(home, node), ".local/share/hedge/profile")}`]);
  });

  test("installs the engine again with get.sh when the node runs another engine commit", async () => {
    const { home, add } = await signedUp();
    expect(await add(fakeMachine(home, {}, { node: { engineAt: "0".repeat(40) } }))).toBe(0);
    expect(nodeLog(home, node)[0]).toStartWith("get.sh --ref main --profile ");
  });
});

describe("hedge devbox add links the node from the hub", () => {
  const listed = [{ environmentId: `env-${node}`, label: "hedge-node-1" }];

  test("says the hub reaches the node, without hedge peers link, when T3 Code on the hub lists it", async () => {
    const { home, io, add } = await signedUp();
    await nameHub(home, "coder.hedge-hub");
    const box = fakeMachine(home, {}, { hubLinks: listed });
    expect(await add(box)).toBe(0);
    expect(lastLine(io.output())).toBe(`✓ The hub, coder.hedge-hub, reaches ${node} in T3 Code.`);
    expect(box.hubLinked).toEqual([]);
  });

  test("run on the hub, reads T3 Code here, and says the hub reaches the node when the hub's own update fails", async () => {
    const { home, io, add } = await signedUp();
    await nameHub(home, "coder.hedge-hub");
    const saved = machineFile(home);
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ ...saved, name: "coder.hedge-hub" }));
    const box = fakeMachine(home, {}, { hereLinks: listed, hubUpdateFails: "hedge update: the release channel needs a version tag as the engine ref." });
    expect(await add(box)).toBe(0);
    expect(lastLine(io.output())).toBe(`✓ The hub, coder.hedge-hub, reaches ${node} in T3 Code.`);
  });
});
