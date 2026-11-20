import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { git, isolateGit, tempDirs } from "../testing/git.ts";
import { boxHome, coderToken, engineRoot, fakeMachine, hedgeSetup, machineFile, onBox, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

describe("hedge devbox add", () => {
  const addNode2 = async (home: string, box: ReturnType<typeof fakeMachine>) => {
    const io = scripted([]);
    const code = await main(["devbox", "add", "node-2"], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
    return { code, output: io.output() };
  };

  test("hedge devbox add refuses a profile that pins an engine from before the rename, and installs nothing on the box", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const answers = join(machineFile(home).profileDir, "hedge.json");
    const profile = JSON.parse(readFileSync(answers, "utf8"));
    writeFileSync(answers, JSON.stringify({ ...profile, engine: { ...profile.engine, ref: "v0.0.9", channel: "release" } }));
    git(machineFile(home).profileDir, "commit", "-q", "-am", "pin the engine from before the rename");
    const box = fakeMachine(home, {}, { installers: { "v0.0.9": 'mkdir -p "$HOME/.local/share/fleet/engine" && echo installed > "$HOME/.local/share/fleet/engine/get.sh"\n' } });

    const result = await addNode2(home, box);

    expect(result.code).toBe(1);
    expect(result.output).toContain("Your profile pins the engine at v0.0.9, from before Fleet became Hedge, so Hedge does not install it on node-2.");
    expect(existsSync(join(boxHome(home, "node-2"), ".local/share/fleet"))).toBe(false);
  });

  test("hedge devbox add refuses a box whose ~/.config/hedge leads into Fleet's folder, and leaves Fleet's machine file as it was", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const config = join(boxHome(home, "node-2"), ".config");
    mkdirSync(join(config, "fleet"), { recursive: true });
    writeFileSync(join(config, "fleet/machine.json"), '{"schema":1,"role":"devbox"}\n');
    symlinkSync(join(config, "fleet"), join(config, "hedge"));

    const result = await addNode2(home, fakeMachine(home));

    expect(result.code).toBe(1);
    expect(result.output).toContain("~/.config/hedge or its machine.json on node-2 is a link, so Hedge does not write through it.");
    expect(readFileSync(join(config, "fleet/machine.json"), "utf8")).toBe('{"schema":1,"role":"devbox"}\n');
  });

  test("hedge devbox add makes a host a devbox later, and a failed install stops with what to do", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const failing = fakeMachine(home, {}, { failRun: true });
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: failing.machine } })).toBe(1);
    expect(io.output()).toContain("hedge: Hedge did not install on the devbox. Fix what it says above, then run hedge setup again.");

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
