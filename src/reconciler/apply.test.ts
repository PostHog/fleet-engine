import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { providerConfigAdapter } from "../adapters/provider-config/adapter.ts";
import { apply, check, filesAdapter, type Adapter } from "./apply.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    machine: { schema: 1, role: "linux" },
    os: "linux",
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [{ target: ".agents/AGENTS.md", content: "rules\n" }],
    config: [],
    owners: {},
    jobs: [],
    human: [],
    steps: [],
    checks: [],
    commands: {},
    handlers: {},
    models: [],
    settings: {},
    unanswered: [],
    ask: [],
    dropped: [],
    ...overrides,
  };
}

const exitCodes = (codes: Record<string, number>) => async (command: string[]) => codes[command.join(" ")] ?? 0;

describe("apply", () => {
  test("a step from before the rename that writes to FLEET_PROFILE_DIR writes to the profile this run applies, even when the shell still names an old one", async () => {
    const home = temp.make("home-");
    const [old, current] = [temp.make("old-profile-"), temp.make("profile-")];
    const saved = process.env.FLEET_PROFILE_DIR;
    process.env.FLEET_PROFILE_DIR = old;
    try {
      await apply(plan({ machine: { schema: 1, role: "linux", profileDir: current }, steps: [{ id: "mark", pack: "team", run: ["/bin/sh", "-c", 'touch "$FLEET_PROFILE_DIR/marked"'] }] }), { home, adapters: [] });
    } finally {
      if (saved === undefined) delete process.env.FLEET_PROFILE_DIR;
      else process.env.FLEET_PROFILE_DIR = saved;
    }
    expect(existsSync(join(old, "marked"))).toBe(false);
    expect(existsSync(join(current, "marked"))).toBe(true);
  });

  test("refuses to write while a setting is unanswered", async () => {
    const home = temp.make("home-");
    const report = await apply(plan({ unanswered: [{ key: "orchestration.tracker", question: "Which repo holds your maps?", type: "string" }] }), { home });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({ id: "unanswered:orchestration.tracker", pack: "orchestration", say: "Which repo holds your maps? Answer it with hedge set orchestration.tracker=<value>.", repair: "human" });
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("keeps the last applied files while a pack's source is unreachable", async () => {
    const home = temp.make("home-");
    const team = { target: ".agents/skills/team", content: "team skill\n" };
    await apply(plan({ files: [plan().files[0]!, team] }), { home });
    const offline = plan({ packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] });
    const report = await apply(offline, { home });
    expect(readFileSync(join(home, ".agents/skills/team"), "utf8")).toBe("team skill\n");
    expect(report.findings).toContainEqual({ id: "pack:team", pack: "team", say: "The team pack is not applied: not found; unreachable sources: team" });
    expect((await apply(plan(), { home })).actions).toContainEqual({ target: ".agents/skills/team", operation: "remove" });
  });

  test("--adopt-from keeps the other setup's claim while an outage keeps its file", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents/AGENTS.md"), "old rules\n");
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    const state = JSON.stringify({ version: 1, groups: { core: { ".agents/AGENTS.md": { kind: "file", hash: "0".repeat(64) } } } });
    writeFileSync(join(home, ".local/state/hedge/state.json"), state);
    const offline = plan({ packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] });
    await expect(apply(offline, { home, adoptFrom: ["core"] })).rejects.toThrow("Run hedge apply --adopt-from core again once it can apply .agents/AGENTS.md.");
    expect(readFileSync(join(home, ".local/state/hedge/state.json"), "utf8")).toBe(state);
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toBe("old rules\n");
  });

  test("--adopt-from keeps the other setup's claim while an outage keeps a file in its linked folder", async () => {
    const home = temp.make("home-");
    const outside = temp.make("outside-");
    writeFileSync(join(outside, "other.md"), "theirs\n");
    symlinkSync(outside, join(home, "guides"));
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    const state = JSON.stringify({ version: 1, groups: { core: { "guides/other.md": { kind: "file", hash: "0".repeat(64) } } } });
    writeFileSync(join(home, ".local/state/hedge/state.json"), state);
    const inside = plan({ files: [{ target: "guides/new.md", content: "new\n" }] });
    const offline = { ...inside, packs: [...inside.packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    await expect(apply(offline, { home, adoptFrom: ["core"] })).rejects.toThrow("Run hedge apply --adopt-from core again once it can apply guides/new.md.");
    expect(readFileSync(join(home, ".local/state/hedge/state.json"), "utf8")).toBe(state);
    expect(lstatSync(join(home, "guides")).isSymbolicLink()).toBe(true);
  });

  test("keeps Hedge's own folder link while an outage keeps the file it now writes inside it", async () => {
    const home = temp.make("home-");
    const guides = temp.make("guides-");
    await apply(plan({ files: [{ target: "guides", source: guides }] }), { home });
    const inside = plan({ files: [{ target: "guides/new.md", content: "new\n" }] });
    const offline = { ...inside, packs: [...inside.packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    await apply(offline, { home });
    expect(lstatSync(join(home, "guides")).isSymbolicLink()).toBe(true);
    await apply(inside, { home });
    expect(readFileSync(join(home, "guides/new.md"), "utf8")).toBe("new\n");
  });

  test("keeps skills whose source is unreachable, and shared files that would lose an unreachable pack's part", async () => {
    const home = temp.make("home-");
    const skill = temp.make("skill-");
    const rules = { target: ".agents/AGENTS.md", content: "rules\nteam rules\n" };
    const link = { target: ".agents/skills/team", source: skill };
    await apply(plan({ files: [rules, link] }), { home });
    rmSync(skill, { recursive: true });
    const offline = plan({
      packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }],
      dropped: [{ pack: "base", item: "skill team:review", reason: "its source is unreachable" }],
    });
    const report = await apply(offline, { home });
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toBe("rules\nteam rules\n");
    expect(lstatSync(join(home, ".agents/skills/team")).isSymbolicLink()).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ id: "outage", say: expect.stringContaining("Left .agents/AGENTS.md, .agents/skills/team as they are") }));
    const back = await apply(plan(), { home });
    expect(back.actions).toContainEqual({ target: ".agents/AGENTS.md", operation: "replace" });
    expect(back.actions).toContainEqual({ target: ".agents/skills/team", operation: "remove" });
  });

  test("routes --adopt to the adapter that owns the target and rejects unknown targets", async () => {
    const home = temp.make("home-");
    const seen: string[][] = [];
    const config: Adapter = { name: "config", targets: () => [".claude/settings.json"], apply: async (_plan, context) => (seen.push(context.adopt), { actions: [], findings: [] }) };
    const report = await apply(plan(), { home, adopt: [".claude/settings.json"], adapters: [filesAdapter, config] });
    expect(report.ok).toBe(true);
    expect(seen).toEqual([[".claude/settings.json"]]);
    expect(apply(plan(), { home, adopt: [".bashrc"] })).rejects.toThrow("nothing to adopt at .bashrc");
  });

  test("skips the rest of the failing pack when a pack step fails, and fails apply whatever the pack", async () => {
    const steps = [
      { id: "a", run: ["one"], pack: "hub" },
      { id: "b", run: ["two"], pack: "hub" },
      { id: "c", run: ["three"], pack: "posthog" },
    ];
    const ran: string[] = [];
    const report = await apply(plan({ steps }), { home: temp.make("home-"), run: async (command) => (ran.push(command[0]!), command[0] === "one" ? 1 : 0) });
    expect(ran).toEqual(["one", "three"]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ id: "step:a", pack: "hub", say: "Step a of the hub pack failed.", repair: "apply" }]);
  });

  test("fails apply when a check that Hedge repairs still fails after its repair, but not when it waits for a person", async () => {
    const gateway = { id: "gateway", say: "The gateway is not installed.", probe: ["gateway-installed"], repair: ["gateway-installed", "--repair"], pack: "hub" };
    const signIn = { id: "sign-in", say: "Sign in.", command: "service login", probe: ["signed-in"], pack: "hub" };
    const broken = await apply(plan({ human: [gateway] }), { home: temp.make("home-"), run: exitCodes({ "gateway-installed": 1, "gateway-installed --repair": 1 }) });
    const waiting = await apply(plan({ human: [signIn] }), { home: temp.make("home-"), run: exitCodes({ "signed-in": 1 }) });
    expect([broken.ok, broken.findings]).toEqual([false, [{ id: "human:gateway", pack: "hub", say: "The gateway is not installed.", repair: "human" }]]);
    expect(waiting.ok).toBe(true);
  });

  test("skips a step whose check already passes", async () => {
    const steps = [
      { id: "cli", run: ["install-cli"], check: ["cli-version"], pack: "base" },
      { id: "fresh", run: ["install-fresh"], check: ["fresh-version"], pack: "base" },
    ];
    const ran: string[] = [];
    const run = async (command: string[]) => (ran.push(command[0]!), command[0] === "fresh-version" ? 1 : 0);
    await apply(plan({ steps }), { home: temp.make("home-"), run });
    expect(ran).toEqual(["cli-version", "fresh-version", "install-fresh", "fresh-version"]);
  });

  test("reports a step whose run exits 0 but whose check still fails, and fails the apply", async () => {
    const steps = [
      { id: "codex-cli", run: ["install-codex"], check: ["codex", "--version"], pack: "base" },
      { id: "after", run: ["install-after"], pack: "base" },
    ];
    const ran: string[] = [];
    const report = await apply(plan({ steps }), { home: temp.make("home-"), run: async (command) => (ran.push(command[0]!), command[0] === "codex" ? 127 : 0) });
    expect(ran).toEqual(["codex", "install-codex", "codex"]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ id: "step:codex-cli", pack: "base", say: "Step codex-cli of the base pack ran, but does not pass its check.", repair: "apply" }]);
  });

  test("a step that waits for a sign-in runs only once its probe passes, and doctor does not report it", async () => {
    const human = [{ id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"], pack: "team" }];
    const steps = [{ id: "devbox", run: ["devbox-start"], check: ["devbox-status"], after: "coder", pack: "team" }];
    const ran: string[] = [];
    const signedOut = async (command: string[]) => (ran.push(command[0]!), 1);
    const report = await apply(plan({ human, steps }), { home: temp.make("home-"), run: signedOut });
    expect(ran).toEqual(["coder"]);
    expect(report.findings).toEqual([]);
    const doctor = await check(plan({ human, steps }), { home: temp.make("home-"), run: signedOut });
    expect(doctor.findings.map((finding) => finding.id).filter((id) => !id.startsWith("files:"))).toEqual(["human:coder"]);
    ran.length = 0;
    await apply(plan({ human, steps }), { home: temp.make("home-"), run: async (command) => (ran.push(command[0]!), command[0] === "devbox-status" ? 1 : 0) });
    expect(ran).toEqual(["coder", "devbox-status", "devbox-start", "devbox-status"]);
  });

  test("a sign-in is probed when its first waiting step comes up, after the steps before it ran", async () => {
    const human = [{ id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"], pack: "team" }];
    const steps = [
      { id: "install-coder", run: ["install-coder"], check: ["coder-installed"], pack: "team" },
      { id: "devbox", run: ["devbox-start"], after: "coder", pack: "team" },
    ];
    let installed = false;
    const ran: string[] = [];
    const run = async (command: string[]) => {
      ran.push(command[0]!);
      if (command[0] === "install-coder") installed = true;
      if (command[0] === "coder-installed") return installed ? 0 : 1;
      if (command[0] === "coder") return installed ? 0 : 127;
      return 0;
    };
    await apply(plan({ human, steps }), { home: temp.make("home-"), run });
    expect(ran).toEqual(["coder-installed", "install-coder", "coder-installed", "coder", "devbox-start"]);
  });

  test("runs steps with the plan's home directory as HOME", async () => {
    const home = temp.make("home-");
    const steps = [{ id: "mark", run: ["sh", "-c", 'touch "$HOME/marked"'], check: ["sh", "-c", 'test -f "$HOME/marked"'], pack: "base" }];
    const report = await apply(plan({ steps }), { home });
    expect(report.findings).toEqual([]);
    expect(existsSync(join(home, "marked"))).toBe(true);
  });
});

describe("a config entry that waits for a pack check", () => {
  const checks = [{ id: "proxy-up", run: ["proxy-check"], say: "The proxy is down.", pack: "base" }];
  const config = [
    { provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", after: "proxy-up", pack: "base" },
    { provider: "claude" as const, key: "apiKeyHelper", value: "cat key", after: "proxy-up", pack: "base" },
  ];
  const proxy = (up: () => boolean) => async (command: string[]) => (command.join(" ") === "proxy-check" ? (up() ? 0 : 1) : 0);
  const settings = (home: string) => (existsSync(join(home, ".claude/settings.json")) ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : undefined);
  const down = { id: "check:proxy-up", pack: "base", say: "The proxy is down.", repair: "apply" as const };

  test("is written while its check passes, removed while it fails, and apply names the failed check", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "opus" }));
    let up = true;
    const options = { home, adapters: [providerConfigAdapter()], run: proxy(() => up) };
    expect((await apply(plan({ files: [], checks, config }), options)).findings).toEqual([]);
    expect(settings(home)).toEqual({ model: "opus", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: "cat key" });
    up = false;
    const failed = await apply(plan({ files: [], checks, config }), options);
    expect(failed.ok).toBe(true);
    expect(failed.findings).toEqual([down]);
    expect(settings(home)).toEqual({ model: "opus" });
    expect((await apply(plan({ files: [], checks, config }), options)).actions).toEqual([]);
    up = true;
    await apply(plan({ files: [], checks, config }), options);
    expect(settings(home)).toEqual({ model: "opus", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: "cat key" });
  });

  test("doctor changes nothing, reports the failed check once, and fails", async () => {
    const home = temp.make("home-");
    await apply(plan({ files: [], checks, config }), { home, adapters: [providerConfigAdapter()], run: proxy(() => true) });
    let probes = 0;
    const flaky = async (command: string[]) => (command.join(" ") === "proxy-check" ? (probes++ === 0 ? 1 : 0) : 0);
    const report = await check(plan({ files: [], checks, config }), { home, adapters: [providerConfigAdapter()], run: flaky });
    expect(report.ok).toBe(false);
    expect(report.findings.filter((finding) => finding.id === down.id)).toEqual([down]);
    expect(settings(home)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: "cat key" });
  });
});

