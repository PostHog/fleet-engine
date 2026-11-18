import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secretStore } from "./context.ts";
import { main, type CliOptions } from "../cli.ts";
import { startT3Stub } from "../integrations/t3/testing.ts";
import { tempDirs } from "../testing/git.ts";
import { engineSteps } from "../testing/packs.ts";

const temp = tempDirs();
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  temp.cleanup();
});

const repoRoot = join(import.meta.dir, "../..");
const start = Date.parse("2026-11-10T08:00:00Z");

async function spawned(command: string[], env: Record<string, string>) {
  try {
    return await Bun.spawn(command, { env, stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    return 127;
  }
}

async function machine(packs = ["kit"], settings: Record<string, string> = {}, files: Record<string, string> = {}) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/kit"), join(engine, "packs/kit"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(engine, path, ".."), { recursive: true });
    writeFileSync(join(engine, path), text);
  }
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs, plan: "claude", settings, workflows: {} }));
  const home = temp.make("home-");
  const bin = temp.make("bin-");
  for (const [tool, version] of [["claude", "claude 1.0.0"], ["npx", "11.0.0"]]) {
    writeFileSync(join(bin, tool!), `#!/bin/sh\n[ "$*" = --version ] && echo "${version}"\n`);
    chmodSync(join(bin, tool!), 0o755);
  }
  let now = start;
  let asleep = async (_now: number) => {};
  let lines: string[] = [];
  const options: CliOptions = {
    home,
    engineRoot: engine,
    platform: "linux",
    env: {},
    print: (line) => lines.push(line),
    run: engineSteps(engine, (args) => main(args, { ...options, print: () => {} }), (command) => spawned(command, { HOME: home, PATH: `${bin}:/usr/bin:/bin` })),
    clock: { now: () => now, sleep: async (ms) => ((now += ms), await asleep(now)) },
  };
  const hedge = async (...args: string[]) => {
    lines = [];
    const code = await main(args, options);
    return { code, lines };
  };
  expect((await hedge("apply", "--profile", profile)).code).toBe(0);
  return { home, engine, hedge, whileAsleep: (work: (now: number) => Promise<void>) => (asleep = work) };
}

test("a pack.ts command runs in the engine with the pack's settings", async () => {
  expect(await (await machine()).hedge("kit", "greet", "you")).toEqual({ code: 0, lines: ["hello you"] });
  expect(await (await machine(["kit"], { "kit.greeting": "hi" })).hedge("kit", "greet", "you")).toEqual({ code: 0, lines: ["hi you"] });
});

test("a pack command from before the rename finds the same values under their FLEET_ names", async () => {
  const { engine, hedge } = await machine();
  const [line] = (await hedge("kit", "legacy-env")).lines;
  expect(line).toStartWith(`${engine} `);
  expect(JSON.parse(line!.split(" ").slice(1).join(" "))).toMatchObject({ "kit.greeting": "hello" });
});

test("a pack.ts command sees today's pack-command environment", async () => {
  const { home, engine, hedge } = await machine();
  const [line] = (await hedge("kit", "env")).lines;
  expect(line).toStartWith(`${home} ${engine} `);
  expect(JSON.parse(line!.split(" ").slice(2).join(" "))).toMatchObject({ "kit.greeting": "hello" });
});

test("a pack's secrets live in an owner-only store, and a write replaces the value whole", async () => {
  const { home, hedge } = await machine();
  expect((await hedge("kit", "show", "token")).lines).toEqual(["no secret"]);
  expect((await hedge("kit", "save", "token", "first")).code).toBe(0);
  expect((await hedge("kit", "save", "token", "second")).code).toBe(0);
  expect((await hedge("kit", "show", "token")).lines).toEqual(["second"]);
  const dir = join(home, ".config/hedge/secrets/kit");
  const files = readdirSync(dir).map((name) => join(dir, name));
  expect(files.filter((file) => readFileSync(file, "utf8").includes("first"))).toEqual([]);
  expect([statSync(dir).mode & 0o777, ...new Set(files.map((file) => statSync(file).mode & 0o777))]).toEqual([0o700, 0o600]);
});

