import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { boxHome, boxMachineFile, engineRoot, fakeMachine, hedgeSetup, githubRepo, machineFile, pushedAnswers, remote, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

describe("hedge devbox add with a hub", () => {
  async function withHub(hub = "coder.hedge-hub") {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const profile = profilePath(home);
    const answers = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
    writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...answers, hub }, null, 2) + "\n");
    await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
    await spawnGit(profile, "push", "-q");
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    return { home, io, add: (host: string, box: ReturnType<typeof fakeMachine>) => main(["devbox", "add", host], { ...options, setup: { machine: box.machine } }) };
  }

  test("hedge devbox add lists the node in the profile, and the hub takes it before the node asks it for a credential and links it in T3 Code once the node runs T3", async () => {
    const { home, io, add } = await withHub();
    const box = fakeMachine(home);
    expect(await add("coder.hedge-node-1", box)).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-node-1"]);
    expect(box.hubUpdates).toEqual(["coder.hedge-hub"]);
    expect(box.credentials).toEqual([{ node: "coder.hedge-node-1", issued: true }]);
    expect(io.output()).toContain("✓ The hub, coder.hedge-hub, took coder.hedge-node-1: its disk watch, tunnels and credentials include it now.");
    expect(box.hubLinked).toEqual(["coder.hedge-node-1"]);
    expect(io.output()).toEndWith("✓ The hub, coder.hedge-hub, linked coder.hedge-node-1 in T3 Code.");

    const down = fakeMachine(home, {}, { hubDown: true });
    expect(await add("coder.hedge-node-2", down)).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-node-1", "coder.hedge-node-2"]);
    expect(io.output()).toContain("· The hub, coder.hedge-hub, did not answer. It takes coder.hedge-node-2 at its next hedge update, or run hedge update there now.");
    expect(io.output()).toEndWith(`· The hub, coder.hedge-hub, has not linked coder.hedge-node-2 in T3 Code yet. To link it, run ssh coder.hedge-hub 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; hedge peers link coder.hedge-node-2' now.`);

    const failing = fakeMachine(home, {}, { hubUpdateFails: "hedge update: /home/nora/.local/share/hedge/engine has local changes." });
    expect(await add("coder.hedge-node-3", failing)).toBe(0);
    expect(io.output()).toContain("▶ The hub, coder.hedge-hub, takes coder.hedge-node-3 with hedge update there. This can take some minutes.\n· The hub, coder.hedge-hub, could not update: hedge update: /home/nora/.local/share/hedge/engine has local changes. Fix that there and run hedge update there; it takes coder.hedge-node-3 then.");
  });

  test("hedge devbox add pushes the node on the next run when the push of the profile failed", async () => {
    const { home, io, add } = await withHub();
    const rejecting = join(githubRepo(home, "nora/hedge-profile"), "hooks/pre-receive");
    writeFileSync(rejecting, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await add("coder.hedge-node-1", fakeMachine(home))).toBe(1);
    expect(io.output()).toContain("could not push answers");
    rmSync(rejecting);
    const box = fakeMachine(home);
    expect(await add("coder.hedge-node-1", box)).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-node-1"]);
    expect(box.credentials).toEqual([{ node: "coder.hedge-node-1", issued: true }]);
    expect(io.output()).toContain("✓ The hub, coder.hedge-hub, took coder.hedge-node-1");
  });

  test("hedge devbox add refuses a name the hub cannot use, or a pool box name, before it saves or publishes anything", async () => {
    const { home, io, add } = await withHub();
    const before = await pushedAnswers(home);
    for (const host of ["worker_1", "Node-1", "box-7"]) {
      const box = fakeMachine(home);
      expect(await add(host, box)).toBe(2);
      expect(remote(box)).toEqual([]);
    }
    expect(io.output()).toContain("hedge devbox: worker_1 is not a name the hub can use. Give the devbox an SSH name in ~/.ssh/config of lowercase letters, digits, dots and dashes, starting with a letter or a digit.");
    expect(io.output()).toContain("hedge devbox: Node-1 is not a name the hub can use.");
    expect(io.output()).toContain("hedge devbox: box-7 is a pool box name. Names that start with box- are kept for the boxes the hub starts; give the devbox another SSH name.");
    expect(await pushedAnswers(home)).toEqual(before);
    expect(machineFile(home).devboxes).toEqual([]);
  });

  test("hedge devbox add names the box by the SSH name the profile lists, keeps the rest of a role file there, and stops when the box already has another name", async () => {
    const { home, io, add } = await withHub();
    expect(await add("coder.hedge-node-1", fakeMachine(home))).toBe(0);
    expect(boxMachineFile(home, "coder.hedge-node-1")).toEqual({ schema: 1, role: "devbox", name: "coder.hedge-node-1" });

    const unnamed = join(boxHome(home, "node-2"), ".config/hedge");
    mkdirSync(unnamed, { recursive: true });
    writeFileSync(join(unnamed, "machine.json"), JSON.stringify({ schema: 1, role: "linux", coder: true }));
    expect(await add("node-2", fakeMachine(home))).toBe(0);
    expect(boxMachineFile(home, "node-2")).toEqual({ schema: 1, role: "linux", coder: true, name: "node-2" });

    const named = join(boxHome(home, "node-3"), ".config/hedge");
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, "machine.json"), JSON.stringify({ schema: 1, role: "devbox", name: "old-node" }));
    const box = fakeMachine(home);
    expect(await add("node-3", box)).toBe(1);
    expect(io.output()).toContain("hedge: node-3 already calls itself old-node in ~/.config/hedge/machine.json. Run hedge devbox add old-node to keep that name, or set its name there to node-3 and run hedge devbox add node-3 again.");
    expect(boxMachineFile(home, "node-3").name).toBe("old-node");
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-node-1", "node-2"]);
    expect(box.hubUpdates).toEqual([]);
  });

  test("hedge devbox add reads the box's role file and T3 Connect state apart from the host key warning ssh prints when it first reaches the box", async () => {
    const { home, add } = await withHub();
    const folder = join(boxHome(home, "node-4"), ".config/hedge");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "machine.json"), JSON.stringify({ schema: 1, role: "linux" }));
    const box = fakeMachine(home, { "box:t3": 1 });
    expect(await add("node-4", box)).toBe(0);
    expect(boxMachineFile(home, "node-4")).toEqual({ schema: 1, role: "linux", name: "node-4" });
    expect(machineFile(home).setup.done).toContain("devbox:node-4:link");
  });

  test("hedge devbox add for the hub itself lists it once and asks nothing of a hub", async () => {
    const { home, add } = await withHub();
    const box = fakeMachine(home);
    expect(await add("coder.hedge-hub", box)).toBe(0);
    expect(await add("coder.hedge-hub", box)).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-hub"]);
    expect(box.hubUpdates).toEqual([]);
    expect(box.hubLinked).toEqual([]);
  });
});