describe("a pack check that waits for the person", () => {
  const checks = [{ id: "pool", run: ["pool-check"], say: "Hedge cannot read the pool.", todo: "Add an account to the pool.", pack: "base" }];
  const config = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", after: "pool", pack: "base" }];
  const waiting = { id: "check:pool", pack: "base", say: "Add an account to the pool.", todo: true as const };
  const settings = (home: string) => (existsSync(join(home, ".claude/settings.json")) ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : undefined);

  test("keeps the config that waits for it out, and apply and doctor say it as a To do that fails nothing", async () => {
    const home = temp.make("home-");
    const options = { home, adapters: [providerConfigAdapter()], run: exitCodes({ "pool-check": 4 }) };
    const applied = await apply(plan({ files: [], checks, config }), options);
    expect(applied.ok).toBe(true);
    expect(applied.findings).toEqual([waiting]);
    expect(settings(home)).toBeUndefined();
    const doctor = await check(plan({ files: [], checks, config }), options);
    expect(doctor.ok).toBe(true);
    expect(doctor.findings).toEqual([waiting]);
  });

  const installedPool = () => {
    let installed = false;
    let code = 4;
    const run = async (command: string[]) => {
      const words = command.join(" ");
      if (words === "install-pool") installed = true;
      if (words === "pool-installed") return installed ? 0 : 1;
      return words === "pool-check" ? (installed ? code : 1) : 0;
    };
    return { run, set: (next: number) => (code = next) };
  };
  const steps = [{ id: "install-pool", run: ["install-pool"], check: ["pool-installed"], pack: "base" }];

  test("that nothing waits for runs after the steps, so it reads what a step installed, and apply names only its To do", async () => {
    const { run, set } = installedPool();
    const home = temp.make("home-");
    expect(await apply(plan({ files: [], checks, steps }), { home, run })).toMatchObject({ ok: true, findings: [waiting] });
    set(1);
    expect(await apply(plan({ files: [], checks, steps }), { home, run })).toMatchObject({ ok: true, findings: [] });
    expect(await check(plan({ files: [], checks, steps }), { home, run })).toMatchObject({ ok: false, findings: [{ id: "check:pool", pack: "base", say: "Hedge cannot read the pool.", repair: "apply" }] });
    set(0);
    expect(await apply(plan({ files: [], checks, steps }), { home, run })).toMatchObject({ ok: true, findings: [] });
  });

  test("that config waits for and that fails before a step installs what it reads becomes a To do once the step ran, and the config stays out", async () => {
    const { run } = installedPool();
    const home = temp.make("home-");
    const applied = await apply(plan({ files: [], checks, steps, config }), { home, adapters: [providerConfigAdapter()], run });
    expect(applied).toMatchObject({ ok: true, findings: [waiting] });
    expect(settings(home)).toBeUndefined();
  });

  test("a check without a todo that exits 4 is a Fix, and a check with one stays a Fix for any other failing code", async () => {
    const home = temp.make("home-");
    const plain = [{ ...checks[0]!, todo: undefined }];
    expect((await check(plan({ files: [], checks: plain }), { home, run: exitCodes({ "pool-check": 4 }) })).findings).toEqual([{ id: "check:pool", pack: "base", say: "Hedge cannot read the pool.", repair: "apply" }]);
    expect((await check(plan({ files: [], checks, config }), { home, adapters: [providerConfigAdapter()], run: exitCodes({ "pool-check": 1 }) })).ok).toBe(false);
  });
});

