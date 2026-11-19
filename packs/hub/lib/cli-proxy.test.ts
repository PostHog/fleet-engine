import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { tempDirs } from "../../../src/testing/git.ts";
import { claudeRoute, cliProxy, keyHelper, proxyUrl, type ProxyMachine } from "./cli-proxy.ts";
import { archive, clientKey, dataDir, otherKey, proxyMachine, release, type Proxy } from "./cli-proxy-testing.ts";
import { fakeRun, modeOf, roleHome } from "./run-testing.ts";
import { waitsForPerson } from "../../../src/pack/types.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const keyFile = (home: string) => join(home, ".config/hedge/cli-proxy.key");
const settingsFile = (home: string) => join(home, ".claude/settings.json");
const unitFile = (home: string) => join(home, ".config/systemd/user/hedge-cli-proxy.service");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const codexFile = (home: string) => join(home, ".codex/config.toml");
const readCodex = (home: string) => parse(readFileSync(codexFile(home), "utf8"));
const hedgeProxy = { name: "Hedge CLI proxy", base_url: `${proxyUrl}/v1`, wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", 'cat "$HOME/.config/hedge/cli-proxy.key"'] } };
const mine = { model: "gpt-6.1-sol", model_providers: { work: { name: "Work gateway", base_url: "https://gateway.example.com/v1" } } };

function codexRouted(home: string, config: Record<string, unknown> = { ...mine, model_provider: "hedge-proxy", model_providers: { ...mine.model_providers, "hedge-proxy": hedgeProxy } }) {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(codexFile(home), stringify(config));
}

const hubMachine = (fields: Partial<ProxyMachine> = {}, proxy: Proxy = {}, options: { role?: string; checksum?: string } = {}) => proxyMachine((prefix) => temp.make(prefix), fields, proxy, options);

const client = (fields: Partial<ProxyMachine> = {}, proxy: Proxy = {}) => hubMachine(fields, proxy, { role: "devbox" });

function connected(home: string, settings: Record<string, unknown> = {}) {
  mkdirSync(join(home, ".config/hedge"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(keyFile(home), `${clientKey}\n`, { mode: 0o600 });
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus", ...settings, env: { MY_FLAG: "1", ANTHROPIC_BASE_URL: proxyUrl, ...(settings.env as object) }, apiKeyHelper: keyHelper }));
}

test("plan on the hub names what install would do, and changes nothing", async () => {
  const { machine, home, calls, printed } = hubMachine();
  expect(await cliProxy("plan", machine)).toBe(0);
  expect(printed[0]).toBe("CLI proxy plan (no changes):");
  expect(printed.join("\n")).toContain("CLIProxyAPI 9.9.9");
  expect(calls.filter((call) => !call.endsWith("--help"))).toEqual([]);
  expect(existsSync(dataDir(home))).toBe(false);
});

test("install on the hub downloads the pinned release, checks it, and writes a loopback, fill-first config, a user unit, and private keys", async () => {
  const { machine, home, calls } = hubMachine();
  expect(await cliProxy("install", machine)).toBe(0);
  expect(calls).toContain(`curl -fsSL ${release.url} -o ${calls.find((call) => call.startsWith("curl"))!.split(" -o ")[1]}`);
  expect(calls.some((call) => call.startsWith("install -m 0755 ") && call.endsWith(join(dataDir(home), "cli-proxy-api")))).toBe(true);
  const config = readFileSync(join(dataDir(home), "config.yaml"), "utf8");
  expect(config.split("\n")[0]).toBe("# Managed by Hedge CLI proxy.");
  for (const line of ['host: "127.0.0.1"', "port: 8317", "  allow-remote: false", "  disable-control-panel: true", `  - "${clientKey}"`, '  strategy: "fill-first"', "  session-affinity: true", `auth-dir: "${join(dataDir(home), "auth")}"`]) expect(config).toContain(`${line}\n`);
  const unit = readFileSync(unitFile(home), "utf8");
  expect(unit).toContain(`ExecStart=${join(dataDir(home), "cli-proxy-api")} -config ${join(dataDir(home), "config.yaml")}`);
  expect(unit).toContain(`EnvironmentFile=${join(dataDir(home), "management.env")}`);
  expect(readFileSync(keyFile(home), "utf8")).toBe(`${clientKey}\n`);
  expect(readFileSync(join(dataDir(home), "management.env"), "utf8")).toBe(`MANAGEMENT_PASSWORD=${otherKey}\n`);
  for (const path of [keyFile(home), join(dataDir(home), "management.env"), join(dataDir(home), "config.yaml"), unitFile(home)]) expect([path, modeOf(statSync(path))]).toEqual([path, "600"]);
  for (const path of [dataDir(home), join(dataDir(home), "auth")]) expect(modeOf(statSync(path))).toBe("700");
  expect(calls).toContain("sudo -n loginctl enable-linger me");
  expect(calls).toContain("systemctl --user restart hedge-cli-proxy.service");
  expect(calls).toContain("systemctl --user enable --now hedge-cli-proxy.service");
  expect(calls.join("\n")).not.toContain(clientKey);
  expect(calls.join("\n")).not.toContain(otherKey);

  const again = hubMachine({ home, randomKey: () => { throw new Error("no new key"); } });
  expect(await cliProxy("install", again.machine)).toBe(0);
  expect(again.calls.some((call) => call.startsWith("curl") || call.includes("restart"))).toBe(false);
});

test("install presents a current Claude Code version upstream, so new Claude models answer, and moves a hub on the older config to it", async () => {
  const { machine, home } = hubMachine();
  expect(await cliProxy("install", machine)).toBe(0);
  const configPath = join(dataDir(home), "config.yaml");
  const header = 'claude-header-defaults:\n  user-agent: "claude-cli/2.1.322 (external, cli)"\n';
  expect(readFileSync(configPath, "utf8")).toContain(header);
  expect((Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, Record<string, string>>)["claude-header-defaults"]).toEqual({ "user-agent": "claude-cli/2.1.322 (external, cli)" });

  writeFileSync(configPath, readFileSync(configPath, "utf8").replace(header, ""));
  const older = hubMachine({ home });
  expect(await cliProxy("install", older.machine)).toBe(0);
  expect(readFileSync(configPath, "utf8")).toContain(header);
  expect(older.calls).toContain("systemctl --user restart hedge-cli-proxy.service");
});

test("install points the proxy at its own Codex catalog with the ultrafast tier and at its routing registry, and moves a hub on the earlier config to them", async () => {
  const upstream = { models: [{ slug: "gpt-6.1-sol", service_tiers: [{ id: "priority" }] }] };
  const { machine, home } = hubMachine({}, { catalog: upstream, registry: { "codex-pro": [{ id: "gpt-6.1-sol" }] } });
  expect(await cliProxy("install", machine)).toBe(0);
  const configPath = join(dataDir(home), "config.yaml");
  const catalogPath = join(dataDir(home), "codex-catalog.json");
  const registryPath = join(dataDir(home), "models-catalog.json");
  const block = `models:\n  codex-catalog: "${catalogPath}"\n  catalog: "${registryPath}"\n`;
  expect(readFileSync(configPath, "utf8")).toContain(block);
  expect((Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, Record<string, string>>).models).toEqual({ "codex-catalog": catalogPath, catalog: registryPath });
  expect(readJson(catalogPath).models.map((model: { slug: string }) => model.slug)).toEqual(["gpt-6.2-sol", "gpt-6.1-sol"]);
  expect(readJson(catalogPath).models[1].service_tiers.map((tier: { id: string }) => tier.id)).toEqual(["priority", "ultrafast"]);
  expect(readJson(registryPath)["codex-pro"].map((model: { id: string }) => model.id)).toEqual(["gpt-6.2-sol", "gpt-6.1-sol"]);

  writeFileSync(configPath, readFileSync(configPath, "utf8").replace(`  catalog: "${registryPath}"\n`, ""));
  const earlier = hubMachine({ home }, { down: true });
  expect(await cliProxy("install", earlier.machine)).toBe(0);
  expect(readFileSync(configPath, "utf8")).toContain(block);
  expect(earlier.calls).toContain("systemctl --user restart hedge-cli-proxy.service");
  expect(readJson(catalogPath).models[1].slug).toBe("gpt-6.1-sol");
});

test("install stops at a release whose checksum differs, before it writes a unit", async () => {
  const { machine, home } = hubMachine({}, {}, { checksum: "tampered" });
  await expect(cliProxy("install", machine)).rejects.toThrow("Checksum mismatch");
  expect(existsSync(unitFile(home))).toBe(false);
});

test("install keeps files Hedge did not write, and refuses linked paths", async () => {
  const unmanaged = hubMachine();
  mkdirSync(dataDir(unmanaged.home), { recursive: true });
  writeFileSync(join(dataDir(unmanaged.home), "config.yaml"), "port: 9999\n");
  await expect(cliProxy("install", unmanaged.machine)).rejects.toThrow("Keep unmanaged CLI proxy file");
  expect(readFileSync(join(dataDir(unmanaged.home), "config.yaml"), "utf8")).toBe("port: 9999\n");

  const foreignKey = hubMachine();
  mkdirSync(join(foreignKey.home, ".config/hedge"), { recursive: true });
  writeFileSync(keyFile(foreignKey.home), "not a key\n");
  await expect(cliProxy("install", foreignKey.machine)).rejects.toThrow("Keep unmanaged CLI proxy file");

  const linked = hubMachine();
  mkdirSync(join(linked.home, ".local/share"), { recursive: true });
  symlinkSync(temp.make("elsewhere-"), dataDir(linked.home));
  await expect(cliProxy("install", linked.machine)).rejects.toThrow("Keep linked CLI proxy path");
});

test("install and doctor run only on the hub and never as root", async () => {
  await expect(cliProxy("install", client().machine)).rejects.toThrow("hedge cli-proxy install runs only on the hub");
  await expect(cliProxy("install", hubMachine({ uid: 0 }).machine)).rejects.toThrow("not root");
});

test("the doctor passes with enough of your own subscriptions, and prints how to connect each devbox without the key", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const doctor = hubMachine({ home });
  expect(await cliProxy("doctor", doctor.machine)).toBe(0);
  expect(doctor.calls).toContain("systemctl --user is-active --quiet hedge-cli-proxy.service");
  expect(doctor.requests.filter((request) => request.path.startsWith("/v0/management")).every((request) => request.auth === `Bearer ${otherKey}`)).toBe(true);
  expect(doctor.printed.join("\n")).toContain(`ssh devbox-1 'sh "$HOME/.local/share/hedge/engine/hedge" cli-proxy connect' < ~/.config/hedge/cli-proxy.key`);
  expect(doctor.printed.join("\n")).not.toContain("box-lane");
  expect(doctor.printed.join("\n")).not.toContain(clientKey);
});

const login = (home: string, agent: string) => `${join(dataDir(home), "cli-proxy-api")} -config ${join(dataDir(home), "config.yaml")} -${agent}-login -no-browser`;

test("the doctor passes while the proxy holds too few subscriptions, none included, and names the login command as a To do", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const few = hubMachine({ home }, { credentials: [{ provider: "claude" }, { provider: "claude", disabled: true }, { provider: "codex" }] });
  expect(await cliProxy("doctor", few.machine)).toBe(0);
  expect(few.printed).toContain(`CLI proxy: To do: Add at least 2 of your own Claude subscriptions that work to the proxy; found 1. Run on the hub, once for each subscription: ${login(home, "claude")}`);
  const none = hubMachine({ home }, { credentials: [], models: [] });
  expect(await cliProxy("doctor", none.machine)).toBe(0);
  expect(none.printed).toContain(`CLI proxy: To do: Add at least 2 of your own Claude subscriptions that work to the proxy; found 0. Until the proxy holds one, Claude Code keeps its own sign-in on each machine. Run on the hub, once for each subscription: ${login(home, "claude")}`);
  expect(none.printed.join("\n")).toContain("with 0 of your own Claude subscriptions");
  const enough = hubMachine({ home });
  expect(await cliProxy("doctor", enough.machine)).toBe(0);
  expect(enough.printed.join("\n")).not.toContain("To do");
});

test("the doctor still fails with an empty pool while the proxy does not answer its key, its service is down, or routing is not fill-first", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const refused = hubMachine({ home }, { credentials: [], models: [], refuses: true });
  await expect(cliProxy("doctor", refused.machine)).rejects.toThrow(`The proxy at ${proxyUrl} refuses this machine's key (HTTP 401).`);
  const silent = hubMachine({ home }, { credentials: [], models: [], down: true });
  await expect(cliProxy("doctor", silent.machine)).rejects.toThrow();
  expect(silent.requests.some((request) => request.path === "/v0/management/routing/strategy")).toBe(true);
  const installed = hubMachine({ home });
  const stopped = hubMachine({ home, run: async (command) => (command.includes("is-active") ? { code: 3, stdout: "", stderr: "inactive" } : installed.machine.run(command)) }, { credentials: [], models: [] });
  await expect(cliProxy("doctor", stopped.machine)).rejects.toThrow("is-active");
  mkdirSync(join(dataDir(home), "plugins"), { recursive: true });
  writeFileSync(join(dataDir(home), "plugins/other.so"), "x");
  const foreign = hubMachine({ home }, { credentials: [], models: [] });
  await expect(cliProxy("doctor", foreign.machine)).rejects.toThrow("Remove the plugins Hedge did not install");
  rmSync(join(dataDir(home), "plugins"), { recursive: true });
  const spread = hubMachine({ home }, { strategy: "round-robin" });
  await expect(cliProxy("doctor", spread.machine)).rejects.toThrow("hedge cli-proxy-balance");
});

