import { afterEach, beforeAll, expect, test } from "bun:test";
import type { AvailableSource, MachineFile, Profile } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, mac, resolveEngine } from "../../src/testing/packs.ts";
import { hedgeMachine, runHedge } from "../orchestration/lib/testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let sources: AvailableSource[];
beforeAll(async () => void (sources = [await engineSource()]));

const hub: MachineFile = { schema: 1, role: "hub" };
const linux: MachineFile = { schema: 1, role: "linux" };
const linkedHubItems = (machine: MachineFile, fields: Partial<Profile> = {}) => {
  const result = resolveEngine(sources, { packs: ["hub"], settings: { "hub.alias": "my-hub" }, ...fields }, machine);
  const ours = <T extends { pack: string; workflow?: string }>(items: T[]) => items.filter((item) => item.pack === "hub" && item.workflow === "linked-hub");
  return {
    steps: ours(result.steps).map((step) => `${step.id}: ${step.run.join(" ")}, checked by ${step.check?.join(" ")}`),
    jobs: ours(result.jobs).map((job) => `${job.id}: ${job.command.join(" ")} every ${job.schedule.every}${job.schedule.at ? ` at ${job.schedule.at}` : ""}`),
    human: ours(result.human).map((step) => `${step.id}: probed by ${step.probe.join(" ")}`),
  };
};

test("Hub links puts HTTPS and the devbox tunnels on the hub, the hosts entry on a devbox, and the hub tunnel on a Mac, each checked by its doctor", () => {
  const jobs = ["peers-renew: hedge peers renew every 1d at 03:07", "peers-restore: hedge peers restore every 5m"];
  const peers = "peers: hedge peers install, checked by hedge peers doctor";
  expect(linkedHubItems(hub)).toEqual({
    steps: ["hub-https: hedge hub-https install, checked by hedge hub-https doctor", "ssh-tunnels: hedge ssh-tunnels install, checked by hedge ssh-tunnels doctor", peers],
    jobs,
    human: [],
  });
  expect(linkedHubItems(devbox)).toEqual({ steps: ["ssh-tunnels: hedge ssh-tunnels install, checked by hedge ssh-tunnels doctor", peers], jobs, human: [] });
  expect(linkedHubItems(mac)).toEqual({ steps: ["hub-tunnel: hedge hub-tunnel install, checked by hedge hub-tunnel doctor"], jobs: [], human: ["hub-https-trust: probed by hedge hub-https trusted"] });
  expect(linkedHubItems(linux)).toEqual({ steps: [], jobs: [], human: [] });
});

test("the Mac's trust step names the command that prints the hub's certificate and says how to trust it", () => {
  const step = resolveEngine(sources, { packs: ["hub"], settings: { "hub.alias": "my-hub" } }, mac).human.find((item) => item.id === "hub-https-trust")!;
  expect(step.say).toContain("hedge hub-https ca");
  expect(step.say).toContain("Always Trust");
});

test("Hub links plans nothing while the workflow is off or the Hub pack is not on", () => {
  for (const machine of [hub, devbox, mac]) {
    expect(linkedHubItems(machine, { workflows: { "linked-hub": false } })).toEqual({ steps: [], jobs: [], human: [] });
    expect(linkedHubItems(machine, { packs: [] })).toEqual({ steps: [], jobs: [], human: [] });
  }
});

test("through hedge, hub-https doctor passes with no HTTPS host, and peers plan lists the merged peers without this machine", async () => {
  const home = temp.make("hedge-links-cli-");
  const profile = await hedgeMachine(home, { "hub.alias": "my-hub" });
  const hedge = await Bun.file(`${profile}/hedge.json`).json();
  await Bun.write(`${profile}/hedge.json`, JSON.stringify({ ...hedge, packs: ["hub"], devboxes: ["devbox-1", "devbox-2"] }));
  expect(await runHedge(["hub-https", "doctor"], { HOME: home })).toEqual({ stdout: "Hub HTTPS is off: hub.httpsHost is empty.\n", stderr: "", code: 0 });
  expect(await runHedge(["peers", "plan"], { HOME: home })).toEqual({ stdout: "Peer access plan: my-hub, devbox-1, devbox-2\n", stderr: "", code: 0 });
});