describe("check", () => {
  test("runs pack checks and human probes, and lists the human steps left", async () => {
    const human = [{ id: "github", say: "Sign in to GitHub.", command: "gh auth login --web", probe: ["gh", "auth", "status"], pack: "base" }];
    const checks = [{ id: "disk", run: ["df-check"], say: "Free some disk space.", pack: "base" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ human, checks }), { home, run: exitCodes({ "gh auth status": 1, "df-check": 0 }) });
    expect(report.ok).toBe(false);
    expect(report.humanLeft.map((step) => step.id)).toEqual(["github"]);
    expect(report.findings).toEqual([{ id: "human:github", pack: "base", say: "Sign in to GitHub. Run: gh auth login --web", repair: "human" }]);
  });

  test("names a failing check that Hedge can repair as a Fix for apply, even when nothing waits for it", async () => {
    const human = [{ id: "gateway", say: "The gateway is not installed.", probe: ["gateway-installed"], repair: ["gateway-installed", "--repair"], pack: "hub" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ human }), { home, run: exitCodes({ "gateway-installed": 1 }) });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ id: "human:gateway", pack: "hub", say: "The gateway is not installed.", repair: "apply" }]);
  });

  test("keeps a failing check as a To do when its fix still needs a person's command, even with a Hedge repair", async () => {
    const human = [{ id: "service", say: "Sign in to the service.", command: "service login", interactive: true as const, probe: ["service-ready"], repair: ["service-ready", "--repair"], pack: "base" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ human }), { home, run: exitCodes({ "service-ready": 1 }) });
    expect(report.findings).toEqual([{ id: "human:service", pack: "base", say: "Sign in to the service. Run: service login", repair: "human" }]);
  });

  test("runs each step's check", async () => {
    const steps = [{ id: "proxy", run: ["start-proxy"], check: ["proxy-health"], pack: "base" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ steps }), { home, run: exitCodes({ "proxy-health": 1 }) });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({ id: "step:proxy", pack: "base", say: "Step proxy of the base pack does not pass its check.", repair: "apply" });
  });

  test("fails while a kept file differs from the profile", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents/AGENTS.md"), "mine\n");
    const report = await check(plan(), { home, run: exitCodes({}) });
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.id)).toEqual(["kept:.agents/AGENTS.md"]);
  });
});

