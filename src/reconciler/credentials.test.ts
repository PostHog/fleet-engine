import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CliOptions } from "../cli.ts";
import type { MachineFile } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { engineSteps } from "../testing/packs.ts";
import { filesAdapter } from "./apply.ts";
import { leakedKey } from "./fixtures/issued/pack.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");
const hub: MachineFile = { schema: 1, role: "linux", name: "hub-1" };
const node: MachineFile = { schema: 1, role: "devbox", coder: true, name: "node-2" };

function machine(saved: MachineFile) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/issued"), join(engine, "packs/issued"), { recursive: true });
  const home = temp.make("home-");
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["issued"], plan: "claude", settings: {}, workflows: {}, hub: "hub-1", devboxes: ["node-2"] }));
  mkdirSync(join(home, ".config/hedge"), { recursive: true });
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ ...saved, profileDir: profile }));
  let lines: string[] = [];
  const options: CliOptions = {
    home,
    engineRoot: engine,
    platform: "linux",
    env: {},
    print: (line) => lines.push(line),
    hostname: () => saved.name!,
    run: engineSteps(engine, (args) => main(args, { ...options, print: () => {} })),
    adapters: () => [filesAdapter],
  };
  const hedge = async (...args: string[]) => {
    lines = [];
    const code = await main(args, options);
    return { code, output: lines.join("\n") };
  };
  return Object.assign(hedge, { home });
}

test("on the hub, apply runs the install repair, issues the hub's own key once, and ctx.use returns it with the loopback URL", async () => {
  const hedge = machine(hub);
  expect(await hedge("issued", "use")).toEqual({ code: 1, output: "hedge: issued/issued-api has no credential on this machine yet. Run hedge apply on the hub." });
  const first = await hedge("apply");
  expect(first.code).toBe(0);
  expect(first.output).not.toContain("not installed");
  expect(await hedge("issued", "use")).toEqual({ code: 0, output: "http://127.0.0.1:4600 key-1-for-hub-1" });
  expect((await hedge("apply")).code).toBe(0);
  expect(await hedge("issued", "use")).toEqual({ code: 0, output: "http://127.0.0.1:4600 key-1-for-hub-1" });
});

test("before apply runs its repair, a dry run and doctor name the failing check as a Fix, not a To do", async () => {
  const hedge = machine(hub);
  const previewed = await hedge("apply", "--dry-run");
  expect(previewed.output).toContain("Fix: The issued service is not installed.\n");
  expect(previewed.output).not.toContain("To do:");
  const doctored = await hedge("doctor");
  expect(doctored.output).toContain("Fix: The issued service is not installed.\n");
  expect(doctored.output).not.toContain("To do:");
});

test("a repair that fails leaves the check as a To do, and the hub issues no key for a service whose gate failed", async () => {
  const hedge = machine(hub);
  expect((await hedge("issued", "break")).code).toBe(0);
  const applied = await hedge("apply");
  expect(applied.code).toBe(0);
  expect(applied.output).toContain("To do: The issued service is not installed.\n");
  expect((await hedge("issued", "use")).output).toBe("hedge: issued/issued-api has no credential on this machine yet. Run hedge apply on the hub.");
});

test("on the hub, a stored credential that other users can read gives a finding that says how to fix the file", async () => {
  const hedge = machine(hub);
  await hedge("apply");
  chmodSync(join(hedge.home, ".config/hedge/secrets/issued/credential.issued-api"), 0o644);
  const applied = await hedge("apply");
  expect(applied.code).toBe(0);
  expect(applied.output).toContain("To do: ~/.config/hedge/secrets/issued/credential.issued-api is open to other users. Run chmod 600 ~/.config/hedge/secrets/issued/credential.issued-api, or save the secret again.");
  expect(applied.output).not.toContain("Could not issue");
});

test("a service that refuses to issue a key gives a finding, and apply stores nothing", async () => {
  const hedge = machine(hub);
  expect((await hedge("issued", "refuse")).code).toBe(0);
  const applied = await hedge("apply");
  expect(applied.output).toContain("Fix: Could not issue the credential of issued/issued-api. Run hedge credential issued/issued-api hub-1 to see why. Hedge tries again at the next apply.");
  expect(applied.code).toBe(0);
  expect((await hedge("issued", "use")).output).toBe("hedge: issued/issued-api has no credential on this machine yet. Run hedge apply on the hub.");
});

test("the hub's finding copies nothing that a failing service printed or threw, so its key stays out of the report", async () => {
  const hedge = machine(hub);
  expect((await hedge("issued", "leak")).code).toBe(0);
  const applied = await hedge("apply");
  const report = applied.output.split("\n").filter((line) => line !== `hedge: ${leakedKey}`).join("\n");
  expect(report).toContain("Fix: Could not issue the credential of issued/issued-api. Run hedge credential issued/issued-api hub-1 to see why. Hedge tries again at the next apply.");
  expect(report).not.toContain(leakedKey);
});

test("a node issues nothing in its own apply, and ctx.use fails fast with a sentence", async () => {
  const hedge = machine(node);
  expect((await hedge("apply")).code).toBe(0);
  expect(await hedge("issued", "use")).toEqual({ code: 1, output: "hedge: issued/issued-api has no credential on this machine yet. Run hedge apply on the hub." });
});

test("ctx.use names a service that the catalog leaves out because its workflow is off", async () => {
  const hedge = machine(hub);
  expect(await hedge("issued", "spare")).toEqual({ code: 1, output: "hedge: the service catalog has no issued/issued-spare: its workflow or plan is off in your profile." });
});
