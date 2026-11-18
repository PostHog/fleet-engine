import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jobsAdapter } from "../adapters/jobs/adapter.ts";
import { main, type CliOptions } from "../cli.ts";
import type { CommandRunner } from "../adapters/run.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { engineSteps } from "../testing/packs.ts";
import { fakeSystemd } from "../testing/systemd.ts";
import { filesAdapter } from "./apply.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");

function launchd() {
  const loaded = new Set<string>();
  const run: CommandRunner = async ([, verb, target, file]) => {
    if (verb === "print") return { code: loaded.has(target!) ? 0 : 113, stdout: "" };
    if (verb === "bootstrap") loaded.add(`gui/501/${file!.split("/").at(-1)!.replace(/\.plist$/, "")}`);
    if (verb === "bootout") loaded.delete(target!);
    return { code: 0, stdout: "" };
  };
  return { loaded, run };
}

function machine(repair = "hedge gated setup", platform: "linux" | "darwin" = "linux", extra: Record<string, string> = {}) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/gated"), join(engine, "packs/gated"), { recursive: true });
  const pack = join(engine, "packs/gated/pack.ts");
  writeFileSync(pack, readFileSync(pack, "utf8").replace('command: "hedge gated setup"', `command: ${JSON.stringify(repair)}`));
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(join(engine, "packs", dirname(file)), { recursive: true });
    writeFileSync(join(engine, "packs", file), text);
  }
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["gated", ...Object.keys(extra).map(dirname)], plan: "claude", settings: {}, workflows: {} }));
  const home = temp.make("home-");
  let lines: string[] = [];
  const mac = launchd();
  const linux = fakeSystemd();
  const options: CliOptions = {
    home,
    engineRoot: engine,
    platform,
    env: {},
    print: (line) => lines.push(line),
    run: engineSteps(engine, (args) => main(args, { ...options, print: () => {} })),
    adapters: () => [filesAdapter, jobsAdapter({ run: platform === "darwin" ? mac.run : linux.run, engineRoot: engine, uid: 501 })],
  };
  const hedge = async (...args: string[]) => {
    lines = [];
    return { code: await main(args, options), lines };
  };
  const service = (id: string) => {
    if (platform === "linux") return linux.service(home, id);
    const parts = [existsSync(join(home, `Library/LaunchAgents/dev.hedge.${id}.plist`)), mac.loaded.has(`gui/501/dev.hedge.${id}`)];
    return parts.every(Boolean) ? "running" : parts.some(Boolean) ? "partly removed" : "gone";
  };
  return { profile, home, hedge, service };
}

const todo = "The gated service needs its token. Run: hedge gated setup";

test("a service whose check fails gets no unit, and its setup command installs it in the same run", async () => {
  const { profile, hedge, service } = machine();
  const first = await hedge("apply", "--profile", profile);
  expect(first.code).toBe(0);
  expect(first.lines.join("\n")).toContain(todo);
  expect(service("gated-worker")).toBe("gone");
  expect((await hedge("gated", "setup")).code).toBe(0);
  expect(service("gated-worker")).toBe("running");
  expect((await hedge("doctor")).lines.join("\n")).not.toContain(todo);
});

test("a check that stops passing removes the unit, and doctor names the check as a To do once", async () => {
  const { profile, hedge, service } = machine();
  await hedge("apply", "--profile", profile);
  await hedge("gated", "setup");
  expect(service("gated-worker")).toBe("running");
  expect((await hedge("gated", "forget")).code).toBe(0);
  const doctor = await hedge("doctor");
  expect(doctor.code).toBe(1);
  expect(doctor.lines.join("\n").split(todo).length).toBe(2);
  expect(service("gated-worker")).toBe("running");
  await hedge("apply");
  expect(service("gated-worker")).toBe("gone");
});

test("a setup command that fails applies nothing, even when it saved the token", async () => {
  const { profile, hedge, service } = machine();
  await hedge("apply", "--profile", profile);
  expect((await hedge("gated", "break")).code).toBe(0);
  expect((await hedge("gated", "setup")).code).toBe(1);
  expect(service("gated-worker")).toBe("gone");
});

test.each(["linux", "darwin"] as const)("on %s, a check that stops passing removes its service while another source is out, and that source's service stays", async (platform) => {
  const { profile, home, hedge, service } = machine("hedge gated setup", platform);
  const repo = join(temp.make("team-"), "team");
  mkdirSync(join(repo, "packs/team"), { recursive: true });
  writeFileSync(join(repo, "packs/team/pack.json"), JSON.stringify({ schema: 1, name: "team", summary: "Team rules.", jobs: [{ id: "team-watch", command: ["hedge", "packs"], schedule: { every: "always" } }] }));
  await spawnGit(repo, "init", "-q", "-b", "main");
  await spawnGit(repo, "add", ".");
  await spawnGit(repo, "commit", "-q", "-m", "team");
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [{ name: "team", repo, ref: "main" }], packs: ["gated", "team"], plan: "claude", settings: {}, workflows: {} }));
  await hedge("apply", "--profile", profile);
  await hedge("gated", "setup");
  expect([service("gated-worker"), service("team-watch")]).toEqual(["running", "running"]);
  rmSync(repo, { recursive: true, force: true });
  rmSync(join(home, ".local/share/hedge/sources/team"), { recursive: true, force: true });
  await hedge("gated", "forget");
  expect((await hedge("apply")).lines.join("\n")).toContain(todo);
  expect([service("gated-worker"), service("team-watch")]).toEqual(["gone", "running"]);
});

test("a pack.json sign-in command matches the words you type, however that pack spaces them", async () => {
  const spaced = JSON.stringify({ schema: 1, name: "spaced", summary: "Spaces its words.", human: [{ id: "save", say: "Save the token.", command: "hedge  gated   setup", probe: ["true"] }] });
  const { profile, hedge, service } = machine("hedge gated never", "linux", { "spaced/pack.json": spaced });
  await hedge("apply", "--profile", profile);
  expect((await hedge("gated", "setup")).code).toBe(0);
  expect(service("gated-worker")).toBe("running");
});

test("a repair command that another pack ships installs the service once it passes", async () => {
  const keeper = `export default { sdk: 1, name: "keeper", summary: "Keeps tokens.", register(hedge) { hedge.command("keeper", { summary: "Save", run: async () => { const dir = process.env.HOME + "/.config/hedge/secrets/gated"; await Bun.$\`mkdir -p \${dir}\`; (await import("node:fs")).writeFileSync(dir + "/token", "value", { mode: 0o600 }); return 0; } }); } };\n`;
  const { profile, hedge, service } = machine("hedge keeper save", "linux", { "keeper/pack.ts": keeper });
  await hedge("apply", "--profile", profile);
  expect(service("gated-worker")).toBe("gone");
  expect((await hedge("keeper", "save")).code).toBe(0);
  expect(service("gated-worker")).toBe("running");
});
