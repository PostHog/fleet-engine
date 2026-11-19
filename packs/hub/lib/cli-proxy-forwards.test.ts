import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { tempDirs } from "../../../src/testing/git.ts";
import { cliProxy, keyHelper, proxyUrl, type ProxyMachine } from "./cli-proxy.ts";
import { balancingPlan, hedgeApply } from "./cli-proxy-testing.ts";
import hubPack from "../pack.json";
import { handOver, hubForward } from "./links.ts";
import { roleHome } from "./run-testing.ts";
import { proxyOn, readBoxSettings, remoteHedge } from "./machine.ts";
import { boxSettings, fakeCoder, fakeMachine, ok, writeHome } from "./testing.ts";
import { tunnelUnit } from "./tunnels.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const clientKey = "c1".repeat(32);
const balancing = readBoxSettings({ HEDGE_SETTINGS: JSON.stringify({ ...boxSettings, "hub.proxyAccounts": 2 }) });
const proxyRoute = "'-R' '8317:127.0.0.1:8317'";

test("the proxy is on for hedge commands only while Own-account balancing is on, which hands them hub.proxyAccounts", () => {
  expect(proxyOn({ HEDGE_SETTINGS: JSON.stringify(boxSettings) })).toBe(false);
  expect(proxyOn({ HEDGE_SETTINGS: JSON.stringify({ ...boxSettings, "hub.proxyAccounts": 2 }) })).toBe(true);
  expect(balancing.proxy).toBe(true);
  expect(readBoxSettings({ HEDGE_SETTINGS: JSON.stringify(boxSettings) }).proxy).toBeUndefined();
});

test("a devbox tunnel carries the proxy port only while the workflow is on", () => {
  expect(tunnelUnit("devbox-1", 60002)).not.toContain("8317");
  const unit = tunnelUnit("devbox-1", 60002, true);
  expect(unit).toContain("-R 127.0.0.1:8317:127.0.0.1:8317");
  expect([...unit.matchAll(/ -R /g)]).toHaveLength(2);
});

test("a box's hub forward carries the proxy port only while the workflow is on", () => {
  const off = fakeMachine(temp.make("hedge-box-")).machine;
  expect(hubForward(off, "box-lane").map((arg) => `'${arg}'`).join(" ")).not.toContain("8317");
  const on = fakeMachine(temp.make("hedge-box-"), { settings: balancing }).machine;
  expect(hubForward(on, "box-lane").map((arg) => `'${arg}'`).join(" ")).toContain(proxyRoute);
});

test("handing over connects a box to the proxy with the key on stdin only, under umask 077, and skips it while the workflow is off", async () => {
  const home = temp.make("hedge-box-");
  writeHome(home, { ".config/hedge/cli-proxy.key": `${clientKey}\n` });
  const on = fakeMachine(home, { settings: balancing, run: async () => ({ ...ok, code: 1 }) });
  const sent = fakeCoder();
  await handOver(sent.coder, on.machine, "box-lane");
  const connect = sent.calls.find((call) => call.command.includes("cli-proxy connect"));
  expect(connect?.stdin).toBe(`${clientKey}\n`);
  expect(connect?.command).toContain("umask 077");
  expect(sent.calls.map((call) => call.command).join("\n")).not.toContain(clientKey);

  const off = fakeMachine(home, { run: async () => ({ ...ok, code: 1 }) });
  const skipped = fakeCoder();
  await handOver(skipped.coder, off.machine, "box-lane");
  expect(skipped.calls.some((call) => call.command.includes("cli-proxy"))).toBe(false);
});

test("a box that cannot reach the proxy yet keeps its own sign-in, the hub names the command that hands over the same key again, and the handover goes on", async () => {
  const on = fakeMachine(temp.make("hedge-box-"), { settings: balancing, run: async () => ({ ...ok, code: 1 }) });
  writeHome(on.machine.home, { ".config/hedge/cli-proxy.key": `${clientKey}\n` });
  const { coder } = fakeCoder({ ssh: async (_box, command) => ({ ...ok, code: command.includes("cli-proxy connect") ? 1 : 0, stderr: "The proxy does not answer." }) });
  await handOver(coder, on.machine, "box-lane");
  expect(on.lines).toContain("box-lane keeps its own sign-in: hedge cli-proxy connect exited 1 there. To see why and hand over the same key again, run on the hub: hedge box run box-lane -- hedge cli-proxy connect < ~/.config/hedge/cli-proxy.key");

  const none = fakeMachine(temp.make("hedge-box-"), { settings: balancing, run: async () => ({ ...ok, code: 1 }) });
  await handOver(fakeCoder().coder, none.machine, "box-lane");
  expect(none.lines).toContain("skip ~/.config/hedge/cli-proxy.key: this machine has none");
});

