import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { coderToken, fakeMachine, machineFile, setUpToAdd } from "./testing.ts";

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

describe("hedge devbox add signs the workspace in to Coder", () => {
  test("at the workspace's own agent address when it answers there over HTTPS and not at this machine's Coder address", async () => {
    const { home, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "https://coder-eu.example.com", boxAgentUrl: "https://coder-eu.example.com/" });
    expect(await add(box)).toBe(0);
    expect(box.coderSsh).toEqual(["https://coder-eu.example.com"]);
  });

  test("but makes no token and sends none when the workspace answers only at a plain HTTP agent address, and names the sign-in left for the person", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "http://coder.internal" });
    expect(await add(box)).toBe(1);
    expect(box.coderTokens()).toEqual([]);
    expect(tokenSent(box)).toBe(false);
    expect(io.output()).toContain(`${node} reaches Coder only at its agent address, http://coder.internal, which is plain HTTP, so Hedge sends no token there. Sign ${node} in yourself: run ssh -t ${node} 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; coder login http://coder.internal', and paste a token from https://coder.example.com/cli-auth.`);
  });

  test("and passes over an address that answers with a sign-in redirect instead of Coder", async () => {
    const { home, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderRedirectsAt: "https://coder.example.com", boxReachesCoderAt: "https://coder-eu.example.com", boxAgentUrl: "https://coder-eu.example.com" });
    expect(await add(box)).toBe(0);
    expect(box.coderSsh).toEqual(["https://coder-eu.example.com"]);
  });

  test("and removes the token it made when the sign-in there fails", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderLoginFails: true });
    expect(await add(box)).toBe(1);
    expect(io.output()).toContain(`Coder did not sign in on ${node}: invalid token`);
    expect(box.coderTokens()).toEqual([]);
  });

  test("and names the token and the command that removes it when its removal fails too", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderLoginFails: true, coderTokenRemoveFails: true });
    expect(await add(box)).toBe(1);
    const [name] = box.coderTokens();
    expect(io.output()).toContain(`Hedge could not remove the token it made, ${name}. Remove it with coder tokens remove ${name}.`);
  });

  test("and makes no token when the workspace reaches Coder at no address", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "https://elsewhere.example" });
    expect(await add(box)).toBe(1);
    expect(io.output()).toContain(`${node} reaches Coder neither at https://coder.example.com nor at its own agent address, http://coder.internal.`);
    expect(box.coderTokens()).toEqual([]);
  });
});

describe("hedge devbox add links the node from the hub", () => {
  const listed = (status: string) => [{ environmentId: `env-${node}`, label: "hedge-node-1", status }];

  test("says the hub reaches the node, and links nothing anew, when T3 Code on the hub reaches it", async () => {
    const { home, io, add } = await signedUp();
    await nameHub(home, "coder.hedge-hub");
    const box = fakeMachine(home, {}, { hubLinks: listed("reachable") });
    expect(await add(box)).toBe(0);
    expect(lastLine(io.output())).toBe(`✓ The hub, coder.hedge-hub, reaches ${node} in T3 Code.`);
    expect(box.hubLinked).toEqual([]);
  });

  test("links the node again when T3 Code on the hub lists its link as expired", async () => {
    const { home, io, add } = await signedUp();
    await nameHub(home, "coder.hedge-hub");
    const box = fakeMachine(home, {}, { hubLinks: listed("expired") });
    expect(await add(box)).toBe(0);
    expect(box.hubLinked).toEqual([node]);
    expect(lastLine(io.output())).toBe(`✓ The hub, coder.hedge-hub, linked ${node} in T3 Code.`);
  });

  test("names the link's state and a repair that runs over plain SSH when the hub cannot link an unreachable node", async () => {
    const { home, io, add } = await signedUp();
    await nameHub(home, "coder.hedge-hub");
    const box = fakeMachine(home, {}, { hubLinks: listed("unreachable"), hubUpdateFails: "hedge update: the release channel needs a version tag as the engine ref." });
    expect(await add(box)).toBe(0);
    expect(lastLine(io.output())).toBe(`· The hub, coder.hedge-hub, lists ${node} in T3 Code as unreachable. Its daily hedge peers renew links it, or run ssh coder.hedge-hub 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; hedge peers link ${node}' now.`);
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