test("the doctor passes but warns about each subscription whose login expired, by a short id and never its email, and names the sign-in command for its provider", async () => {
  const { machine, home } = hubMachine({}, { catalog: { models: [{ slug: "gpt-6.1-sol" }] }, registry: { "codex-pro": [{ id: "gpt-6.1-sol" }] } });
  await cliProxy("install", machine);
  const expired = '{"error":"invalid_grant","error_description":"refresh token for alice expired"}';
  const credentials = [
    { name: "claude-carol@example.com.json", provider: "claude" },
    { name: "claude-dave@example.com.json", provider: "claude", status: "active", status_message: expired },
    { name: "claude-erin@example.com.json", provider: "claude" },
    { name: "claude-alice@example.com.json", auth_index: "aaaabbbbcccc", provider: "claude", status: "error", status_message: expired },
    { name: "three.json", provider: "claude", status: "error", status_message: "usage read timed out for alice" },
    { name: "codex-bob@example.com-team.json", provider: "codex", unavailable: true, status_message: expired },
    { name: "old.json", provider: "claude", disabled: true, status: "error", status_message: expired },
  ];
  const doctor = hubMachine({ home, plan: "both" }, { credentials, models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  expect(await cliProxy("doctor", doctor.machine)).toBe(0);
  const warnings = doctor.printed.filter((line) => line.includes("Warning"));
  const login = (agent: string) => `${join(dataDir(home), "cli-proxy-api")} -config ${join(dataDir(home), "config.yaml")} -${agent}-login -no-browser`;
  const hashed = new Bun.CryptoHasher("sha256").update("codex-bob@example.com-team.json").digest("hex").slice(0, 8);
  expect(warnings).toEqual([
    `CLI proxy: Warning: the Claude subscription aaaabbbb cannot refresh its login, so the proxy cannot use it and the balancer cannot read its usage. Sign it in again with: ${login("claude")}. Or disable it in the management panel.`,
    `CLI proxy: Warning: the Codex subscription ${hashed} cannot refresh its login, so the proxy cannot use it and the balancer cannot read its usage. Sign it in again with: ${login("codex")}. Or disable it in the management panel.`,
  ]);
  for (const leak of ["alice", "bob", "carol", "dave", "example.com"]) expect(doctor.printed.join("\n")).not.toContain(leak);
  expect(doctor.printed.join("\n")).toContain("with 4 of your own Claude subscriptions and 0 Codex subscriptions");
});

test("too few subscriptions that work is a To do, which counts none whose login expired, in the doctor and in accounts", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const expired = '{"error":"invalid_grant"}';
  const credentials = [{ name: "a.json", provider: "claude" }, { name: "b.json", auth_index: "bbbbcccc", provider: "claude", status: "error", status_message: expired }];
  const todo = `CLI proxy: To do: Add at least 2 of your own Claude subscriptions that work to the proxy; found 1, and 1 whose login expired, which you can sign in again. Run on the hub, once for each subscription: ${login(home, "claude")}`;
  const doctor = hubMachine({ home }, { credentials });
  expect(await cliProxy("doctor", doctor.machine)).toBe(0);
  expect(doctor.printed).toContain(todo);
  expect(doctor.printed).toContain(`CLI proxy: Warning: the Claude subscription bbbbcccc cannot refresh its login, so the proxy cannot use it and the balancer cannot read its usage. Sign it in again with: ${login(home, "claude")}. Or disable it in the management panel.`);
  const counted = hubMachine({ home }, { credentials });
  expect(await cliProxy("accounts", counted.machine)).toBe(waitsForPerson);
  expect(counted.printed).toEqual([todo]);
});

test("accounts waits for the person below hub.proxyAccounts, passes at it, fails when it cannot count, and runs only on the hub", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const none = hubMachine({ home }, { credentials: [] });
  expect(await cliProxy("accounts", none.machine)).toBe(waitsForPerson);
  expect(none.printed.join("\n")).toContain("found 0. Until the proxy holds one, Claude Code keeps its own sign-in on each machine.");
  const enough = hubMachine({ home });
  expect(await cliProxy("accounts", enough.machine)).toBe(0);
  expect(enough.printed).toEqual(["CLI proxy: 2 Claude subscriptions of yours work, and hub.proxyAccounts asks for 2."]);
  const one = hubMachine({ home, accounts: 1 }, { credentials: [{ provider: "claude" }] });
  expect(await cliProxy("accounts", one.machine)).toBe(0);
  const codex = hubMachine({ home, plan: "codex" }, { credentials: [{ provider: "codex" }, { provider: "claude" }, { provider: "claude" }] });
  expect(await cliProxy("accounts", codex.machine)).toBe(waitsForPerson);
  expect(codex.printed.join("\n")).toContain(`found 1. Run on the hub, once for each subscription: ${login(home, "codex")}`);
  await expect(cliProxy("accounts", hubMachine({ home }, { down: true }).machine)).rejects.toThrow();
  await expect(cliProxy("accounts", client().machine)).rejects.toThrow("hub");
});