test("a failed handover prints the hub's own words with the exit code, and neither the box's output nor a key in it", async () => {
  const on = fakeMachine(temp.make("hedge-box-"), { settings: balancing, run: async () => ({ ...ok, code: 1 }) });
  writeHome(on.machine.home, { ".config/hedge/cli-proxy.key": `${clientKey}\n` });
  for (const output of [{ stderr: `key ${clientKey} refused\u001b[2J` }, { stdout: `key ${clientKey} refused\u001b[2J` }]) {
    const { coder } = fakeCoder({ ssh: async (_box, command) => ({ ...ok, ...output, code: command.includes("cli-proxy connect") ? 3 : 0 }) });
    await handOver(coder, on.machine, "box-lane");
  }
  expect(on.lines.filter((line) => line.startsWith("box-lane keeps"))).toEqual(Array(2).fill("box-lane keeps its own sign-in: hedge cli-proxy connect exited 3 there. To see why and hand over the same key again, run on the hub: hedge box run box-lane -- hedge cli-proxy connect < ~/.config/hedge/cli-proxy.key"));
  expect(on.lines.join("\n")).not.toContain(clientKey);
  expect(on.lines.join("\n")).not.toContain("\u001b");
  expect(on.lines.join("\n")).not.toContain("refused");
});

test("a relay port on the proxy port is refused only while the workflow is on, before any tunnel or box forward is built", () => {
  expect(() => tunnelUnit("devbox-1", 8317, true)).toThrow("while Own-account balancing is on, hub.relayPort cannot be 8317");
  const clash = fakeMachine(temp.make("hedge-box-"), { settings: { ...balancing, relayPort: 8317 } }).machine;
  expect(() => hubForward(clash, "box-lane")).toThrow("while Own-account balancing is on, hub.relayPort cannot be 8317");
  expect(tunnelUnit("devbox-1", 8317)).toContain("-R 127.0.0.1:8317:127.0.0.1:8317");
  const off = fakeMachine(temp.make("hedge-box-"), { settings: { ...readBoxSettings({ HEDGE_SETTINGS: JSON.stringify(boxSettings) }), relayPort: 8317 } }).machine;
  expect(hubForward(off, "box-lane")).toContain("8317:127.0.0.1:8317");
});

const checkLine = (id: string, kind: "todo" | "say") => {
  const found = hubPack.checks.find((item) => item.id === id)!;
  return kind === "todo" ? `To do: ${found.todo}` : `Fix: ${found.say}`;
};

function proxyBox(plan: "claude" | "codex", models: { ids: string[] }) {
  const home = roleHome(temp.make("hedge-box-"), "devbox");
  const machine: ProxyMachine = { home, uid: 1000, user: "me", plan, devboxes: [], release: { version: "", url: "", sha256: "" }, run: async () => ok, fetch: async () => Response.json({ data: models.ids.map((id) => ({ id })) }), now: () => 0, sleep: async () => {}, readStdin: async () => "", randomKey: () => clientKey, print: () => {} };
  return { home, machine };
}

async function handOverTo(box: ReturnType<typeof proxyBox>, applyNow: () => Promise<{ code: number; stdout: string; stderr: string }>) {
  const hub = fakeMachine(temp.make("hedge-hub-"), { settings: balancing, run: async () => ({ ...ok, code: 1 }) });
  writeHome(hub.machine.home, { ".config/hedge/cli-proxy.key": `${clientKey}\n` });
  const sent: string[] = [];
  const { coder } = fakeCoder({
    ssh: async (_name, command, stdin) => {
      sent.push(command);
      if (command.includes("cli-proxy connect")) return { ...ok, code: await cliProxy("connect", { ...box.machine, readStdin: async () => stdin ?? "" }) };
      if (command === remoteHedge("apply")) return applyNow();
      return ok;
    },
  });
  await handOver(coder, hub.machine, "box-lane");
  return { lines: hub.lines, sent };
}

