import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { diskWatchTargets } from "../../packs/hub/lib/disk-watch.ts";
import { loadMachine, loadProfile } from "../profile/profile.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { engineSource, resolveEngine, skillSources } from "../testing/packs.ts";
import { engineRoot, fakeMachine, hedgeSetup, githubRepo, pushedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const coderWorkspace = (name: string) => ({ CODER: "true", CODER_AGENT_URL: "https://coder.example.com", CODER_WORKSPACE_NAME: name });

/** The hub as its own machine: a home with a clone of the profile, in the Coder workspace hedge-hub. */
async function hubMachine(remote: string) {
  const home = temp.make("hub-home-");
  const profile = join(home, ".local/share/hedge/profile");
  await spawnGit(home, "clone", "-q", remote, profile);
  mkdirSync(join(home, ".config/hedge"), { recursive: true });
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "devbox", profileDir: profile }));
  const lines: string[] = [];
  const hedge = (args: string[]) => main(args, { home, engineRoot, platform: "linux", env: coderWorkspace("hedge-hub"), print: (line) => lines.push(line), apply: async () => 0, hostname: () => "hedge-hub" });
  return { home, profile, hedge, output: () => lines.join("\n") };
}

test("the setup guide's hub path: the Mac adds the hub, the hub names itself, the Mac turns the Hub pack on and adds the node, and the hub's disk watch sees the node", async () => {
  const mac = temp.make("mac-home-");
  expect((await hedgeSetup(mac, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(mac), undefined, 0, "darwin")).code).toBe(0);
  const io = scripted([]);
  const onMac = (args: string[], box = fakeMachine(mac)) => main(args, { home: mac, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: box.machine } });

  expect(await onMac(["devbox", "add", "coder.hedge-hub"])).toBe(0);
  const hub = await hubMachine(githubRepo(mac, "nora/hedge-profile"));
  expect(await hub.hedge(["hub", "here"])).toBe(0);
  expect(hub.output()).toStartWith("✓ Saved the hub, coder.hedge-hub, in your profile and pushed it.");

  expect(await onMac(["packs", "--add", "hub", "--workflows", "mcp-gateway=off"])).toBe(0);
  const node = fakeMachine(mac);
  expect(await onMac(["devbox", "add", "coder.hedge-node-1"], node)).toBe(0);
  expect(node.hubUpdates).toEqual(["coder.hedge-hub"]);
  expect(await pushedAnswers(mac)).toMatchObject({ hub: "coder.hedge-hub", packs: expect.arrayContaining(["hub"]), workflows: { "mcp-gateway": false }, devboxes: ["coder.hedge-hub", "coder.hedge-node-1"] });

  await spawnGit(hub.profile, "pull", "-q");
  const { packs, workflows, settings, hub: hubName, devboxes, plan: ai } = await loadProfile(hub.profile);
  const engine = await engineSource();
  const onHub = resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs, workflows, settings, hub: hubName, devboxes, plan: ai }, (await loadMachine(hub.home))!);
  expect(onHub.jobs.filter((job) => job.pack === "hub").map((job) => job.id)).toEqual(expect.arrayContaining(["disk-watch", "peers-restore"]));
  expect(onHub.jobs.filter((job) => job.workflow === "boxes")).toEqual([]);
  expect(onHub.steps.filter((step) => step.pack === "hub").map((step) => step.id)).toEqual(expect.arrayContaining(["ssh-tunnels", "peers"]));
  expect(diskWatchTargets({ HEDGE_PROFILE_DIR: hub.profile }, hub.home, "coder.hedge-hub", "hedge-hub")).toEqual({ local: "coder.hedge-hub", remote: ["coder.hedge-node-1"] });
});