test("on the Codex plan the doctor counts Codex subscriptions and wants a Codex model, and names the Codex login", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const codexOnly = { credentials: [{ provider: "codex" }, { provider: "codex" }], models: ["gpt-6.1-sol"] };
  const passing = hubMachine({ home, plan: "codex" }, codexOnly);
  expect(await cliProxy("doctor", passing.machine)).toBe(0);
  expect(passing.printed.join("\n")).toContain("with 2 of your own Codex subscriptions");
  const few = hubMachine({ home, plan: "codex" }, { credentials: [{ provider: "codex" }, { provider: "claude" }, { provider: "claude" }], models: ["gpt-6.1-sol"] });
  expect(await cliProxy("doctor", few.machine)).toBe(0);
  expect(few.printed).toContain(`CLI proxy: To do: Add at least 2 of your own Codex subscriptions that work to the proxy; found 1. Run on the hub, once for each subscription: ${login(home, "codex")}`);
  const none = hubMachine({ home, plan: "codex" }, { credentials: [], models: [] });
  expect(await cliProxy("doctor", none.machine)).toBe(0);
  expect(none.printed.join("\n")).toContain("found 0. Until the proxy holds one, Codex keeps its own sign-in on each machine.");
  const noModel = hubMachine({ home, plan: "codex" }, { credentials: codexOnly.credentials });
  await expect(cliProxy("doctor", noModel.machine)).rejects.toThrow("lists no Codex model");
});

