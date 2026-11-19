import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import { cliFixtures, repoRoot } from "./testing/cli.ts";
import { tempDirs } from "./testing/git.ts";
import { changeLedger, readLedger } from "./reconciler/ledger.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const { profileDir, engineWithCommands } = cliFixtures(temp);

describe("hedge routing", () => {
  describe("a pack that leaves the profile", () => {
    const box = `const file = Bun.env.HOME + "/box.txt";
const [arg] = Bun.argv.slice(2);
if (arg === "on") await Bun.write(file, "on");
else if (arg === "off") (await import("node:fs")).rmSync(file, { force: true });
else process.exit((await Bun.file(file).exists()) ? 0 : 1);
`;
    function engineWithBox(word = "hedge") {
      const engine = engineWithCommands();
      cpSync(join(repoRoot, "src"), join(engine, "src"), { recursive: true });
      cpSync(join(repoRoot, "hedge"), join(engine, "hedge"));
      symlinkSync(join(repoRoot, "node_modules"), join(engine, "node_modules"));
      const base = JSON.parse(readFileSync(join(engine, "packs/base/pack.json"), "utf8"));
      writeFileSync(join(engine, "packs/base/pack.json"), JSON.stringify({ ...base, steps: [] }));
      writeFileSync(join(engine, "packs/tools/pack.json"), JSON.stringify({ schema: 1, name: "tools", summary: "tools pack.", steps: [{ id: "box", run: [word, "box", "on"], check: [word, "box", "status"], undo: [word, "box", "off"] }] }));
      writeFileSync(join(engine, "packs/tools/commands/box.ts"), box);
      return engine;
    }
    const drop = (profile: string) => {
      const file = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
      writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...file, packs: [] }));
    };
    const run = (args: string[], home: string, engine: string, env: Record<string, string> = {}): Promise<number> =>
      main(args, { home, engineRoot: engine, platform: "linux", env, print: () => {}, run: (command, stepEnv = {}) => (command[1] === join(engine, "hedge") ? run(command.slice(2), home, engine, stepEnv) : spawnStep(command, home, stepEnv)) });
    const spawnStep = (command: string[], home: string, env: Record<string, string>) => Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: { ...Bun.env, HOME: home, ...env } }).exited;

    test("has its steps undone by the next apply, through the pack's own command", async () => {
      const home = temp.make("home-");
      const engine = engineWithBox();
      const profile = profileDir(["tools"]);
      expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(true);
      drop(profile);
      expect(await run(["apply"], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(false);
      writeFileSync(join(home, "box.txt"), "by hand");
      expect(await run(["apply"], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(true);
    });

    test("has the steps of a pack from before the rename, whose commands start with fleet, undone the same way", async () => {
      const home = temp.make("home-");
      const engine = engineWithBox("fleet");
      const profile = profileDir(["tools"]);
      expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(true);
      drop(profile);
      expect(await run(["apply"], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(false);
    });

    test("doctor says what a person removes by hand, through the pack's own probe", async () => {
      const home = temp.make("home-");
      const engine = engineWithBox();
      const manifest = JSON.parse(readFileSync(join(engine, "packs/tools/pack.json"), "utf8"));
      writeFileSync(join(engine, "packs/tools/pack.json"), JSON.stringify({ ...manifest, human: [{ id: "login", say: "Log in to the box.", probe: ["hedge", "box", "status"], undo: "Log out with box logout." }] }));
      const profile = profileDir(["tools"]);
      expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
      drop(profile);
      const lines: string[] = [];
      await main(["doctor"], { home, engineRoot: engine, platform: "linux", env: {}, print: (line) => lines.push(line) });
      expect(lines.join("\n")).toContain("The tools pack is off. Log out with box logout.");
    });

    test("runs its command only for a command line of the step that the ledger names", async () => {
      const home = temp.make("home-");
      const engine = engineWithBox();
      const profile = profileDir(["tools"]);
      expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
      drop(profile);
      expect(await run(["box", "off"], home, engine)).toBe(2);
      expect(await run(["box", "off"], home, engine, { HEDGE_UNDO: "tools/other" })).toBe(2);
      expect(await run(["box", "off", "--all"], home, engine, { HEDGE_UNDO: "tools/box" })).toBe(2);
      expect(existsSync(join(home, "box.txt"))).toBe(true);
      expect(await run(["box", "status"], home, engine, { HEDGE_UNDO: "tools/box" })).toBe(0);
      expect(await run(["box", "off"], home, engine, { HEDGE_UNDO: "tools/box" })).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(false);
      expect(await run(["box", "on"], home, engine, { HEDGE_UNDO: "tools/box" })).toBe(2);
      expect(existsSync(join(home, "box.txt"))).toBe(false);
    });

    test("keeps the step to undo while Hedge cannot run its pack's command, and never runs another pack's command of that name", async () => {
      const home = temp.make("home-");
      const engine = engineWithBox();
      const profile = profileDir(["tools"]);
      expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
      writeFileSync(join(engine, "packs/rival/commands/box.ts"), `await Bun.write(Bun.env.HOME + "/rival.txt", "ran");\n`);
      const away = join(temp.make("away-"), "tools");
      renameSync(join(engine, "packs/tools"), away);
      writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8")), packs: ["rival"] }));
      expect(await run(["box", "status"], home, engine, { HEDGE_UNDO: "tools/box" })).toBe(3);
      await run(["apply"], home, engine);
      expect(existsSync(join(home, "rival.txt"))).toBe(false);
      expect(existsSync(join(home, "box.txt"))).toBe(true);
      renameSync(away, join(engine, "packs/tools"));
      drop(profile);
      expect(await run(["apply"], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(false);
    });
  });
});

describe("the library's upstream from before the Context library pack joined Memory", () => {
  const memory = JSON.parse(readFileSync(join(repoRoot, "packs/memory/pack.json"), "utf8"));
  const library = memory.workflows.find((workflow: { id: string }) => workflow.id === "context-library");
  const { roles: _, ...upstream } = memory.steps.find((step: { id: string }) => step.id === "context-upstream");
  const declaration = (home: string) => join(home, ".config/hedge/mcp-gateway/upstreams/context.json");
  const ledgerFile = (home: string) => join(home, ".local/state/hedge/steps.json");

  function engineWithLibrary() {
    const engine = engineWithCommands();
    cpSync(join(repoRoot, "src"), join(engine, "src"), { recursive: true });
    cpSync(join(repoRoot, "hedge"), join(engine, "hedge"));
    symlinkSync(join(repoRoot, "node_modules"), join(engine, "node_modules"));
    cpSync(join(repoRoot, "packs/memory"), join(engine, "packs/memory"), { recursive: true });
    for (const pack of readdirSync(join(repoRoot, "packs")).filter((name) => existsSync(join(repoRoot, "packs", name, "lib")) && !existsSync(join(engine, "packs", name, "lib")))) cpSync(join(repoRoot, "packs", pack, "lib"), join(engine, "packs", pack, "lib"), { recursive: true });
    const base = JSON.parse(readFileSync(join(engine, "packs/base/pack.json"), "utf8"));
    writeFileSync(join(engine, "packs/base/pack.json"), JSON.stringify({ ...base, steps: [] }));
    const settings = memory.settings.filter((setting: { key: string }) => library.settings.includes(setting.key));
    writeFileSync(join(engine, "packs/memory/pack.json"), JSON.stringify({ schema: 1, name: "memory", summary: memory.summary, aliases: memory.aliases, settings, workflows: [library], steps: [upstream] }));
    return engine;
  }

  const launcherEnv = (home: string, extra: Record<string, string> = {}) => ({ ...Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !/^(HEDGE|FLEET)_/.test(key))), HOME: home, ...extra });

  async function upgraded(packs: string[], workflows: Record<string, boolean> = {}) {
    const home = temp.make("home-");
    const engine = engineWithLibrary();
    const profile = profileDir(packs);
    const settings = { "context-library.repo": "me/notes", "context-library.path": join(home, "notes") };
    writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8")), settings, workflows }));
    const installed = Bun.spawn(["bun", join(engine, "packs/memory/commands/context.ts"), "upstream", "install"], { stdout: "ignore", env: launcherEnv(home, { HEDGE_SETTINGS: JSON.stringify({ ...settings, "context-library.url": "", "context-library.owner": "" }) }) });
    expect(await installed.exited).toBe(0);
    const current = JSON.parse(readFileSync(declaration(home), "utf8"));
    writeFileSync(declaration(home), JSON.stringify({ ...current, script: join(engine, "packs/context-library/mcp/main.ts") }, null, 2));
    await changeLedger(home, "steps", "context-library/context-upstream", { pack: "context-library", id: upstream.id, check: upstream.check, undo: upstream.undo });
    const hedge = async (args: string[]) => {
      const child = Bun.spawn(["sh", join(engine, "hedge"), ...args, "--profile", profile], { stdout: "pipe", stderr: "pipe", env: launcherEnv(home) });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, output: stdout + stderr };
    };
    return { home, hedge };
  }

  test("a dry run and doctor after the library left the profile name its removal once, through the nested probe, also beside an entry under the new name, and the next apply removes it", async () => {
    const { home, hedge } = await upgraded([]);
    const previews = async () => {
      const before = readFileSync(ledgerFile(home), "utf8");
      const preview = await hedge(["apply", "--dry-run"]);
      expect(preview.output.split("\n").filter((line) => line.includes("step memory/context-upstream"))).toEqual(["remove step memory/context-upstream"]);
      const doctor = await hedge(["doctor"]);
      expect(doctor.output.split("\n").filter((line) => line.includes("context-upstream"))).toEqual(["Fix: The memory pack is off, but step context-upstream of the memory pack still holds what it set. Run hedge apply to undo it."]);
      expect(existsSync(declaration(home))).toBe(true);
      expect(readFileSync(ledgerFile(home), "utf8")).toBe(before);
    };
    await previews();
    await changeLedger(home, "steps", "memory/context-upstream", { pack: "memory", id: upstream.id, check: upstream.check, undo: upstream.undo });
    await previews();
    expect((await hedge(["apply"])).code).toBe(0);
    expect(existsSync(declaration(home))).toBe(false);
    expect((await readLedger(home)).steps).toEqual([]);
  });

  test("a declaration from before the upgrade is removed once the library is turned off, while its settings still load", async () => {
    const { home, hedge } = await upgraded(["context-library"], { "context-library": false });
    const doctor = await hedge(["doctor"]);
    expect(doctor.output.split("\n").filter((line) => line.includes("context-upstream"))).toEqual(["Fix: The workflow context-library is off, but step context-upstream of the memory pack still holds what it set. Run hedge apply to undo it."]);
    expect((await hedge(["apply"])).code).toBe(0);
    expect(existsSync(declaration(home))).toBe(false);
    expect((await readLedger(home)).steps).toEqual([]);
  });

  test("a declaration removed by hand clears its entry at the next apply", async () => {
    const { home, hedge } = await upgraded(["context-library"], { "context-library": false });
    rmSync(declaration(home));
    const applied = await hedge(["apply"]);
    expect(applied.code).toBe(0);
    expect(applied.output).not.toContain("context-upstream");
    expect((await readLedger(home)).steps).toEqual([]);
  });

  test("a replacement declaration that names another server is kept, and its entry clears at the next apply", async () => {
    const { home, hedge } = await upgraded(["context-library"], { "context-library": false });
    const replacement = JSON.stringify({ ...JSON.parse(readFileSync(declaration(home), "utf8")), name: "notes", title: "Notes" });
    writeFileSync(declaration(home), replacement);
    const applied = await hedge(["apply"]);
    expect(applied.code).toBe(0);
    expect(applied.output).not.toContain("context-upstream");
    expect(readFileSync(declaration(home), "utf8")).toBe(replacement);
    expect((await readLedger(home)).steps).toEqual([]);
  });

  for (const content of ["{", "{}"]) {
    test(`a declaration Hedge cannot read as an upstream (${content}) stays and is reported again by a second apply`, async () => {
      const { home, hedge } = await upgraded(["context-library"], { "context-library": false });
      writeFileSync(declaration(home), content);
      for (const _ of [1, 2]) {
        const applied = await hedge(["apply"]);
        expect(applied.output).toContain("Hedge cannot tell whether step context-upstream of the memory pack still holds what it set, though its workflow context-library is off.");
        expect(readFileSync(declaration(home), "utf8")).toBe(content);
      }
    });
  }
});