describe("a leading hedge in a pack's commands", () => {
  const launcher = ["/bin/sh", "/engine/hedge"];
  const team = {
    engineRoot: "/engine",
    files: [],
    human: [{ id: "login", pack: "team", say: "Sign in.", command: "hedge login", probe: ["hedge", "whoami"] }],
    steps: [{ id: "start", pack: "team", run: ["hedge", "start"], check: ["hedge", "status"], after: "login" }],
    checks: [{ id: "healthy", pack: "team", run: ["hedge", "health"], say: "Unhealthy." }],
  };
  const recorder = (codes: Record<string, number> = {}) => {
    const calls: string[] = [];
    return { calls, run: async (command: string[]) => (calls.push(command.join(" ")), codes[command.join(" ")] ?? 0) };
  };

  test("runs this engine's launcher in apply", async () => {
    const { calls, run } = recorder({ "/bin/sh /engine/hedge status": 1 });
    await apply(plan(team), { home: temp.make("home-"), run });
    expect(calls).toEqual([[...launcher, "whoami"], [...launcher, "status"], [...launcher, "start"], [...launcher, "status"]].map((command) => command.join(" ")));
  });

  test("runs this engine's launcher in check", async () => {
    const { calls, run } = recorder();
    await check(plan(team), { home: temp.make("home-"), run });
    expect(calls).toEqual([[...launcher, "health"], [...launcher, "whoami"], [...launcher, "status"], [...launcher, "whoami"]].map((command) => command.join(" ")));
  });

  test("leaves other commands and a plan without an engine as they are", async () => {
    const { calls, run } = recorder();
    await check(plan({ ...team, engineRoot: undefined, checks: [{ id: "gh", pack: "team", run: ["gh", "hedge"], say: "No gh." }] }), { home: temp.make("home-"), run });
    expect(calls).toEqual(["gh hedge", "hedge whoami", "hedge status", "hedge whoami"]);
  });
});