test("a handover runs hedge apply on the box after connect: once the pool empties, it takes off the route an earlier apply recorded, and the hub says the box keeps its own sign-in", async () => {
  const models = { ids: ["claude-sonnet-5-5"] };
  const box = proxyBox("claude", models);
  const claudePlan = await balancingPlan((prefix) => temp.make(prefix), "claude");
  const applyNow = hedgeApply(box.machine, () => claudePlan);
  writeHome(box.home, { ".config/hedge/cli-proxy.key": `${clientKey}\n` });
  expect((await applyNow()).code).toBe(0);
  const settings = join(box.home, ".claude/settings.json");
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ env: { ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: keyHelper });
  models.ids = [];
  const { lines, sent } = await handOverTo(box, applyNow);
  expect(sent.filter((command) => command.includes("cli-proxy connect") || command === remoteHedge("apply"))).toEqual([`umask 077 && ${remoteHedge("cli-proxy connect")}`, remoteHedge("apply")]);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({});
  expect(lines).toContain("box-lane: the proxy lists no Claude model yet, so Claude Code there keeps its own sign-in until the proxy serves it.");
});

test("a box handed over on the Codex plan sends Codex through the proxy with the hedge apply that the handover runs after connect", async () => {
  const box = proxyBox("codex", { ids: ["gpt-6.1-sol"] });
  const codexPlan = await balancingPlan((prefix) => temp.make(prefix), "codex");
  const { lines } = await handOverTo(box, hedgeApply(box.machine, () => codexPlan));
  expect(parse(readFileSync(join(box.home, ".codex/config.toml"), "utf8")).model_provider).toBe("hedge-proxy");
  expect(existsSync(join(box.home, ".claude/settings.json"))).toBe(false);
  expect(lines.filter((line) => line.startsWith("box-lane"))).toEqual([]);
  expect(await cliProxy("check", box.machine, "codex")).toBe(0);
});

test("a handover whose hedge apply fails or times out on the box says so with the exit code and the command to see why, and goes on", async () => {
  const box = proxyBox("claude", { ids: ["claude-sonnet-5-5"] });
  const { lines } = await handOverTo(box, async () => ({ code: 124, stdout: `To do: ${clientKey}`, stderr: "\u001b[2J" }));
  expect(lines.filter((line) => line.startsWith("box-lane"))).toEqual(["box-lane may keep its own sign-in: hedge apply exited 124 there. To see why, run on the hub: hedge box run box-lane -- hedge apply"]);
  expect(lines.join("\n")).not.toContain(clientKey);
});

test("a handover prints only the hub's own words, and only for an apply line that is exactly a proxy check's To do or Fix", async () => {
  const box = proxyBox("claude", { ids: ["claude-sonnet-5-5"] });
  const said = async (stdout: string) => (await handOverTo(box, async () => ({ ...ok, stdout }))).lines.filter((line) => line.startsWith("box-lane"));
  const noisy = [`token=secret ${checkLine("cli-proxy-client", "todo")}`, `${checkLine("cli-proxy-codex", "todo")} token=secret`, `\u001b[2J${checkLine("cli-proxy-client", "say")}`, `${checkLine("cli-proxy-codex", "say")}\u0007`].join("\n");
  expect(await said(noisy)).toEqual([]);
  expect(await said(`${checkLine("cli-proxy-codex", "todo")}\n`)).toEqual(["box-lane: the proxy lists no Codex model yet, so Codex there keeps its own sign-in until the proxy serves it."]);
  expect(await said(`${checkLine("cli-proxy-client", "say")}\n`)).toEqual(["box-lane: Claude Code there keeps its own sign-in, because it cannot reach your own-account proxy or the proxy is not safe to use. To see why, run on the hub: hedge box run box-lane -- hedge cli-proxy check"]);
  expect(await said(`${checkLine("cli-proxy-codex", "say")}\n`)).toEqual(["box-lane: Codex there keeps its own sign-in, because it cannot reach your own-account proxy or the proxy is not safe to use. To see why, run on the hub: hedge box run box-lane -- hedge cli-proxy check codex"]);
});
