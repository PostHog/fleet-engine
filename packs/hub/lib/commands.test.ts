import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { hedgeMachine, runHedge } from "../../orchestration/lib/testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const answered = { "hub.alias": "my-hub", "hub.coderUrl": "https://coder.example.com", "hub.boxTemplate": "linux-box" };

async function hubProfile(workflows: Record<string, boolean> = { boxes: true }, settings: Record<string, string> = answered, packs = ["hub", "posthog"]) {
  const home = temp.make("hedge-hub-cli-");
  const profile = await hedgeMachine(home, settings);
  const hedge = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
  const team = join(home, ".local/share/hedge/sources/team");
  mkdirSync(join(team, ".git"), { recursive: true });
  mkdirSync(join(team, "packs/posthog"), { recursive: true });
  writeFileSync(join(team, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "A team pack that brings Coder." }));
  const sources = [...hedge.sources, { name: "team", repo: "example/team-packs", ref: "main" }];
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...hedge, sources, packs, workflows, devboxes: ["devbox-2"] }));
  return home;
}

test("through hedge, sweep refuses on a machine that is not the hub", async () => {
  const home = await hubProfile();
  const refused = await runHedge(["box", "sweep"], { HOME: home });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("hedge box sweep runs only on the hub. This machine's role is linux. Run hedge hub here on the hub");
});

test("through hedge, box says how to turn Boxes on to use or release boxes while the workflow is off", async () => {
  const home = await hubProfile({});
  const refused = await runHedge(["box", "release", "box-1", "--delete"], { HOME: home });
  expect(refused).toMatchObject({ code: 1, stderr: "hedge box: Boxes is off. To use boxes, or to release boxes that still run, turn it on with hedge packs --workflows boxes=on, then run hedge apply.\n" });
});

const notReady = "hedge box: Boxes is on, but not ready here. It needs a team pack that brings Coder, and its settings answered: hedge apply names each unanswered setting.\n";

test("through hedge, box says Boxes is not ready, not off, while the workflow is on and its box template is unanswered", async () => {
  const { "hub.boxTemplate": _, ...unanswered } = answered;
  const home = await hubProfile({ boxes: true }, unanswered);
  const refused = await runHedge(["box", "list"], { HOME: home });
  expect(refused).toMatchObject({ code: 1, stderr: notReady });
});

test("through hedge, box says Boxes needs a pack that brings Coder while the workflow is on and no pack brings it", async () => {
  const home = await hubProfile({ boxes: true }, answered, ["hub"]);
  const refused = await runHedge(["box", "list"], { HOME: home });
  expect(refused).toMatchObject({ code: 1, stderr: notReady });
});

test("through hedge, dream refuses without the Memory pack, and dream digest prints this machine's sessions without their tokens", async () => {
  const home = await hubProfile();
  const refused = await runHedge(["dream", "budget"], { HOME: home });
  expect(refused).toMatchObject({ code: 1, stderr: "Dream needs the Memory pack: turn it on, then run hedge apply\n" });
  const token = `ghp_${"a1".repeat(18)}`;
  const project = join(home, ".claude/projects/-dev-app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "s-1.jsonl"), JSON.stringify({ type: "user", sessionId: "s-1", cwd: join(home, "dev/app"), timestamp: new Date().toISOString(), message: { role: "user", content: `Use this token: ${token}` } }));
  const digest = await runHedge(["dream", "digest", "--since", "1d"], { HOME: home, XDG_STATE_HOME: join(home, ".local/state") });
  expect(digest.code).toBe(0);
  expect(digest.stdout).toContain("[redacted GitHub token]");
  expect(digest.stdout).not.toContain(token);
  expect(JSON.parse(digest.stdout).repo).toBe("app");
});

test("through hedge, disk-watch refuses off the hub, and disk-sweep checks its arguments", async () => {
  const home = await hubProfile();
  const watch = await runHedge(["disk-watch"], { HOME: home });
  expect([watch.code, watch.stderr]).toEqual([1, "hedge disk-watch: hedge disk-watch runs only on the hub. This machine's role is linux. Run hedge hub here on the hub, or run this there.\n"]);
  const sweep = await runHedge(["disk-sweep", "--all"], { HOME: home });
  expect([sweep.code, sweep.stderr]).toEqual([1, "hedge disk-sweep: Usage: hedge disk-sweep [--dry-run] [--floor <gigabytes>] [--alert-floor <gigabytes>]\n"]);
});

test("through hedge, the hub pack's undo probe runs after the pack leaves the profile, for the step the ledger names, without its settings", async () => {
  const home = temp.make("hedge-hub-undo-");
  await hedgeMachine(home, {});
  mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
  const step = { pack: "hub", id: "hub-https", check: ["hedge", "hub-https", "left"], undo: ["hedge", "hub-https", "remove"] };
  const peers = { pack: "hub", id: "peers", check: ["hedge", "peers", "left"], undo: ["hedge", "peers", "remove"] };
  writeFileSync(join(home, ".local/state/hedge/steps.json"), JSON.stringify({ version: 1, steps: [step, peers] }));
  expect((await runHedge(["hub-https", "left"], { HOME: home })).code).toBe(2);
  expect((await runHedge(["hub-https", "left"], { HOME: home, HEDGE_UNDO: "hub/hub-https" })).code).toBe(1);
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(join(home, ".config/systemd/user/hedge-hub-https.service"), "# Managed by Hedge hub HTTPS.\n[Unit]\n");
  expect((await runHedge(["hub-https", "left"], { HOME: home, HEDGE_UNDO: "hub/hub-https" })).code).toBe(0);
  writeFileSync(join(home, ".config/systemd/user/hedge-hub-https.service"), "[Unit]\n");
  expect((await runHedge(["hub-https", "left"], { HOME: home, HEDGE_UNDO: "hub/hub-https" })).code).toBe(3);
  expect((await runHedge(["peers", "left"], { HOME: home, HEDGE_UNDO: "hub/peers" })).code).toBe(1);
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/hedge-peers.conf"), "# Managed by Hedge peer access.\n");
  expect((await runHedge(["peers", "left"], { HOME: home, HEDGE_UNDO: "hub/peers" })).code).toBe(0);
  expect((await runHedge(["peers", "remove"], { HOME: home, HEDGE_UNDO: "hub/peers" })).code).toBe(0);
  expect(existsSync(join(home, ".ssh/hedge-peers.conf"))).toBe(false);
});