test("a write closes a store directory that was left open to others", async () => {
  const { home, hedge } = await machine();
  const dir = join(home, ".config/hedge/secrets/kit");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  expect((await hedge("kit", "save", "token", "value")).code).toBe(0);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("a store refuses a secret that other users can read, or a link, and names the file but not the value", async () => {
  const { home, hedge } = await machine();
  const dir = join(home, ".config/hedge/secrets/kit");
  expect((await hedge("kit", "save", "token", "kept-value")).code).toBe(0);
  chmodSync(join(dir, "token"), 0o640);
  expect(await hedge("kit", "show", "token")).toEqual({ code: 1, lines: ["hedge: ~/.config/hedge/secrets/kit/token is open to other users. Run chmod 600 ~/.config/hedge/secrets/kit/token, or save the secret again."] });
  chmodSync(join(dir, "token"), 0o600);
  renameSync(join(dir, "token"), join(home, "elsewhere"));
  symlinkSync(join(home, "elsewhere"), join(dir, "token"));
  expect(await hedge("kit", "show", "token")).toEqual({ code: 1, lines: ["hedge: ~/.config/hedge/secrets/kit/token is a link. A secret must be a file of its own: delete it and save the secret again."] });
  mkdirSync(join(dir, "folder"));
  expect(await hedge("kit", "show", "folder")).toEqual({ code: 1, lines: ["hedge: ~/.config/hedge/secrets/kit/folder is not a file. Delete it and save the secret again."] });
});

test("a secret's name cannot leave the pack's store", async () => {
  const { home, hedge } = await machine();
  expect(await hedge("kit", "save", "../escape", "value")).toEqual({ code: 1, lines: ['hedge: a secret\'s name is lowercase words joined by dashes or dots, not "../escape"'] });
  expect(existsSync(join(home, ".config/hedge/secrets/escape"))).toBe(false);
});

test("hedge run runs a service body on the context's clock, never on real time", async () => {
  const { home, hedge } = await machine();
  expect(await hedge("run", "kit/kit-ticker")).toEqual({ code: 0, lines: ["2026-11-10T08:00:00.000Z tick 1", "2026-11-10T08:01:00.000Z tick 2", "2026-11-10T08:02:00.000Z tick 3"] });
  expect(readFileSync(join(home, ".local/state/hedge/kit/ticked"), "utf8")).toBe(String(Date.parse("2026-11-10T08:03:00Z")));
});

test("a pack.ts command cannot read a setting that its pack did not declare", async () => {
  expect(await (await machine()).hedge("kit", "stray")).toEqual({ code: 1, lines: ["hedge: ctx.get names a setting that the kit pack did not declare"] });
});

test("hedge run tests a check: it exits 1 until the check passes, then 0", async () => {
  const { hedge } = await machine();
  expect((await hedge("run", "kit/kit-saved")).code).toBe(1);
  await hedge("kit", "save", "token", "value");
  expect((await hedge("run", "kit/kit-saved")).code).toBe(0);
});

test("hedge run holds a service quietly until the check it waits for passes, testing it every minute", async () => {
  const { home, hedge, whileAsleep } = await machine();
  whileAsleep(async (now) => {
    if (now >= start + 150_000) await secretStore(home, "kit").write("token", "value");
  });
  expect(await hedge("run", "kit/kit-sender")).toEqual({ code: 0, lines: ["hedge run: kit/kit-sender waits until kit-saved passes. Save the token.", "sent at 2026-11-10T08:03:00.000Z"] });
  expect(await hedge("run", "kit/kit-sender")).toEqual({ code: 0, lines: ["sent at 2026-11-10T08:03:00.000Z"] });
});

test("hedge run takes everything after the first slash as the id", async () => {
  const { hedge } = await machine();
  expect(await hedge("run", "kit/kit-saved/extra")).toEqual({ code: 2, lines: ["hedge run: your packs have no service or check kit/kit-saved/extra"] });
});

test("ctx.get names the workflow that is off when a setting only that workflow uses has no value here", async () => {
  const { hedge } = await machine(["kit"], { "kit.note": "remember" });
  expect(await hedge("kit", "note")).toEqual({ code: 1, lines: ["hedge: kit.note belongs to the Kit extra workflow, which is off. Turn it on with hedge packs --workflows kit-extra=on."] });
});

test("ctx.get asks for the value, not for an off workflow, when a workflow that is on also uses the setting", async () => {
  const kit = readFileSync(join(import.meta.dir, "fixtures/kit/pack.ts"), "utf8");
  const notes = 'hedge.workflow({ id: "kit-notes", name: "Kit notes", sentence: "The kit keeps notes.", default: true, settings: [note] });\n    const extra =';
  const variant = kit.replace('question: "Which note?" }', 'question: "Which note?", optional: true }').replace("const extra =", notes);
  const { hedge } = await machine(["kit"], {}, { "packs/kit/pack.ts": variant });
  expect(await hedge("kit", "note")).toEqual({ code: 1, lines: ["hedge: kit.note has no value. Set it with hedge set kit.note=<value>."] });
});

test("hedge run refuses an item that no pack you turned on declares", async () => {
  const { hedge } = await machine([]);
  expect(await hedge("run", "kit/kit-ticker")).toEqual({ code: 2, lines: ["hedge run: your packs have no service or check kit/kit-ticker"] });
  expect((await hedge("run", "kit")).code).toBe(2);
});

test("hedge run refuses an item that does not run on this machine, and a name that only every object has", async () => {
  const { hedge } = await machine();
  expect(await hedge("run", "kit/kit-extra-run")).toEqual({ code: 2, lines: ["hedge run: kit/kit-extra-run does not run here: workflow kit-extra is off"] });
  expect(await hedge("run", "kit/toString")).toEqual({ code: 2, lines: ["hedge run: your packs have no service or check kit/toString"] });
});

test("a pack.ts command leaves the engine's environment as it found it, also when it fails", async () => {
  const { hedge } = await machine();
  const saved = { settings: process.env.HEDGE_SETTINGS, handlers: process.env.HEDGE_HANDLERS };
  process.env.HEDGE_SETTINGS = "before";
  delete process.env.HEDGE_HANDLERS;
  try {
    expect((await hedge("kit", "env")).code).toBe(0);
    expect([process.env.HEDGE_SETTINGS, process.env.HEDGE_HANDLERS]).toEqual(["before", undefined]);
    expect(await hedge("kit", "fail")).toEqual({ code: 1, lines: ["hedge: kit failed"] });
    expect([process.env.HEDGE_SETTINGS, process.env.HEDGE_HANDLERS]).toEqual(["before", undefined]);
  } finally {
    for (const [key, value] of [["HEDGE_SETTINGS", saved.settings], ["HEDGE_HANDLERS", saved.handlers]] as const) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});

test("ctx.threads starts a T3 thread from the plan's model table, once per key", async () => {
  let launched = 0;
  const t3 = await startT3Stub({
    shell: { projects: [], threads: [] },
    environmentId: "env-1",
    rpc(tag) {
      if (tag === "projects.ensureScratch") return { projectId: "scratch" };
      if (tag === "orchestration.launchThread") return { threadId: `thread-${++launched}` };
    },
  });
  stops.push(() => t3.stop());
  const { home, hedge } = await machine();
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  cpSync(join(t3.home, ".t3/userdata/server-runtime.json"), join(home, ".t3/userdata/server-runtime.json"));
  expect((await hedge("kit", "start", "key-1")).lines).toEqual(["https://app.t3.codes/threads/env-1/thread-1"]);
  expect((await hedge("kit", "start", "key-1")).lines).toEqual(["https://app.t3.codes/threads/env-1/thread-1"]);
  expect(t3.threads).toEqual([{ id: "thread-1", title: "Kit", prompt: "Say hello.", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] } }]);
});

test("ctx.threads keeps the keys of two packs apart, so each pack gets its own thread", async () => {
  let launched = 0;
  const t3 = await startT3Stub({
    shell: { projects: [], threads: [] },
    environmentId: "env-1",
    rpc(tag) {
      if (tag === "projects.ensureScratch") return { projectId: "scratch" };
      if (tag === "orchestration.launchThread") return { threadId: `thread-${++launched}` };
    },
  });
  stops.push(() => t3.stop());
  const kin = `export default { sdk: 1, name: "kin", summary: "A second pack.", register(hedge) { hedge.command("kin", { summary: "Start", run: async ([key], ctx) => (ctx.print((await ctx.threads.start({ key, title: "Kin", prompt: "Say hi.", modelRole: "implementation" })).id), 0) }); } };\n`;
  const { home, hedge } = await machine(["kit", "kin"], {}, { "packs/kin/pack.ts": kin });
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  cpSync(join(t3.home, ".t3/userdata/server-runtime.json"), join(home, ".t3/userdata/server-runtime.json"));
  await hedge("kit", "start", "same-key");
  await hedge("kin", "same-key");
  expect(t3.threads.map((thread) => thread.title)).toEqual(["Kit", "Kin"]);
});
