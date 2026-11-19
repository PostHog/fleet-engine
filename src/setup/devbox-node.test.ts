import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { overSsh } from "./devbox.ts";
import { boxHome, coderToken, fakeMachine, machineFile, setUpToAdd } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const node = "coder.hedge-node-1";

async function signedUp(setupArgs: string[] = []) {
  const home = temp.make("home-");
  return { home, ...(await setUpToAdd(home, node, setupArgs)) };
}

async function nameHub(home: string, hub: string) {
  const profile = profilePath(home);
  const answers = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...answers, hub }, null, 2) + "\n");
  await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
  await spawnGit(profile, "push", "-q");
}

const lastLine = (output: string) => output.split("\n").at(-1);
const tokenSent = (box: ReturnType<typeof fakeMachine>) => box.calls.some((call) => call.input?.includes(coderToken));
const coderFile = (home: string, name: string) => join(boxHome(home, node), ".config/coderv2", name);
const notReached = (address: string) => `${node} does not reach Coder at ${address} over HTTPS, so Hedge makes no Coder token for it and sends none. Sign ${node} in to Coder yourself: install the Coder CLI there from your Coder deployment, run coder login there with an HTTPS address it reaches, and paste a token from ${address}/cli-auth. Then run hedge devbox add ${node} again.`;

describe("hedge devbox add signs the workspace in to Coder", () => {
  test("at this machine's Coder address, with the session file its Coder CLI reads, which only its owner can read", async () => {
    const { home, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 });
    expect(await add(box)).toBe(0);
    expect(box.coderSsh).toEqual(["https://coder.example.com"]);
    expect(statSync(coderFile(home, "session")).mode & 0o777).toBe(0o600);
    expect(box.calls.flatMap((call) => call.command).join(" ")).not.toContain(coderToken);
  });

  test("installs the Coder CLI there from this machine's Coder address over HTTPS", async () => {
    const { home, add } = await signedUp();
    expect(await add(fakeMachine(home, { "box:coder": 1 }))).toBe(0);
    expect(statSync(join(boxHome(home, node), ".local/bin/coder")).mode & 0o111).toBe(0o111);
  });

  test("but makes no token, sends none and installs nothing when the workspace does not reach that address, and leaves the sign-in to the person", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "https://coder-eu.example.com" });
    expect(await add(box)).toBe(1);
    expect(box.coderTokens()).toEqual([]);
    expect(tokenSent(box)).toBe(false);
    expect(existsSync(join(boxHome(home, node), ".local/bin/coder"))).toBe(false);
    expect(lastLine(io.output())).toBe(`hedge: ${notReached("https://coder.example.com")}`);
  });

  test("and makes no token and installs nothing when this machine's Coder address is plain HTTP, though the workspace reaches it", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderAt: "http://coder.example.com" });
    expect(await add(box)).toBe(1);
    expect(box.coderTokens()).toEqual([]);
    expect(tokenSent(box)).toBe(false);
    expect(existsSync(join(boxHome(home, node), ".local/bin/coder"))).toBe(false);
    expect(lastLine(io.output())).toBe(`hedge: ${notReached("http://coder.example.com")}`);
  });

  test("and removes the token it made when the workspace's Coder CLI does not sign in with it", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderRejectsToken: true });
    expect(await add(box)).toBe(1);
    expect(lastLine(io.output())).toBe(`hedge: Coder did not sign in on ${node} with the token Hedge wrote there.`);
    expect(box.coderTokens()).toEqual([]);
    expect(box.coderSsh).toEqual([]);
  });

  test("and names the token and the command that removes it when its removal fails too", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderRejectsToken: true, coderTokenRemoveFails: true });
    expect(await add(box)).toBe(1);
    const [name] = box.coderTokens();
    expect(io.output()).toContain(`Hedge could not remove the token it made, ${name}. Remove it with coder tokens remove ${name}.`);
  });
});

describe("hedge devbox add links the node from the hub", () => {
  const listed = (status: string) => [{ environmentId: `env-${node}`, label: "hedge-node-1", status, expiresAt: "2026-12-01T00:00:00.000Z" }];
  const hubLists = async (box: ReturnType<typeof fakeMachine>) => (await overSsh(box.machine, "coder.hedge-hub").exec(["t3", "environment", "list", "--json"])).stdout;

  test("says the hub reaches the node, and keeps its link as it is, when T3 Code on the hub reaches it", async () => {
    const { home, io, add } = await signedUp();
    await nameHub(home, "coder.hedge-hub");
    const box = fakeMachine(home, {}, { hubLinks: listed("reachable") });
    const before = await hubLists(box);
    expect(await add(box)).toBe(0);
    expect(lastLine(io.output())).toBe(`✓ The hub, coder.hedge-hub, reaches ${node} in T3 Code.`);
    expect(await hubLists(box)).toEqual(before);
  });

  test("links the node again when T3 Code on the hub lists its link as expired, so the hub lists it as reachable", async () => {
    const { home, io, add } = await signedUp();
    await nameHub(home, "coder.hedge-hub");
    const box = fakeMachine(home, {}, { hubLinks: listed("expired") });
    expect(await add(box)).toBe(0);
    expect(lastLine(io.output())).toBe(`✓ The hub, coder.hedge-hub, linked ${node} in T3 Code.`);
    expect(JSON.parse(await hubLists(box))).toEqual([expect.objectContaining({ environmentId: `env-${node}`, status: "reachable" })]);
  });

  test("names the link's state and a repair that runs over plain SSH when the hub cannot link an unreachable node", async () => {
    const { home, io, add } = await signedUp();
    await nameHub(home, "coder.hedge-hub");
    const box = fakeMachine(home, {}, { hubLinks: listed("unreachable"), hubUpdateFails: "hedge update: the release channel needs a version tag as the engine ref." });
    expect(await add(box)).toBe(0);
    expect(lastLine(io.output())).toBe(`· The hub, coder.hedge-hub, lists ${node} in T3 Code as unreachable. To link it, run ssh coder.hedge-hub 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; hedge peers link ${node}' now.`);
  });

  test("run on the hub, reads T3 Code here, and says the hub reaches the node when the hub's own update fails", async () => {
    const { home, io, add } = await signedUp();
    await nameHub(home, "coder.hedge-hub");
    const saved = machineFile(home);
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ ...saved, name: "coder.hedge-hub" }));
    const box = fakeMachine(home, {}, { hereLinks: listed("reachable"), hubUpdateFails: "hedge update: the release channel needs a version tag as the engine ref." });
    expect(await add(box)).toBe(0);
    expect(lastLine(io.output())).toBe(`✓ The hub, coder.hedge-hub, reaches ${node} in T3 Code.`);
  });
});
