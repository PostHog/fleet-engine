import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "../cli.ts";
import { diskWatchTargets } from "../../packs/hub/lib/disk-watch.ts";
import { loadMachine, loadProfile } from "../profile/profile.ts";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { engineSource, resolveEngine, skillSources } from "../testing/packs.ts";
import { engineRoot, fakeMachine, pushedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const coderWorkspace = (name: string) => ({ CODER: "true", CODER_AGENT_URL: "https://coder.example.com", CODER_WORKSPACE_NAME: name });

test("the setup guide's hub path: the hub sets itself up, names itself the hub, turns the Hub pack on, and adds the node, and its disk watch sees the node", async () => {
  const home = temp.make("hub-home-");
  const box = fakeMachine(home);
  const io = scripted([]);
  const env = coderWorkspace("hedge-hub");
  const onHub = (args: string[]) => main(args, { home, engineRoot, platform: "linux", env, hostname: () => "hedge-hub", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: box.machine, clock: box.clock, doctor: async () => 0, env, timeZone: "UTC" } });

  expect(await onHub(["setup", "--chat", "--preset", "starter", "--plan", "codex"])).toBe(0);
  expect(await onHub(["hub", "here"])).toBe(0);
  expect(io.output()).toContain("✓ Saved the hub, coder.hedge-hub, in your profile and pushed it.");
  expect(await onHub(["packs", "--add", "hub", "--workflows", "mcp-gateway=off"])).toBe(0);
  expect(await onHub(["devbox", "add", "coder.hedge-node-1"])).toBe(0);
  expect(box.hubUpdates).toEqual(["coder.hedge-hub"]);
  expect(await pushedAnswers(home)).toMatchObject({ hub: "coder.hedge-hub", packs: expect.arrayContaining(["hub"]), workflows: { "mcp-gateway": false }, devboxes: ["coder.hedge-node-1"] });

  const profile = join(home, ".local/share/hedge/profile");
  const { packs, workflows, settings, hub: hubName, devboxes, plan: ai } = await loadProfile(profile);
  const engine = await engineSource();
  const onHubPlan = resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs, workflows, settings, hub: hubName, devboxes, plan: ai }, (await loadMachine(home))!);
  expect(onHubPlan.jobs.filter((job) => job.pack === "hub").map((job) => job.id)).toEqual(expect.arrayContaining(["disk-watch", "peers-restore"]));
  expect(onHubPlan.jobs.filter((job) => job.workflow === "boxes")).toEqual([]);
  expect(onHubPlan.steps.filter((step) => step.pack === "hub").map((step) => step.id)).toEqual(expect.arrayContaining(["ssh-tunnels", "peers"]));
  expect(diskWatchTargets({ HEDGE_PROFILE_DIR: profile }, home, "coder.hedge-hub", "hedge-hub")).toEqual({ local: "coder.hedge-hub", remote: ["coder.hedge-node-1"] });
});
