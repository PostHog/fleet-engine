import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { engineRoot, fakeMachine, hedgeSetup, githubRepo, machineFile, pushedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const clientSettings = (home: string) => join(home, ".t3/userdata/client-settings.json");

async function macWithMachines(hub: string) {
  const home = temp.make("mac-home-");
  expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(home), undefined, 0, "darwin")).code).toBe(0);
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  writeFileSync(join(home, ".t3/userdata/environment-id"), "env-mac\n");
  const profile = profilePath(home);
  const answers = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...answers, hub }, null, 2) + "\n");
  await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
  await spawnGit(profile, "push", "-q");
  const io = scripted([]);
  const hedge = (args: string[], box = fakeMachine(home)) => main(args, { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
  for (const host of ["coder.old-hub", "coder.hedge-hub-2", "coder.hedge-node-1"]) expect(await hedge(["devbox", "add", host])).toBe(0);
  return { home, io, hedge };
}

const linkedHere = [
  { environmentId: "env-coder.old-hub", label: "old-hub" },
  { environmentId: "env-coder.hedge-hub-2", label: "hedge-hub-2" },
  { environmentId: "env-coder.hedge-node-1", label: "hedge-node-1" },
];

test("hedge devbox remove takes a replaced hub out of the profile and unlinks it in T3 Code here, also when the workspace is gone", async () => {
  const { home, io, hedge } = await macWithMachines("coder.hedge-hub-2");
  const box = fakeMachine(home, {}, { hereLinks: linkedHere });
  expect(await hedge(["devbox", "remove", "coder.old-hub"], box)).toBe(0);
  expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-hub-2", "coder.hedge-node-1"]);
  expect(machineFile(home).devboxes).toEqual(["coder.hedge-hub-2", "coder.hedge-node-1"]);
  expect(box.hereLinks().map((link) => link.environmentId)).toEqual(["env-coder.hedge-hub-2", "env-coder.hedge-node-1"]);
  expect(JSON.parse(readFileSync(clientSettings(home), "utf8")).loadBalancingWeights).toEqual({ "env-mac": 0, "env-coder.hedge-hub-2": 0, "env-coder.hedge-node-1": 50 });
  expect(io.output()).toEndWith("✓ Removed coder.old-hub from your profile and unlinked it in T3 Code here. The hub stops its tunnel, disk watch and link to it at its next hedge update.");

  const gone = fakeMachine(home, {}, { hereLinks: [linkedHere[1]!, { environmentId: "env-coder.hedge-node-1", label: "Build Machine" }], unreachable: ["coder.hedge-node-1"] });
  expect(await hedge(["devbox", "remove", "coder.hedge-node-1"], gone)).toBe(0);
  expect(gone.hereLinks().map((link) => link.environmentId)).toEqual(["env-coder.hedge-hub-2"]);
  expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-hub-2"]);
});

test("hedge devbox remove refuses the hub the profile names, and says what to unlink when T3 Code here does not know the host", async () => {
  const { home, io, hedge } = await macWithMachines("coder.hedge-hub-2");
  expect(await hedge(["devbox", "remove", "coder.hedge-hub-2"], fakeMachine(home, {}, { hereLinks: linkedHere }))).toBe(1);
  expect(io.output()).toContain("coder.hedge-hub-2 is your hub. Run hedge hub here on the new hub first, then hedge devbox remove coder.hedge-hub-2.");
  expect((await pushedAnswers(home)).devboxes).toContain("coder.hedge-hub-2");

  const unknown = fakeMachine(home, {}, { hereLinks: [], unreachable: ["coder.old-hub"] });
  expect(await hedge(["devbox", "remove", "coder.old-hub"], unknown)).toBe(0);
  expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-hub-2", "coder.hedge-node-1"]);
  expect(io.output()).toEndWith("· T3 Code here has no link to coder.old-hub that Hedge can find. When T3 Code still lists it, remove it in Settings → Environments.");

  expect(await hedge(["devbox", "remove", "coder.never-added"], fakeMachine(home))).toBe(1);
  expect(io.output()).toContain("coder.never-added is not one of your devboxes.");
  expect(await hedge(["devbox", "remove", "-oProxyCommand=x"])).toBe(2);
});

test("hedge devbox remove changes nothing when T3 Code here cannot unlink the host, so a second run tries again", async () => {
  const { home, io, hedge } = await macWithMachines("coder.hedge-hub-2");
  const failing = fakeMachine(home, {}, { hereLinks: linkedHere, unlinkFails: "Error: the T3 server here is not running" });
  expect(await hedge(["devbox", "remove", "coder.old-hub"], failing)).toBe(1);
  expect(io.output()).toContain("T3 Code here could not unlink coder.old-hub: Error: the T3 server here is not running Fix that, then run hedge devbox remove coder.old-hub again.");
  expect((await pushedAnswers(home)).devboxes).toContain("coder.old-hub");
  expect(JSON.parse(readFileSync(clientSettings(home), "utf8")).loadBalancingWeights["env-coder.old-hub"]).toBe(50);

  const working = fakeMachine(home, {}, { hereLinks: failing.hereLinks() });
  expect(await hedge(["devbox", "remove", "coder.old-hub"], working)).toBe(0);
  expect(working.hereLinks().map((link) => link.environmentId)).toEqual(["env-coder.hedge-hub-2", "env-coder.hedge-node-1"]);
});

test("hedge devbox remove pushes the removal on the next run when the push of the profile failed", async () => {
  const { home, io, hedge } = await macWithMachines("coder.hedge-hub-2");
  const rejecting = join(githubRepo(home, "nora/hedge-profile"), "hooks/pre-receive");
  writeFileSync(rejecting, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(await hedge(["devbox", "remove", "coder.hedge-node-1"], fakeMachine(home, {}, { hereLinks: linkedHere }))).toBe(1);
  expect(io.output()).toContain("could not push answers");
  rmSync(rejecting);
  expect(await hedge(["devbox", "remove", "coder.hedge-node-1"], fakeMachine(home, {}, { hereLinks: linkedHere.slice(0, 2) }))).toBe(0);
  expect((await pushedAnswers(home)).devboxes).toEqual(["coder.old-hub", "coder.hedge-hub-2"]);
});

test("hedge devbox remove finds a host Hedge never recorded by the one link here labelled with its name", async () => {
  const { home, hedge } = await macWithMachines("coder.hedge-hub-2");
  const { t3Environments: _, ...unrecorded } = machineFile(home);
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify(unrecorded));
  const gone = fakeMachine(home, {}, { hereLinks: linkedHere, unreachable: ["coder.old-hub"] });
  expect(await hedge(["devbox", "remove", "coder.old-hub"], gone)).toBe(0);
  expect(gone.hereLinks().map((link) => link.environmentId)).toEqual(["env-coder.hedge-hub-2", "env-coder.hedge-node-1"]);
});
