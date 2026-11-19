import { afterEach, describe, expect, test } from "bun:test";
import { main } from "../cli.ts";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { coderToken, engineRoot, fakeMachine, hedgeSetup, machineFile, onBox, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

describe("hedge devbox add", () => {
  test("hedge devbox add makes a host a devbox later, and a failed install stops with what to do", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const failing = fakeMachine(home, {}, { failRun: true });
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: failing.machine } })).toBe(1);
    expect(io.output()).toContain("hedge: Hedge did not install on the devbox. Fix what it says above, then run hedge devbox add node-2 again.");

    const box = fakeMachine(home);
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toEndWith("node-2 is your devbox now. It runs your profile, and T3 Code here and there can reach each other.");
    expect(machineFile(home).devboxes).toEqual(["node-2"]);
    expect(machineFile(home).setup.done).toContain("devbox:node-2:link");

    expect(await main(["devbox"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toContain("Your devboxes: node-2");
    expect(await main(["devbox", "drop", "node-2"], options)).toBe(2);
    expect(await main(["devbox", "add", "-oProxyCommand=x"], options)).toBe(2);
    expect((await hedgeSetup(temp.make("home-"), ["--devbox", "-oProxyCommand=x"])).output).toStartWith("hedge setup: --devbox takes an SSH host");
  });

  test("when this machine has no tunnel address for the node to link back to, hedge devbox add fails and links back once run again after the address is there", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const hub: { connectHere: boolean; serverWithoutLinkState: Array<"box" | "here"> } = { connectHere: true, serverWithoutLinkState: ["here"] };
    const box = fakeMachine(home, {}, hub);
    const linkBack = "t3 environment link https://here.relay.example --pairing-code HERECODE --access full-access";
    const onNode = () => box.calls.map((call) => onBox(call.command)).filter((line) => line !== undefined);
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(1);
    expect(io.output()).toContain("Hedge could not find this machine's tunnel address. Update T3 Code here, then run hedge devbox add node-2 again so node-2 links back.");
    expect(machineFile(home).setup.done).not.toContain("devbox:node-2:link");
    expect(onNode()).not.toContainEqual(expect.stringContaining(linkBack));

    hub.serverWithoutLinkState = [];
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(machineFile(home).setup.done).toContain("devbox:node-2:link");
    expect(onNode()).toContainEqual(expect.stringContaining(linkBack));
  });

  test("when ChatGPT's sign-in fails on a node, hedge devbox add says to run hedge devbox add for that node again, not hedge setup", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "codex"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const box = fakeMachine(home, { "box:chatgpt": 99 }, { exits: { "box:chatgpt": 1 } });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: box.machine } })).toBe(1);
    expect(io.output()).toContain("codex login --device-auth ended with code 1, but Sign in to ChatGPT on coder.hedge-node-1 still does not pass its check. Fix what it says above, then run hedge devbox add coder.hedge-node-1 again.");
    expect(io.output()).toContain("and open the link it prints. Then run hedge devbox add coder.hedge-node-1 again.");
    expect(io.output()).not.toContain("hedge setup again");
  });

  test("hedge devbox add signs a Coder workspace in to Coder and writes its SSH config, so it reaches the hub and the other nodes by their coder. names", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const box = fakeMachine(home, { "box:coder": 1 });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toContain("  ✓ Sign in to Coder on coder.hedge-node-1: done");
    expect(box.coderSsh).toEqual(["https://coder.example.com"]);
    const login = box.calls.find((call) => onBox(call.command)?.includes("coder login"));
    expect(login?.input).toBe(`${coderToken}\n`);
    expect(box.calls.flatMap((call) => call.command).join(" ")).not.toContain(coderToken);
    expect(io.output()).not.toContain(coderToken);

    const again = fakeMachine(home);
    expect(await main(["devbox", "add", "coder.hedge-node-2"], { ...options, setup: { machine: again.machine } })).toBe(0);
    expect(again.calls.map((call) => call.command.join(" "))).not.toContain("coder tokens create");
    expect(again.coderSsh).toEqual(["https://coder.example.com"]);
  });

  test("hedge devbox add again signs the workspace in anew when its Coder session has expired", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: fakeMachine(home, { "box:coder": 1 }).machine } })).toBe(0);
    const expired = fakeMachine(home, { "box:coder": 1 });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: expired.machine } })).toBe(0);
    expect(expired.coderSsh).toEqual(["https://coder.example.com"]);
  });

  test("hedge devbox add signs a workspace in to this machine's Coder deployment when it is signed in to another one", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const elsewhere = fakeMachine(home, {}, { boxCoderAt: "https://other-coder.example.com" });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: elsewhere.machine } })).toBe(0);
    expect(elsewhere.coderSsh).toEqual(["https://coder.example.com"]);
  });

  test("hedge devbox add keeps a workspace's Coder session when it reaches the same deployment at another address", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const internal = fakeMachine(home, {}, { boxCoderAt: "http://coder.internal", boxCoderSameUser: true });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: internal.machine } })).toBe(0);
    expect(internal.coderSsh).toEqual(["http://coder.internal"]);
  });

  test("hedge devbox add stops with what to run when this machine is not signed in to Coder, and leaves other SSH hosts alone", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const signedOut = fakeMachine(home, { coder: 1, "box:coder": 1 });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: signedOut.machine } })).toBe(1);
    expect(io.output()).toContain("Coder is not signed in on this machine. Run coder login <your Coder address> here, then hedge devbox add coder.hedge-node-1 again.");

    const plain = fakeMachine(home, { "box:coder": 1 });
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: plain.machine } })).toBe(0);
    expect(plain.coderSsh).toEqual([]);
    expect(io.output()).not.toContain("Sign in to Coder on node-2");
  });
});
