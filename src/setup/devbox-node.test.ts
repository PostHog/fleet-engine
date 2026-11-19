import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { overSsh, t3Links } from "./devbox.ts";
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
const signInHint = (output: string) => output.match(/ run ssh -t \S+ '(.*)', and paste a token/)?.[1]?.replaceAll(`'\\''`, "'");
const runOnNode = (home: string, command: string) => {
  Bun.spawnSync(["sh", "-c", command], { env: { HOME: boxHome(home, node), PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore" });
  return readFileSync(join(boxHome(home, node), ".coder-ran"), "utf8").split("\n").filter(Boolean);
};

describe("hedge devbox add signs the workspace in to Coder", () => {
  test("at the workspace's own agent address when it answers there over HTTPS and not at this machine's Coder address", async () => {
    const { home, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "https://coder-eu.example.com", boxAgentUrl: "https://coder-eu.example.com/" });
    expect(await add(box)).toBe(0);
    expect(box.coderSsh).toEqual(["https://coder-eu.example.com"]);
  });

  test("but makes no token and sends none when the workspace answers only at a plain HTTP agent address, and names the sign-in left for the person, with the Coder CLI it installed there", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "http://coder.internal" });
    expect(await add(box)).toBe(1);
    expect(box.coderTokens()).toEqual([]);
    expect(tokenSent(box)).toBe(false);
    expect(io.output()).toContain(`${node} reaches Coder only at its agent address, http://coder.internal, which is plain HTTP, so Hedge sends no token there. Sign ${node} in yourself: run ssh -t ${node} 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; coder login http://coder.internal', and paste a token from https://coder.example.com/cli-auth.`);
    expect(runOnNode(home, signInHint(io.output())!)).toEqual(["login", "http://coder.internal"]);
  });

  test("and quotes the agent address in that sign-in as one literal argument when it holds shell syntax", async () => {
    const { home, io, add } = await signedUp();
    const agent = "http://coder.internal;$(id)";
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: agent, boxAgentUrl: agent });
    expect(await add(box)).toBe(1);
    expect(tokenSent(box)).toBe(false);
    expect(runOnNode(home, signInHint(io.output())!)).toEqual(["login", agent]);
  });

  test("and refuses an agent address with a path, a query or a user, and names no sign-in", async () => {
    const { home, io, add } = await signedUp();
    for (const agent of ["http://coder.internal/;$(touch pwned) x", "http://nora:secret@coder.internal", "http://coder.internal/?next=x", "http://coder.internal/#x", "ftp://coder.internal", "coder.internal"]) {
      const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "http://coder.internal", boxAgentUrl: agent });
      expect(await add(box)).toBe(1);
      expect(box.coderTokens()).toEqual([]);
      expect(lastLine(io.output())).toBe(`hedge: ${node} names an agent address that is not a plain http or https address without a user, path or query, so Hedge does not use it. Check CODER_AGENT_URL on ${node}, then run hedge devbox add ${node} again.`);
    }
  });

  test("and makes no token and sends none when the agent address answers over HTTPS as another Coder deployment", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: "https://coder-eu.example.com", boxAgentUrl: "https://coder-eu.example.com/", otherDeploymentAt: "https://coder-eu.example.com" });
    expect(await add(box)).toBe(1);
    expect(box.coderTokens()).toEqual([]);
    expect(tokenSent(box)).toBe(false);
    expect(io.output()).toContain(`${node}'s agent address, https://coder-eu.example.com, answers as another Coder deployment than https://coder.example.com, so Hedge sends no token there.`);
  });

  test("and passes over an address that answers with a sign-in redirect instead of Coder", async () => {
    const { home, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderRedirectsAt: "https://coder.example.com", boxReachesCoderAt: "https://coder-eu.example.com", boxAgentUrl: "https://coder-eu.example.com" });
    expect(await add(box)).toBe(0);
    expect(box.coderSsh).toEqual(["https://coder-eu.example.com"]);
  });

  test("and passes over a sign-in redirect though the node's curl config says to follow redirects", async () => {
    const { home, add } = await signedUp();
    mkdirSync(boxHome(home, node), { recursive: true });
    writeFileSync(join(boxHome(home, node), ".curlrc"), "location\n");
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
  const listed = (status: string) => [{ environmentId: `env-${node}`, label: "hedge-node-1", status, expiresAt: "2026-12-01T00:00:00.000Z" }];
  const hubLists = (box: ReturnType<typeof fakeMachine>) => t3Links(overSsh(box.machine, "coder.hedge-hub"));

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
    expect((await hubLists(box)).map(({ environmentId, status }) => ({ environmentId, status }))).toEqual([{ environmentId: `env-${node}`, status: "reachable" }]);
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
