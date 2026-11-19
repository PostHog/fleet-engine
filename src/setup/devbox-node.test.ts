import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { overSsh, signInLimitMs } from "./devbox.ts";
import { boxHome, coderToken, fakeMachine, machineFile, personCoderToken, setUpToAdd, throughSsh } from "./testing.ts";

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
const coderFiles = (home: string) => Object.fromEntries(["url", "session"].filter((name) => existsSync(coderFile(home, name))).map((name) => [name, readFileSync(coderFile(home, name), "utf8")]));
const signInOnBox = (home: string, files: Record<string, string>) => {
  mkdirSync(join(boxHome(home, node), ".config/coderv2"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(coderFile(home, name), text);
};
const followsRedirects = (home: string) => {
  mkdirSync(boxHome(home, node), { recursive: true });
  writeFileSync(join(boxHome(home, node), ".curlrc"), "location\n");
};
const cliOnBox = (home: string) => existsSync(join(boxHome(home, node), ".local/bin/coder"));
const leftStep = (output: string) => output.split("\n").find((line) => line.startsWith(`  · Coder on ${node} is signed in another way, so Hedge left that sign-in alone.`)) ?? "";
const sshConfig = (home: string) => readFileSync(join(boxHome(home, node), ".ssh/config"), "utf8");
const ownSshConfig = "Host own-host\n  HostName 192.0.2.10\n";
const keepsOwnSsh = (home: string) => {
  mkdirSync(join(boxHome(home, node), ".ssh"), { recursive: true });
  writeFileSync(join(boxHome(home, node), ".ssh/config"), ownSshConfig);
};
const notReached = (address: string) => `${node} does not reach Coder at ${address} over HTTPS, so Hedge makes no Coder token for it and sends none. Sign ${node} in to Coder yourself: install the Coder CLI there from your Coder deployment, run coder login there with an HTTPS address it reaches, and paste a token from ${address}/cli-auth. Then run hedge devbox add ${node} again.`;

describe("hedge devbox add signs the workspace in to Coder", () => {
  test("at this machine's Coder address with its own coder login, which keeps the token out of every argv and writes it where only its owner can read it", async () => {
    const { home, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 });
    expect(await add(box)).toBe(0);
    expect(coderFiles(home)).toEqual({ url: "https://coder.example.com", session: coderToken });
    expect(statSync(coderFile(home, "session")).mode & 0o777).toBe(0o600);
    expect(sshConfig(home)).toBe("# coder https://coder.example.com\n");
    expect(box.calls.flatMap((call) => call.command).join(" ")).not.toContain(coderToken);
    expect(box.coderArgv()).toContain("login --use-token-as-session https://coder.example.com\n");
    expect(box.coderArgv()).not.toContain(coderToken);
  });

  test("and renews an expired session in a session file anyone could read, which only its owner can read after the sign-in", async () => {
    const { home, add } = await signedUp();
    signInOnBox(home, { url: "https://coder.example.com", session: "expired-session" });
    chmodSync(coderFile(home, "session"), 0o644);
    expect(await add(fakeMachine(home, { "box:coder": 1 }))).toBe(0);
    expect(coderFiles(home)).toEqual({ url: "https://coder.example.com", session: coderToken });
    expect(statSync(coderFile(home, "session")).mode & 0o777).toBe(0o600);
  });

  test("and removes the token it made when coder login does not finish in time", async () => {
    const { home, io, add } = await signedUp();
    keepsOwnSsh(home);
    const box = fakeMachine(home, { "box:coder": 1 }, { coderLoginHangs: true });
    expect(await add(box)).toBe(1);
    expect(box.calls.find((call) => call.input?.includes(coderToken))?.timeoutMs).toBe(signInLimitMs);
    expect([box.coderTokens(), sshConfig(home)]).toEqual([[], ownSshConfig]);
    expect(lastLine(io.output())).toBe(`hedge: Hedge could not sign ${node} in to Coder: coder login and coder config-ssh did not finish within 2 minutes.`);
  });

  test("and names the token and the command that removes it when coder login does not finish in time and its removal fails too", async () => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderLoginHangs: true, coderTokenRemoveFails: true });
    expect(await add(box)).toBe(1);
    const [name] = box.coderTokens();
    expect(lastLine(io.output())).toBe(`hedge: Hedge could not sign ${node} in to Coder: coder login and coder config-ssh did not finish within 2 minutes. Hedge could not remove the token it made, ${name}. Remove it with coder tokens remove ${name}.`);
  });

  test("and removes the token it made when coder config-ssh fails after the sign-in", async () => {
    const { home, io, add } = await signedUp();
    keepsOwnSsh(home);
    const box = fakeMachine(home, { "box:coder": 1 }, { coderConfigSshFails: true });
    expect(await add(box)).toBe(1);
    expect([box.coderTokens(), sshConfig(home)]).toEqual([[], ownSshConfig]);
    expect(lastLine(io.output())).toBe(`hedge: Hedge could not sign ${node} in to Coder: error: could not write ~/.ssh/config.`);
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

  test("and makes no token and installs nothing when the workspace's Coder build info answers with a redirect, though its curl follows redirects", async () => {
    const { home, io, add } = await signedUp();
    followsRedirects(home);
    const box = fakeMachine(home, { "box:coder": 1 }, { coderRedirects: ["probe"] });
    expect(await add(box)).toBe(1);
    expect(box.coderTokens()).toEqual([]);
    expect(cliOnBox(home)).toBe(false);
    expect(lastLine(io.output())).toBe(`hedge: ${notReached("https://coder.example.com")}`);
  });

  test("and installs no Coder CLI and makes no token when the CLI download answers with a redirect, though its curl follows redirects", async () => {
    const { home, io, add } = await signedUp();
    followsRedirects(home);
    const box = fakeMachine(home, { "box:coder": 1 }, { coderRedirects: ["binary"] });
    expect(await add(box)).toBe(1);
    expect(box.coderTokens()).toEqual([]);
    expect(cliOnBox(home)).toBe(false);
    expect(readdirSync(join(boxHome(home, node), ".local/bin"))).toEqual([]);
    expect(io.output()).toContain(`hedge: Hedge could not install the Coder CLI on ${node} from https://coder.example.com:`);
  });

  test.each([
    ["answers with another status than 200, though with a CLI that runs", "non-200"],
    ["answers 200 with an empty body", "empty"],
    ["answers 200 with a CLI whose version fails", "broken"],
  ] as const)("and installs no Coder CLI and makes no token when the CLI download %s", async (_, coderCli) => {
    const { home, io, add } = await signedUp();
    const box = fakeMachine(home, { "box:coder": 1 }, { coderCli });
    expect(await add(box)).toBe(1);
    expect(box.coderTokens()).toEqual([]);
    expect(readdirSync(join(boxHome(home, node), ".local/bin"))).toEqual([]);
    expect(io.output()).toContain(`hedge: Hedge could not install the Coder CLI on ${node} from https://coder.example.com:`);
  });

  test.each([
    ["at another Coder deployment", { url: "https://other-coder.example.com", session: personCoderToken }, {}, ""],
    ["with a session file and no address", { session: personCoderToken }, {}, ""],
    ["through CODER_URL at another address", {}, { CODER_URL: "https://other-coder.example.com" }, "CODER_URL"],
    ["through CODER_SESSION_TOKEN", { url: "https://coder.example.com" }, { CODER_SESSION_TOKEN: personCoderToken }, "CODER_SESSION_TOKEN"],
  ])("but leaves the workspace's own Coder sign-in %s as it is, makes no token, installs the Coder CLI, and lists a sign-in that points its SSH config at this machine's Coder address", async (_, files, boxEnv: Record<string, string>, variables) => {
    const { home, io, add } = await signedUp();
    signInOnBox(home, files);
    keepsOwnSsh(home);
    const box = fakeMachine(home, { "box:coder": 1 }, { boxEnv });
    expect(await add(box)).toBe(0);
    expect(coderFiles(home)).toEqual(files);
    expect([box.coderTokens(), sshConfig(home), cliOnBox(home)]).toEqual([[], ownSshConfig, true]);
    const output = io.output();
    expect(output).toContain(`  · Coder on ${node} is signed in another way, so Hedge leaves that sign-in alone and lists the sign-in to https://coder.example.com at the end.`);
    const step = leftStep(output.slice(output.lastIndexOf(`Left for you on ${node}:`)));
    const signIn = variables ? ` First remove ${variables} from the environment on ${node}, then sign` : " Sign";
    expect(step.slice(0, step.indexOf(" Run: "))).toBe(`  · Coder on ${node} is signed in another way, so Hedge left that sign-in alone.${signIn} it in to https://coder.example.com, so it reaches the hub and the other nodes by their coder. names.`);
    expect([step.includes(personCoderToken), step.includes("other-coder")]).toEqual([false, false]);
    const printed = step.slice(step.indexOf(" Run: ") + " Run: ".length);
    expect(throughSsh(home, node, printed, boxEnv)).toBe(0);
    expect(sshConfig(home)).toBe(`# coder ${boxEnv.CODER_URL ?? "https://coder.example.com"}\n`);
    expect(throughSsh(home, node, printed)).toBe(0);
    expect(sshConfig(home)).toBe("# coder https://coder.example.com\n");
  });

  test.each([
    ["a session path that is a directory", "session", (path: string) => void mkdirSync(path)],
    ["a url path that links to a file", "url", (path: string, elsewhere: string) => symlinkSync(elsewhere, path)],
    ["a session path that is a FIFO, which no Coder command reads before the check", "session", (path: string) => void Bun.spawnSync(["mkfifo", path])],
  ] as const)("but leaves %s as it is, makes no token, and lists a sign-in that first moves it aside", async (_, name, make) => {
    const { home, io, add } = await signedUp();
    const elsewhere = join(boxHome(home, node), "elsewhere");
    signInOnBox(home, {});
    writeFileSync(elsewhere, "https://coder.example.com");
    keepsOwnSsh(home);
    const path = coderFile(home, name);
    make(path, elsewhere);
    const box = fakeMachine(home, { "box:coder": 1 });
    expect(await add(box)).toBe(0);
    expect([box.coderTokens(), sshConfig(home), readFileSync(elsewhere, "utf8")]).toEqual([[], ownSshConfig, "https://coder.example.com"]);
    const output = io.output();
    const step = leftStep(output.slice(output.lastIndexOf(`Left for you on ${node}:`)));
    expect(step.slice(0, step.indexOf(" Run: "))).toBe(`  · Coder on ${node} is signed in another way, so Hedge left that sign-in alone. First move ${path} aside, then sign it in to https://coder.example.com, so it reaches the hub and the other nodes by their coder. names.`);
    renameSync(path, `${path}.aside`);
    expect(throughSsh(home, node, step.slice(step.indexOf(" Run: ") + " Run: ".length))).toBe(0);
    expect([sshConfig(home), readFileSync(elsewhere, "utf8")]).toEqual(["# coder https://coder.example.com\n", "https://coder.example.com"]);
  });

  test("and removes the token it made when a session directory appears after the first check", async () => {
    const { home, io, add } = await signedUp();
    signInOnBox(home, { url: "https://coder.example.com" });
    keepsOwnSsh(home);
    const box = fakeMachine(home, { "box:coder": 1 });
    const exec = box.machine.exec;
    box.machine.exec = async (command, run) => {
      const answer = await exec(command, run);
      if (command.join(" ").startsWith("coder tokens create ")) mkdirSync(coderFile(home, "session"));
      return answer;
    };
    expect(await add(box)).toBe(1);
    expect([box.coderTokens(), readdirSync(coderFile(home, "session")), readFileSync(coderFile(home, "url"), "utf8"), sshConfig(home)]).toEqual([[], [], "https://coder.example.com", ownSshConfig]);
    expect(lastLine(io.output())).toBe(`hedge: Hedge could not sign ${node} in to Coder, because it is signed in another way now.`);
  });

  test("and still lists a sign-in the person can do when it leaves another sign-in alone and cannot fetch the Coder CLI from this machine's Coder address", async () => {
    const { home, io, add } = await signedUp();
    const regional = "https://coder-eu.example.com";
    signInOnBox(home, { url: regional, session: personCoderToken });
    keepsOwnSsh(home);
    const box = fakeMachine(home, { "box:coder": 1 }, { boxReachesCoderAt: regional });
    expect(await add(box)).toBe(0);
    expect([box.coderTokens(), sshConfig(home), cliOnBox(home), coderFiles(home)]).toEqual([[], ownSshConfig, false, { url: regional, session: personCoderToken }]);
    const output = io.output();
    expect(leftStep(output.slice(output.lastIndexOf(`Left for you on ${node}:`)))).toBe(`  · Coder on ${node} is signed in another way, so Hedge left that sign-in alone. Hedge could not fetch the Coder CLI from the hub's Coder address, https://coder.example.com, so install it on ${node} from your Coder deployment. Sign it in to Coder over HTTPS, at https://coder.example.com or another address it reaches, and run coder config-ssh --yes.`);
    expect(await add(fakeMachine(home, {}, { boxReachesCoderAt: regional, boxCoderSameUser: true }))).toBe(0);
    expect(sshConfig(home)).toBe(`# coder ${regional}\n`);
  });

  test("and lists no plain HTTP sign-in, and installs nothing, when it leaves another sign-in alone and this machine's Coder address is plain HTTP", async () => {
    const { home, io, add } = await signedUp();
    signInOnBox(home, { url: "https://other-coder.example.com", session: personCoderToken });
    keepsOwnSsh(home);
    const box = fakeMachine(home, { "box:coder": 1 }, { coderAt: "http://coder.example.com" });
    expect(await add(box)).toBe(0);
    expect([box.coderTokens(), sshConfig(home), cliOnBox(home)]).toEqual([[], ownSshConfig, false]);
    const output = io.output();
    expect(leftStep(output.slice(output.lastIndexOf(`Left for you on ${node}:`)))).toBe(`  · Coder on ${node} is signed in another way, so Hedge left that sign-in alone. Sign it in to Coder over HTTPS, at an address it reaches. The hub's Coder address, http://coder.example.com, is plain HTTP, so Hedge prints no sign-in command for it.`);
    expect(output).not.toContain("coder login 'http:");
  });

  test("and removes the token it made when it cannot write it on the workspace", async () => {
    const { home, io, add } = await signedUp();
    mkdirSync(join(boxHome(home, node), ".config"), { recursive: true });
    writeFileSync(join(boxHome(home, node), ".config/coderv2"), "");
    const box = fakeMachine(home, { "box:coder": 1 });
    expect(await add(box)).toBe(1);
    expect(io.output()).toContain(`hedge: Hedge could not sign ${node} in to Coder: `);
    expect([box.coderTokens(), existsSync(join(boxHome(home, node), ".ssh/config"))]).toEqual([[], false]);
  });

  test("and names the token and the command that removes it when its removal fails too", async () => {
    const { home, io, add } = await signedUp();
    mkdirSync(join(boxHome(home, node), ".config"), { recursive: true });
    writeFileSync(join(boxHome(home, node), ".config/coderv2"), "");
    const box = fakeMachine(home, { "box:coder": 1 }, { coderTokenRemoveFails: true });
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