test("on the both plan the doctor still asks for Claude subscriptions, and counts the Codex ones beside them", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  const both = hubMachine({ home, plan: "both" }, { credentials: [{ provider: "claude" }, { provider: "claude" }, { provider: "codex" }], models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  expect(await cliProxy("doctor", both.machine)).toBe(0);
  expect(both.printed.join("\n")).toContain("with 2 of your own Claude subscriptions and 1 Codex subscription");
  const claudeOnly = hubMachine({ home, plan: "claude" }, { credentials: [{ provider: "claude" }, { provider: "claude" }, { provider: "codex" }] });
  expect(await cliProxy("doctor", claudeOnly.machine)).toBe(0);
  expect(claudeOnly.printed.join("\n")).toContain("with 2 of your own Claude subscriptions.");
});

test("connect on a Codex plan checks the proxy for a Codex model, sends Codex to the proxy, and leaves Claude Code alone", async () => {
  const { machine, home, printed } = client({ plan: "codex" }, { models: ["gpt-6.1-sol"] });
  codexRouted(home, mine);
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(readFileSync(keyFile(home), "utf8")).toBe(`${clientKey}\n`);
  expect(readCodex(home)).toEqual({ ...mine, model_provider: "hedge-proxy", model_providers: { ...mine.model_providers, "hedge-proxy": hedgeProxy } });
  expect(existsSync(settingsFile(home))).toBe(false);
  expect(printed).toEqual([`Codex uses your own-account proxy at ${proxyUrl} now. Restart open Codex sessions.`]);
  expect(await cliProxy("check", machine, "codex")).toBe(0);

  const noCodex = client({ plan: "codex" });
  expect(await cliProxy("connect", noCodex.machine)).toBe(0);
  expect(noCodex.printed).toEqual([`The proxy at ${proxyUrl} lists no Codex model. Add one of your own Codex subscriptions to the hub's proxy. Codex keeps its own sign-in.`]);
  expect(readFileSync(keyFile(noCodex.home), "utf8")).toBe(`${clientKey}\n`);
  expect(existsSync(codexFile(noCodex.home))).toBe(false);
  expect(await cliProxy("check", noCodex.machine, "codex")).toBe(waitsForPerson);

  const theirs = client({ plan: "codex" }, { models: ["gpt-6.1-sol"] });
  codexRouted(theirs.home, { ...mine, model_provider: "work" });
  await expect(cliProxy("connect", theirs.machine)).rejects.toThrow("Keep your Codex setting model_provider");
  expect(readCodex(theirs.home)).toEqual({ ...mine, model_provider: "work" });
  expect(existsSync(keyFile(theirs.home))).toBe(false);
});

test("connect on the both plan sends Claude Code to the proxy, and Codex too while the proxy serves it", async () => {
  const served = client({ plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  expect(await cliProxy("connect", served.machine)).toBe(0);
  expect(readJson(settingsFile(served.home)).apiKeyHelper).toBe(keyHelper);
  expect(readCodex(served.home)).toEqual({ model_provider: "hedge-proxy", model_providers: { "hedge-proxy": hedgeProxy } });

  const claudeOnly = client({ plan: "both" });
  expect(await cliProxy("connect", claudeOnly.machine)).toBe(0);
  expect(readJson(settingsFile(claudeOnly.home)).apiKeyHelper).toBe(keyHelper);
  expect(existsSync(codexFile(claudeOnly.home))).toBe(false);
  expect(claudeOnly.printed.join("\n")).toContain("lists no Codex model. Add one of your own Codex subscriptions to the hub's proxy. Codex keeps its own sign-in.");
});

test("connect never selects a hedge-proxy table that cannot reach the proxy with this machine's key", async () => {
  const { auth: _auth, ...keyless } = hedgeProxy;
  const config = { model_providers: { "hedge-proxy": keyless } };
  const codexOnly = client({ plan: "codex" }, { models: ["gpt-6.1-sol"] });
  codexRouted(codexOnly.home, config);
  await expect(cliProxy("connect", codexOnly.machine)).rejects.toThrow("which does not reach the proxy with this machine's key. Nothing changed.");
  expect(readCodex(codexOnly.home)).toEqual(config);
  expect(existsSync(keyFile(codexOnly.home))).toBe(false);

  const both = client({ plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  codexRouted(both.home, config);
  expect(await cliProxy("connect", both.machine)).toBe(0);
  expect(readCodex(both.home)).toEqual(config);
  expect(both.printed.join("\n")).toContain("Codex keeps its own sign-in.");
});

test("on the both plan, a Codex config that connect cannot write keeps Codex on its own sign-in, and Claude Code still connects", async () => {
  const { machine, home, printed } = client({ plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  codexRouted(home, mine);
  chmodSync(join(home, ".codex"), 0o500);
  try {
    expect(await cliProxy("connect", machine)).toBe(0);
  } finally {
    chmodSync(join(home, ".codex"), 0o700);
  }
  expect(readJson(settingsFile(home)).apiKeyHelper).toBe(keyHelper);
  expect(readCodex(home)).toEqual(mine);
  expect(printed.at(-1)).toEndWith("Codex keeps its own sign-in.");
});

test("connect leaves a Codex config that becomes a link while it checks the proxy", async () => {
  const { machine, home, printed } = client({ plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  codexRouted(home, mine);
  const outside = temp.make("elsewhere-");
  writeFileSync(join(outside, "config.toml"), readFileSync(codexFile(home), "utf8"));
  const fetch = machine.fetch;
  machine.fetch = async (input, init) => {
    if (!existsSync(join(home, ".codex", "moved"))) {
      rmSync(join(home, ".codex"), { recursive: true });
      symlinkSync(outside, join(home, ".codex"));
      writeFileSync(join(outside, "moved"), "");
    }
    return fetch(input, init);
  };
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(parse(readFileSync(join(outside, "config.toml"), "utf8"))).toEqual(mine);
  expect(printed.at(-1)).toEndWith("Codex keeps its own sign-in.");
});

test("on a devbox, plan names the agents that the plan sends through the proxy", async () => {
  for (const [ai, agents] of [["claude", "Claude Code uses"], ["codex", "Codex uses"], ["both", "Claude Code and Codex use"]] as const) {
    const { machine, home, printed } = client({ plan: ai });
    connected(home);
    expect(await cliProxy("plan", machine)).toBe(0);
    expect(printed).toEqual([`CLI proxy plan (no changes): this machine has a proxy key, and ${agents} the proxy at ${proxyUrl} through the hub's tunnel while the proxy serves them.`]);
  }
});

test("the doctor finds a changed unit and a proxy that listens beyond loopback", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  writeFileSync(unitFile(home), `${readFileSync(unitFile(home), "utf8")}# edited\n`);
  await expect(cliProxy("doctor", hubMachine({ home }).machine)).rejects.toThrow("hedge cli-proxy install");
  await cliProxy("install", hubMachine({ home }).machine);
  const open = hubMachine({ home, run: fakeRun((command) => (command[0] === "ss" ? { stdout: "LISTEN 0 4096 0.0.0.0:8317 0.0.0.0:*\n" } : command[0]!.endsWith("cli-proxy-api") ? { stdout: `CLIProxyAPI Version: ${release.version}\n` } : undefined)).run });
  await expect(cliProxy("doctor", open.machine)).rejects.toThrow("loopback only");
});

test("connect on a devbox checks the key against the proxy first, then saves it privately and sends Claude Code to the proxy", async () => {
  const { machine, home, requests, printed } = client();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus", env: { MY_FLAG: "1" } }));
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(requests[0]).toEqual({ path: "/v1/models", method: "GET", auth: `Bearer ${clientKey}` });
  expect(readFileSync(keyFile(home), "utf8")).toBe(`${clientKey}\n`);
  expect(modeOf(statSync(keyFile(home)))).toBe("600");
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", env: { MY_FLAG: "1", ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: keyHelper });
  expect(modeOf(statSync(settingsFile(home)))).toBe("600");
  expect(readFileSync(settingsFile(home), "utf8")).not.toContain(clientKey);
  expect(printed.join("\n")).toContain("Restart");
});

test("connect to a proxy that holds none of your subscriptions saves the key, keeps Claude Code on its own sign-in, and leaves the move to a later apply", async () => {
  const { machine, home, printed } = client({}, { models: [] });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus" }));
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(readFileSync(keyFile(home), "utf8")).toBe(`${clientKey}\n`);
  expect(readJson(settingsFile(home))).toEqual({ model: "opus" });
  expect(printed).toEqual([`The proxy at ${proxyUrl} lists no Claude model. On the hub, run hedge cli-proxy doctor. Claude Code keeps its own sign-in. The first hedge apply after the proxy serves it sends Claude Code there.`]);
  expect(await cliProxy("check", machine)).toBe(waitsForPerson);
  const refused = client({}, { models: [], refuses: true });
  await expect(cliProxy("connect", refused.machine)).rejects.toThrow("refuses this machine's key (HTTP 401). Nothing changed.");
  expect(existsSync(keyFile(refused.home))).toBe(false);
});

test("connect again after the pool empties takes Hedge's routes off Claude Code and Codex, and keeps your own settings", async () => {
  const { machine, home, printed } = client({ plan: "both" }, { models: [] });
  connected(home);
  codexRouted(home);
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", env: { MY_FLAG: "1" } });
  expect(readCodex(home)).toEqual(mine);
  expect(printed.join("\n")).toContain("Claude Code keeps its own sign-in.");
  expect(printed.at(-1)).toEndWith("Codex keeps its own sign-in.");
});

test("connect again after the pool empties leaves a proxy address that Hedge's key helper does not go with", async () => {
  const { machine, home } = client({}, { models: [] });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const theirs = { env: { ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_API_KEY: "sample" } };
  writeFileSync(settingsFile(home), JSON.stringify(theirs));
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(readJson(settingsFile(home))).toEqual(theirs);
});

test("connect again after the pool empties says when Codex may still use the proxy, and leaves a linked or locked config", async () => {
  const linked = client({ plan: "both" }, { models: [] });
  connected(linked.home);
  const outside = temp.make("elsewhere-");
  writeFileSync(join(outside, "config.toml"), stringify({ ...mine, model_provider: "hedge-proxy", model_providers: { ...mine.model_providers, "hedge-proxy": hedgeProxy } }));
  symlinkSync(outside, join(linked.home, ".codex"));
  expect(await cliProxy("connect", linked.machine)).toBe(0);
  expect(readFileSync(join(outside, "config.toml"), "utf8")).toContain('model_provider = "hedge-proxy"');
  expect(linked.printed.at(-1)).toEndWith("Codex may still use the proxy. Fix that, then run hedge apply.");

  const locked = client({ plan: "both" }, { models: [] });
  connected(locked.home);
  codexRouted(locked.home);
  chmodSync(join(locked.home, ".codex"), 0o500);
  try {
    expect(await cliProxy("connect", locked.machine)).toBe(0);
  } finally {
    chmodSync(join(locked.home, ".codex"), 0o700);
  }
  expect(readCodex(locked.home).model_provider).toBe("hedge-proxy");
  expect(readJson(settingsFile(locked.home)).apiKeyHelper).toBeUndefined();
  expect(locked.printed.at(-1)).toEndWith("Codex may still use the proxy. Fix that, then run hedge apply.");
});

test("connect refuses a model list it cannot read, and saves no key", async () => {
  const refused = client({}, { modelList: '{"data":[null,{"id":7}]}' });
  await expect(cliProxy("connect", refused.machine)).rejects.toThrow("answers without a model list. Nothing changed.");
  expect(existsSync(keyFile(refused.home))).toBe(false);
});

test("a model list the proxy cannot give fails the check and the doctor, and never reads as an empty pool", async () => {
  for (const modelList of ["not json", "{}", '{"data":null}', '{"data":[null,{"id":7}]}', '{"data":[{"id":""}]}', '{"data":[{"id":"claude-sonnet-5-5"},{}]}']) {
    const routed = client({}, { modelList });
    connected(routed.home);
    expect(await cliProxy("check", routed.machine)).toBe(1);
    expect(routed.printed.join("\n")).toContain(`The proxy at ${proxyUrl} answers without a model list.`);
  }
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  await expect(cliProxy("doctor", hubMachine({ home }, { credentials: [], modelList: "not json" }).machine)).rejects.toThrow("answers without a model list");
});

test("on the both plan, the doctor fails while a Codex subscription works but the proxy serves no Codex model", async () => {
  const { machine, home } = hubMachine({ plan: "both" });
  await cliProxy("install", machine);
  const claudeOnly = [{ provider: "claude" }, { provider: "claude" }];
  await expect(cliProxy("doctor", hubMachine({ home, plan: "both" }, { credentials: [...claudeOnly, { provider: "codex" }], models: ["claude-sonnet-5-5"] }).machine)).rejects.toThrow("lists no Codex model");
  expect(await cliProxy("doctor", hubMachine({ home, plan: "both" }, { credentials: [...claudeOnly, { provider: "codex", disabled: true }], models: ["claude-sonnet-5-5"] }).machine)).toBe(0);
  expect(await cliProxy("doctor", hubMachine({ home, plan: "both" }, { credentials: [...claudeOnly, { provider: "codex" }], models: ["claude-sonnet-5-5", "gpt-6.1-sol"] }).machine)).toBe(0);
});

test("with hub.proxyAccounts at 0, the doctor and accounts pass with an empty pool, and the doctor still wants a model once the pool holds one", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  for (const plan of ["claude", "codex"] as const) {
    const empty = hubMachine({ home, plan, accounts: 0 }, { credentials: [], models: [] });
    expect(await cliProxy("doctor", empty.machine)).toBe(0);
    expect(empty.printed.join("\n")).not.toContain("To do");
    expect(await cliProxy("accounts", hubMachine({ home, plan, accounts: 0 }, { credentials: [] }).machine)).toBe(0);
  }
  await expect(cliProxy("doctor", hubMachine({ home, accounts: 0 }, { credentials: [{ provider: "claude" }], models: [] }).machine)).rejects.toThrow("lists no Claude model");
});

test("connect changes nothing for a key that is not hexadecimal, a proxy that does not answer, or Claude settings that point elsewhere", async () => {
  const bad = client({ readStdin: async () => "sk-not-a-key\n" });
  await expect(cliProxy("connect", bad.machine)).rejects.toThrow("hexadecimal");
  const down = client({}, { down: true });
  await expect(cliProxy("connect", down.machine)).rejects.toThrow("Nothing changed");
  expect(existsSync(keyFile(down.home))).toBe(false);
  expect(existsSync(settingsFile(down.home))).toBe(false);
  const elsewhere = client();
  mkdirSync(join(elsewhere.home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(elsewhere.home), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } }));
  await expect(cliProxy("connect", elsewhere.machine)).rejects.toThrow("Keep your Claude setting env.ANTHROPIC_BASE_URL");
  expect(existsSync(keyFile(elsewhere.home))).toBe(false);
  await expect(cliProxy("connect", hubMachine().machine)).rejects.toThrow("The hub has its own key");
});

test("the check passes while the proxy answers the saved key, and keeps Claude Code on the proxy", async () => {
  const { machine, home, printed } = client();
  connected(home);
  expect(await cliProxy("check", machine)).toBe(0);
  expect(readJson(settingsFile(home)).env.ANTHROPIC_BASE_URL).toBe(proxyUrl);
  expect(printed).toEqual([`Claude Code reaches your own-account proxy at ${proxyUrl}.`]);
});

test("the check reports an unreachable proxy and changes no file: apply sends Claude Code back to its own sign-in", async () => {
  const { machine, home, printed } = client({}, { down: true });
  connected(home);
  const before = readFileSync(settingsFile(home), "utf8");
  expect(await cliProxy("check", machine)).toBe(1);
  expect(readFileSync(settingsFile(home), "utf8")).toBe(before);
  expect(printed).toEqual([`The proxy at ${proxyUrl} does not answer. hedge apply keeps Claude Code on its own sign-in until the proxy serves it.`]);
  expect(existsSync(keyFile(home))).toBe(true);
});

test("the check fails without a saved key, waits for the person while the proxy serves no Claude model, and writes nothing", async () => {
  const missing = client();
  connected(missing.home);
  writeFileSync(keyFile(missing.home), "");
  expect(await cliProxy("check", missing.machine)).toBe(1);
  expect(readJson(settingsFile(missing.home)).apiKeyHelper).toBe(keyHelper);
  expect(missing.printed.join("\n")).toContain("no proxy key");

  const refused = client({}, { models: ["gpt-6.1-sol"] });
  connected(refused.home);
  expect(await cliProxy("check", refused.machine)).toBe(waitsForPerson);
  expect(refused.printed.join("\n")).toContain("lists no Claude model");

  const fresh = client({}, { down: true });
  expect(await cliProxy("check", fresh.machine)).toBe(1);
  expect(existsSync(settingsFile(fresh.home))).toBe(false);
});

test("connect and disconnect take over the key helper and the Codex provider that fleet cli-proxy connect wrote, and keep your own", async () => {
  const fleetHelper = 'cat "$HOME/.config/fleet/cli-proxy.key"';
  const fleetProxy = { name: "Fleet CLI proxy", base_url: `${proxyUrl}/v1`, wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", fleetHelper] } };
  const fleetCodex = { ...mine, model_provider: "fleet-proxy", model_providers: { ...mine.model_providers, "fleet-proxy": fleetProxy } };
  const both = client({ plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  mkdirSync(join(both.home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(both.home), JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: fleetHelper }));
  codexRouted(both.home, fleetCodex);

  expect(await cliProxy("connect", both.machine)).toBe(0);

  expect(readJson(settingsFile(both.home))).toEqual({ model: "opus", env: { ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: keyHelper });
  expect(readCodex(both.home)).toEqual({ ...mine, model_provider: "hedge-proxy", model_providers: { ...mine.model_providers, "hedge-proxy": hedgeProxy } });

  const left = client({ plan: "both" });
  mkdirSync(join(left.home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(left.home), JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: fleetHelper }));
  codexRouted(left.home, fleetCodex);
  writeFileSync(keyFile(left.home), `${clientKey}\n`, { mode: 0o600 });

  expect(await cliProxy("disconnect", left.machine)).toBe(0);

  expect(readJson(settingsFile(left.home))).toEqual({ model: "opus" });
  expect(readCodex(left.home)).toEqual(mine);
});

test("disconnect removes only Hedge's own values: a base URL or key helper you set stays", async () => {
  const { machine, home } = client();
  connected(home);
  writeFileSync(settingsFile(home), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" }, apiKeyHelper: "my-helper" }));
  expect(await cliProxy("disconnect", machine)).toBe(0);
  expect(readJson(settingsFile(home))).toEqual({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" }, apiKeyHelper: "my-helper" });
});

test("disconnect removes Hedge's Claude settings and the key, and says how to sign in again; the hub keeps its key", async () => {
  const { machine, home, printed } = client();
  connected(home);
  expect(await cliProxy("disconnect", machine)).toBe(0);
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", env: { MY_FLAG: "1" } });
  expect(existsSync(keyFile(home))).toBe(false);
  expect(printed.join("\n")).toContain("run claude and enter /login");
  await expect(cliProxy("disconnect", hubMachine().machine)).rejects.toThrow("own-account-balancing=off");
});

test("a linked Claude settings file stops connect and disconnect", async () => {
  const { machine, home } = client();
  connected(home);
  const real = join(temp.make("real-"), "settings.json");
  writeFileSync(real, readFileSync(settingsFile(home)));
  rmSync(settingsFile(home));
  symlinkSync(real, settingsFile(home));
  await expect(cliProxy("disconnect", machine)).rejects.toThrow("Keep linked Claude settings path");
  await expect(cliProxy("connect", machine)).rejects.toThrow("Keep linked Claude settings path");
});

test("install refuses a linked auth folder or binary before it changes modes or runs anything", async () => {
  const auth = hubMachine();
  const outside = temp.make("elsewhere-");
  chmodSync(outside, 0o755);
  mkdirSync(dataDir(auth.home), { recursive: true });
  symlinkSync(outside, join(dataDir(auth.home), "auth"));
  await expect(cliProxy("install", auth.machine)).rejects.toThrow("Keep linked CLI proxy path");
  expect(modeOf(statSync(outside))).toBe("755");
  expect(auth.calls).toEqual([]);

  const binary = hubMachine();
  mkdirSync(dataDir(binary.home), { recursive: true });
  symlinkSync(join(outside, "tool"), join(dataDir(binary.home), "cli-proxy-api"));
  await expect(cliProxy("install", binary.machine)).rejects.toThrow("Keep linked CLI proxy path");
  expect(binary.calls).toEqual([]);
});

test("install that fails after it writes a new management key restarts the proxy on the next run", async () => {
  let linger = 1;
  const { machine, home, calls } = hubMachine();
  const run = machine.run;
  machine.run = async (command, options) => (command[0] === "sudo" && linger-- > 0 ? { code: 1, stdout: "", stderr: "no sudo" } : run(command, options));
  await expect(cliProxy("install", machine)).rejects.toThrow();
  expect(existsSync(join(dataDir(home), "management.env"))).toBe(true);
  calls.length = 0;
  expect(await cliProxy("install", machine)).toBe(0);
  expect(calls).toContain("systemctl --user restart hedge-cli-proxy.service");
  calls.length = 0;
  expect(await cliProxy("install", machine)).toBe(0);
  expect(calls).not.toContain("systemctl --user restart hedge-cli-proxy.service");
});

test("connect keeps Claude settings that change while it checks the proxy", async () => {
  const { machine, home } = client();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus" }));
  const fetch = machine.fetch;
  machine.fetch = async (input, init) => {
    writeFileSync(settingsFile(home), JSON.stringify({ model: "opus", permissions: { deny: ["Bash(rm:*)"] }, env: { MY_FLAG: "2" } }));
    return fetch(input, init);
  };
  expect(await cliProxy("connect", machine)).toBe(0);
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", permissions: { deny: ["Bash(rm:*)"] }, env: { MY_FLAG: "2", ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: keyHelper });
});

test("connect waits for a forward that is still coming up, and gives up after a while", async () => {
  let refused = 3;
  const late = client();
  const fetch = late.machine.fetch;
  let slept = 0;
  late.machine.sleep = async () => void slept++;
  late.machine.fetch = async (input, init) => (refused-- > 0 ? Promise.reject(new TypeError("connection refused")) : fetch(input, init));
  expect(await cliProxy("connect", late.machine)).toBe(0);
  expect(slept).toBe(3);
  expect(readFileSync(keyFile(late.home), "utf8")).toBe(`${clientKey}\n`);

  const never = client({}, { down: true });
  await expect(cliProxy("connect", never.machine)).rejects.toThrow("Nothing changed");
  expect(never.requests.length).toBeGreaterThan(1);
  expect(never.requests.length).toBeLessThanOrEqual(30);

  const refusedKey = client({ readStdin: async () => `${otherKey}\n` });
  await expect(cliProxy("connect", refusedKey.machine)).rejects.toThrow("refuses this machine's key");
  expect(refusedKey.requests).toHaveLength(1);
});

test("the Claude switch stops and keeps your edit when settings change between its read and its write", async () => {
  const home = roleHome(temp.make("hedge-cli-proxy-"), "devbox");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus" }));
  const write = (await claudeRoute(home, true))!;
  writeFileSync(settingsFile(home), JSON.stringify({ model: "opus", permissions: { deny: ["Bash(rm:*)"] } }));
  await expect(write()).rejects.toThrow("changed while Hedge wrote it");
  expect(readJson(settingsFile(home))).toEqual({ model: "opus", permissions: { deny: ["Bash(rm:*)"] } });
  expect(readdirSync(join(home, ".claude"))).toEqual(["settings.json"]);
});

test("an install that stops after it replaced the binary restarts the proxy on the next run", async () => {
  const { machine, home, calls } = hubMachine();
  expect(await cliProxy("install", machine)).toBe(0);
  const binary = join(dataDir(home), "cli-proxy-api");
  machine.release = { ...release, version: "9.9.10" };
  let crash = true;
  const run = machine.run;
  machine.run = async (command, options) => {
    if (command[0] === binary) return { code: 0, stdout: `CLIProxyAPI Version: ${readFileSync(binary, "utf8")}, Commit: x\n`, stderr: "" };
    if (command[0] === "install") {
      writeFileSync(command.at(-1)!, "9.9.10");
      if (crash) return (crash = false), { code: 1, stdout: "", stderr: "killed" };
      return { code: 0, stdout: "", stderr: "" };
    }
    return run(command, options);
  };
  await expect(cliProxy("install", machine)).rejects.toThrow();
  calls.length = 0;
  expect(await cliProxy("install", machine)).toBe(0);
  expect(calls).toContain("systemctl --user restart hedge-cli-proxy.service");
});

test("the Codex check keeps Codex on the proxy while the proxy lists a Codex model, and says so", async () => {
  const { machine, home, printed } = client({}, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
  connected(home);
  codexRouted(home);
  expect(await cliProxy("check", machine, "codex")).toBe(0);
  expect(readCodex(home)).toMatchObject({ model_provider: "hedge-proxy", model_providers: { "hedge-proxy": hedgeProxy } });
  expect(printed).toEqual([`Codex reaches your own-account proxy at ${proxyUrl}.`]);
});

test("the Codex check judges the proxy before Hedge routes Codex, so apply can wait for it", async () => {
  const served = client({}, { models: ["gpt-6.1-sol"] });
  connected(served.home);
  expect(await cliProxy("check", served.machine, "codex")).toBe(0);
  expect(existsSync(codexFile(served.home))).toBe(false);
  const unserved = client();
  connected(unserved.home);
  expect(await cliProxy("check", unserved.machine, "codex")).toBe(waitsForPerson);
  expect(existsSync(codexFile(unserved.home))).toBe(false);
});

test("the Codex check reports an unreachable proxy and changes no file", async () => {
  const { machine, home, printed } = client({}, { down: true });
  connected(home);
  codexRouted(home);
  const before = readFileSync(codexFile(home), "utf8");
  expect(await cliProxy("check", machine, "codex")).toBe(1);
  expect(readFileSync(codexFile(home), "utf8")).toBe(before);
  expect(printed.join("\n")).toContain("hedge apply keeps Codex on its own sign-in until the proxy serves it.");
});

test("a proxy that lists no Codex model holds back only the Codex check, which waits for the person", async () => {
  const { machine, home, printed } = client();
  connected(home);
  codexRouted(home);
  expect(await cliProxy("check", machine)).toBe(0);
  expect(await cliProxy("check", machine, "codex")).toBe(waitsForPerson);
  expect(printed.join("\n")).toContain(`The proxy at ${proxyUrl} lists no Codex model.`);
});

test("without a saved key, the Codex check fails", async () => {
  const { machine, home, printed } = client({}, { models: ["gpt-6.1-sol"] });
  codexRouted(home);
  expect(await cliProxy("check", machine, "codex")).toBe(1);
  expect(printed.join("\n")).toContain("no proxy key");
});

test("Codex that does not use Hedge's proxy is left alone by both checks", async () => {
  const own = client({}, { down: true });
  connected(own.home);
  codexRouted(own.home, { ...mine, model_provider: "work" });
  expect(await cliProxy("check", own.machine, "codex")).toBe(1);
  expect(readCodex(own.home)).toEqual({ ...mine, model_provider: "work" });

  const edited = client({}, { down: true });
  connected(edited.home);
  codexRouted(edited.home, { model_provider: "hedge-proxy", model_providers: { "hedge-proxy": { ...hedgeProxy, base_url: "https://gateway.example.com/v1" } } });
  expect(await cliProxy("check", edited.machine)).toBe(1);
  expect(await cliProxy("check", edited.machine, "codex")).toBe(1);
  expect(readCodex(edited.home)).toEqual({ model_provider: "hedge-proxy", model_providers: { "hedge-proxy": { ...hedgeProxy, base_url: "https://gateway.example.com/v1" } } });
});

test("disconnect sends Codex back to its own sign-in too, and says how to sign in again", async () => {
  const { machine, home, printed } = client();
  connected(home);
  codexRouted(home);
  expect(await cliProxy("disconnect", machine)).toBe(0);
  expect(readCodex(home)).toEqual(mine);
  expect(printed.join("\n")).toContain("run codex login");
});

test("a linked or unreadable Codex config is left alone and never breaks the Claude route", async () => {
  const linked = client();
  connected(linked.home);
  mkdirSync(join(linked.home, ".codex"), { recursive: true });
  const real = join(temp.make("real-"), "config.toml");
  writeFileSync(real, stringify({ model_provider: "hedge-proxy", model_providers: { "hedge-proxy": hedgeProxy } }));
  symlinkSync(real, codexFile(linked.home));
  expect(await cliProxy("check", linked.machine)).toBe(0);
  expect(await cliProxy("check", linked.machine, "codex")).toBe(waitsForPerson);
  expect(await cliProxy("disconnect", linked.machine)).toBe(0);
  expect(parse(readFileSync(real, "utf8"))).toEqual({ model_provider: "hedge-proxy", model_providers: { "hedge-proxy": hedgeProxy } });

  const broken = client();
  connected(broken.home);
  mkdirSync(join(broken.home, ".codex"), { recursive: true });
  writeFileSync(codexFile(broken.home), "model = [");
  expect(await cliProxy("check", broken.machine)).toBe(0);
  expect(await cliProxy("check", broken.machine, "codex")).toBe(waitsForPerson);
  expect(readJson(settingsFile(broken.home)).env.ANTHROPIC_BASE_URL).toBe(proxyUrl);
  expect(readFileSync(codexFile(broken.home), "utf8")).toBe("model = [");
});

test("disconnect keeps a Hedge provider table you edited, and removes only Hedge's selection", async () => {
  const { machine, home } = client();
  connected(home);
  const edited = { ...hedgeProxy, http_headers: { "X-Team": "mine" } };
  codexRouted(home, { model_provider: "hedge-proxy", model_providers: { "hedge-proxy": edited } });
  expect(await cliProxy("disconnect", machine)).toBe(0);
  expect(readCodex(home)).toEqual({ model_providers: { "hedge-proxy": edited } });
});

test("a hedge-proxy table that does not reach the proxy with this machine's key fails the Codex check, whether or not Codex selects it", async () => {
  const served = { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] };
  const { auth: _auth, ...keyless } = hedgeProxy;
  const configs: Array<Record<string, unknown>> = [{ model_provider: "hedge-proxy", model_providers: { "hedge-proxy": { name: "Mine" } } }, { model_providers: { "hedge-proxy": { name: "Mine" } } }, { model_providers: { "hedge-proxy": { ...hedgeProxy, base_url: "https://gateway.example.com/v1" } } }, { model_providers: { "hedge-proxy": keyless } }, { model_providers: { "hedge-proxy": { ...hedgeProxy, wire_api: "chat" } } }];
  for (const config of configs) {
    const { machine, home, printed } = client({}, served);
    connected(home);
    codexRouted(home, config);
    expect(await cliProxy("check", machine, "codex")).toBe(1);
    expect(readCodex(home) as Record<string, unknown>).toEqual(config);
    expect(printed.join("\n")).toContain("has its own hedge-proxy provider table, which does not reach the proxy with this machine's key.");
  }
  const edited = client({}, served);
  connected(edited.home);
  codexRouted(edited.home, { model_providers: { "hedge-proxy": { ...hedgeProxy, http_headers: { "X-Team": "mine" } } } });
  expect(await cliProxy("check", edited.machine, "codex")).toBe(0);
});

test("remove stops and deletes the proxy's unit, keeps its keys, config and subscriptions, and left then reports nothing left", async () => {
  const { machine, home } = hubMachine();
  await cliProxy("install", machine);
  expect(await cliProxy("left", machine)).toBe(0);
  const removing = hubMachine({ home });
  expect(await cliProxy("remove", removing.machine)).toBe(0);
  expect(removing.calls).toEqual(["systemctl --user disable --now hedge-cli-proxy.service", "systemctl --user daemon-reload"]);
  expect(existsSync(unitFile(home))).toBe(false);
  for (const path of [keyFile(home), join(dataDir(home), "management.env"), join(dataDir(home), "config.yaml"), join(dataDir(home), "auth")]) expect([path, existsSync(path)]).toEqual([path, true]);
  expect(await cliProxy("left", removing.machine)).toBe(1);
});
