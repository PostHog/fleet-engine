import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { engineRoot, fakeMachine, hedgeSetup, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const clientSettings = (home: string) => join(home, ".t3/userdata/client-settings.json");
const readSettings = (home: string) => JSON.parse(readFileSync(clientSettings(home), "utf8"));

async function macWithT3(hub = "coder.hedge-hub", platform: NodeJS.Platform = "darwin") {
  const home = temp.make("mac-home-");
  expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(home), undefined, 0, platform)).code).toBe(0);
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  writeFileSync(join(home, ".t3/userdata/environment-id"), "env-mac\n");
  const profile = profilePath(home);
  const answers = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...answers, hub }, null, 2) + "\n");
  await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
  await spawnGit(profile, "push", "-q");
  const io = scripted([]);
  const add = (host: string, box = fakeMachine(home)) => main(["devbox", "add", host], { home, engineRoot, platform, print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
  return { home, io, add };
}

test("after a node joins, T3 Code on the Mac balances new threads across the nodes and keeps them off the Mac and the hub", async () => {
  const { home, io, add } = await macWithT3();
  expect(await add("coder.hedge-hub")).toBe(0);
  expect(io.output()).toEndWith("· New threads stay on this Mac until a node runs. Add one with hedge devbox add <ssh host>.");

  writeFileSync(clientSettings(home), JSON.stringify({ chatWidth: "wide", loadBalancingWeights: { "env-elsewhere": 25 } }));
  expect(await add("coder.hedge-node-1")).toBe(0);
  expect(readSettings(home)).toEqual({ chatWidth: "wide", loadBalancingEnabled: true, loadBalancingWeights: { "env-elsewhere": 25, "env-mac": 0, "env-coder.hedge-hub": 0, "env-coder.hedge-node-1": 50 } });
  expect(io.output()).toEndWith("✓ T3 Code on this Mac starts new threads on coder.hedge-node-1. Quit and reopen T3 Code so it reads this.");

  const settings = readSettings(home);
  writeFileSync(clientSettings(home), JSON.stringify({ ...settings, loadBalancingWeights: { ...settings.loadBalancingWeights, "env-mac": 50, "env-coder.hedge-node-1": 0 } }));
  expect(await add("coder.hedge-node-2")).toBe(0);
  expect(readSettings(home).loadBalancingWeights).toEqual({ "env-elsewhere": 25, "env-mac": 50, "env-coder.hedge-hub": 0, "env-coder.hedge-node-1": 0, "env-coder.hedge-node-2": 50 });
  expect(io.output()).toEndWith("✓ T3 Code on this Mac starts new threads on coder.hedge-node-2 and this Mac. Quit and reopen T3 Code so it reads this.");
});

test("a Mac without T3 Code's settings, or with settings Hedge cannot read, gets the steps instead, and a node whose T3 Code Hedge cannot read keeps its default share", async () => {
  const { home, io, add } = await macWithT3();
  writeFileSync(clientSettings(home), "{ not json");
  expect(await add("coder.hedge-node-1")).toBe(0);
  expect(readFileSync(clientSettings(home), "utf8")).toBe("{ not json");
  expect(io.output()).toEndWith(`· Hedge cannot read ${clientSettings(home)}, so it left it alone. In T3 Code, open Settings → Environments → Load balancing, turn it on, and set this Mac and the hub to Manual only.`);

  writeFileSync(clientSettings(home), "{}");
  expect(await add("coder.hedge-node-2", fakeMachine(home, {}, { withoutT3: ["coder.hedge-node-2"] }))).toBe(0);
  expect(readSettings(home)).toEqual({ loadBalancingEnabled: true, loadBalancingWeights: { "env-mac": 0, "env-coder.hedge-hub": 0, "env-coder.hedge-node-1": 50 } });
});

test("a machine that is not a Mac leaves T3 Code's settings alone", async () => {
  const { home, io, add } = await macWithT3("coder.hedge-hub", "linux");
  expect(await add("coder.hedge-node-1")).toBe(0);
  expect(() => readFileSync(clientSettings(home))).toThrow();
  expect(io.output()).not.toContain("new threads");
});

test("Hedge changes no weight while it cannot tell which machine is the hub, and knows the hub by the id it recorded once the hub answered", async () => {
  const { home, io, add } = await macWithT3();
  expect(await add("coder.hedge-node-1", fakeMachine(home, {}, { unreachable: ["coder.hedge-hub"] }))).toBe(0);
  expect(existsSync(clientSettings(home))).toBe(false);
  expect(io.output()).toEndWith("· Hedge cannot reach T3 Code on the hub, coder.hedge-hub, so it left load balancing alone. In T3 Code, open Settings → Environments → Load balancing, turn it on, and set this Mac and the hub to Manual only.");

  expect(await add("coder.hedge-node-2")).toBe(0);
  writeFileSync(clientSettings(home), "{}");
  expect(await add("coder.hedge-node-3", fakeMachine(home, {}, { unreachable: ["coder.hedge-hub"] }))).toBe(0);
  expect(readSettings(home).loadBalancingWeights).toEqual({ "env-mac": 0, "env-coder.hedge-hub": 0, "env-coder.hedge-node-1": 50, "env-coder.hedge-node-2": 50, "env-coder.hedge-node-3": 50 });
});

test("Hedge balances inside the settings key an older T3 Code wrapped its settings in, and writes through a symlinked settings file", async () => {
  const { home, add } = await macWithT3();
  writeFileSync(clientSettings(home), JSON.stringify({ version: 1, settings: { chatWidth: "wide", loadBalancingWeights: { "env-elsewhere": 25 } } }));
  expect(await add("coder.hedge-node-1")).toBe(0);
  expect(readSettings(home)).toEqual({ version: 1, settings: { chatWidth: "wide", loadBalancingEnabled: true, loadBalancingWeights: { "env-elsewhere": 25, "env-mac": 0, "env-coder.hedge-hub": 0, "env-coder.hedge-node-1": 50 } } });

  const shared = join(temp.make("dotfiles-"), "client-settings.json");
  writeFileSync(shared, "{}");
  rmSync(clientSettings(home));
  symlinkSync(shared, clientSettings(home));
  expect(await add("coder.hedge-node-2")).toBe(0);
  expect(lstatSync(clientSettings(home)).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(shared, "utf8")).loadBalancingWeights).toEqual({ "env-mac": 0, "env-coder.hedge-hub": 0, "env-coder.hedge-node-1": 50, "env-coder.hedge-node-2": 50 });
});

test("a Mac whose T3 Code id Hedge cannot read keeps its settings", async () => {
  const { home, io, add } = await macWithT3();
  rmSync(join(home, ".t3/userdata/environment-id"));
  expect(await add("coder.hedge-node-1")).toBe(0);
  expect(existsSync(clientSettings(home))).toBe(false);
  expect(io.output()).toEndWith("· Hedge cannot read T3 Code's id on this Mac, so it left load balancing alone. In T3 Code, open Settings → Environments → Load balancing, turn it on, and set this Mac and the hub to Manual only.");
});
