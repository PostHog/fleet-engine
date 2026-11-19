import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub, RunResult } from "./hub.ts";

export const managementToken = "management-token";

export type ApiCall = { method: string; path: string; body?: Record<string, unknown> };
export type FakeMcpHub = {
  servers: string[];
  toolCounts: Record<string, number>;
  configs: Record<string, Record<string, unknown>>;
  keepsConfig: boolean;
  groups: Array<{ id: string; name: string; servers: Array<string | ({ name: string } & Record<string, unknown>)> }>;
  calls: ApiCall[];
  healthy: boolean;
  openWithoutKey: boolean;
  notReadyFor: number;
  oauthClients: Record<string, { clientId: string; clientSecret?: string }>;
  bindings: Record<string, Record<string, string>>;
  received: Array<ReturnType<typeof upstreamRequest>>;
  failing: string[];
  lateRegistrations: Record<string, { clientId: string; clientSecret?: string }>;
  home?: string;
};

export function fakeMcpHub(fields: Partial<FakeMcpHub> = {}): FakeMcpHub {
  return { servers: ["tickets", "calendar"], toolCounts: {}, configs: {}, keepsConfig: true, groups: [], calls: [], healthy: true, openWithoutKey: false, notReadyFor: 0, oauthClients: {}, bindings: {}, received: [], failing: [], lateRegistrations: {}, ...fields };
}

function keyOf(state: FakeMcpHub) {
  if (!state.home) return managementToken;
  const settings = JSON.parse(readFileSync(join(state.home, ".local/share/hedge-mcphub/data/mcp_settings.json"), "utf8")) as { bearerKeys: Array<{ id: string; token: string }> };
  return settings.bearerKeys.find((key) => key.id === "hedge-management")!.token;
}

const toolsOf = (state: FakeMcpHub, name: string) => Array.from({ length: state.toolCounts[name] ?? 2 }, () => ({}));

export function mcphubFetch(state: FakeMcpHub) {
  return async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const authorized = new Headers(init.headers).get("authorization") === `Bearer ${keyOf(state)}`;
    if (url.origin !== "http://127.0.0.1:3317") throw new TypeError("unexpected host");
    if (url.pathname === "/health") return new Response(null, { status: state.healthy ? 200 : 503 });
    if (url.pathname === "/mcphub/mcp") return new Response(null, { status: authorized || state.openWithoutKey ? 200 : 401 });
    if (!url.pathname.startsWith("/mcphub/api/")) return new Response(null, { status: 404 });
    if (state.notReadyFor > 0) { state.notReadyFor--; throw new TypeError("connection refused"); }
    if (!authorized) return new Response(null, { status: 401 });
    const path = url.pathname.slice("/mcphub/api/".length);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    state.calls.push({ method, path, ...(body ? { body } : {}) });
    if (state.failing.includes(`${method} ${path}`) || state.failing.includes(`${method} ${path} ${JSON.stringify(body)}`)) return new Response(null, { status: 500 });
    if (method === "GET" && path === "servers") return Response.json({ success: true, data: state.servers.map((name) => ({ name, status: "connected", tools: toolsOf(state, name) })) });
    if (method === "GET" && path === "groups") return Response.json({ success: true, data: state.groups });
    if (method === "POST" && path === "groups") {
      const group = { id: `group-${state.groups.length + 1}`, name: String(body!.name), servers: body!.servers as FakeMcpHub["groups"][number]["servers"] };
      state.groups.push(group);
      return Response.json({ success: true, data: group }, { status: 201 });
    }
    const group = path.match(/^groups\/(.+)$/);
    if (method === "PUT" && group) {
      const found = state.groups.find((item) => item.id === decodeURIComponent(group[1]!));
      if (!found) return new Response(null, { status: 404 });
      found.servers = body!.servers as FakeMcpHub["groups"][number]["servers"];
      return Response.json({ success: true, data: found });
    }
    if (method === "POST" && path === "auth/keys") return Response.json({ success: true, data: { id: "key-new", token: "mcphub_new-machine-token", ...body } }, { status: 201 });
    if (method === "PUT" && path.startsWith("auth/keys/")) return Response.json({ success: true, data: body });
    if (method === "POST" && /^servers\/[^/]+\/reload$/.test(path)) return Response.json({ success: true });
    const disconnect = path.match(/^servers\/([^/]+)\/oauth\/disconnect$/);
    if (method === "POST" && disconnect) {
      const name = decodeURIComponent(disconnect[1]!);
      const { accessToken: _access, refreshToken: _refresh, clientId, clientSecret, ...oauth } = (state.configs[name]?.oauth ?? {}) as Record<string, unknown>;
      if (body?.scope === "all") delete state.oauthClients[name];
      if (state.configs[name]?.oauth) state.configs[name]!.oauth = body?.scope === "all" ? oauth : { ...oauth, clientId, clientSecret };
      connect(state, name);
      const late = state.lateRegistrations[name];
      if (late) {
        delete state.lateRegistrations[name];
        state.oauthClients[name] = late;
        if (state.configs[name]?.oauth) state.configs[name]!.oauth = { ...(state.configs[name]!.oauth as Record<string, unknown>), ...late };
      }
      return Response.json({ success: true });
    }
    const toggle = path.match(/^servers\/([^/]+)\/toggle$/);
    if (method === "POST" && toggle) {
      const name = decodeURIComponent(toggle[1]!);
      state.configs[name]!.enabled = body!.enabled;
      connect(state, name);
      return Response.json({ success: true });
    }
    const server = path.match(/^servers\/([^/]+)$/);
    const name = server ? decodeURIComponent(server[1]!) : String(body?.name);
    const refused = (config: Record<string, any>) => Array.isArray(config.credentialTemplate) && config.credentialTemplate.length > 0 && Object.keys(config.oauth ?? {}).length > 0;
    const stored = (config: Record<string, any>) => {
      const { startOnDemand, options, ...rest } = config;
      const kept = { ...options };
      delete kept.startOnDemand;
      state.configs[name] = state.keepsConfig ? { ...rest, type: rest.type ?? "stdio", ...(Object.keys(kept).length && { options: kept }), ...(startOnDemand === true && { startOnDemand: true }) } : { type: "stdio" };
    };
    if (method === "POST" && path === "servers") {
      if (state.servers.includes(name) || refused(body!.config as Record<string, unknown>)) return new Response(null, { status: 400 });
      state.servers.push(name), stored(body!.config as Record<string, unknown>), connect(state, name);
      return Response.json({ success: true }, { status: 201 });
    }
    if (!server || !state.servers.includes(name)) return new Response(null, { status: 404 });
    if (method === "GET") return Response.json({ success: true, data: { name, status: "connected", tools: toolsOf(state, name), config: state.configs[name] ?? {} } });
    if (method === "PUT" && refused(body!.config as Record<string, unknown>)) return new Response(null, { status: 400 });
    if (method === "PUT") return stored(body!.config as Record<string, unknown>), connect(state, name), Response.json({ success: true });
    return new Response(null, { status: 404 });
  };
}

function connect(state: FakeMcpHub, name: string) {
  const config = state.configs[name];
  if (!config || config.enabled === false || typeof config.url !== "string") return;
  const oauth = config.oauth as Record<string, unknown> | undefined;
  if (oauth && !oauth.clientId && !state.oauthClients[name]) state.oauthClients[name] = { clientId: `registered-at-${new URL(config.url).origin}` };
  state.received.push(upstreamRequest(state, name));
}

function upstreamRequest(state: FakeMcpHub, name: string) {
  const config = state.configs[name] ?? {};
  const oauth = (config.oauth ?? {}) as Record<string, unknown>;
  const slots = Array.isArray(config.credentialTemplate) ? (config.credentialTemplate as Array<{ target: string; name: string }>) : [];
  const bound = Object.fromEntries(slots.filter((slot) => slot.target === "headers").map((slot) => [slot.name, state.bindings[name]?.[`headers.${slot.name}`]]));
  const client = state.oauthClients[name] ?? (oauth.clientId ? { clientId: oauth.clientId, clientSecret: oauth.clientSecret } : undefined);
  return { url: config.url, headers: { ...(config.headers as Record<string, string> | undefined), ...bound }, client, tokens: { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken } };
}

export type RunCall = { command: string[]; cwd?: string; input?: string };

export function fakeRun(answer: (call: RunCall) => Partial<RunResult> = () => ({})) {
  const calls: RunCall[] = [];
  const run = async (command: string[], options: { cwd?: string; input?: string } = {}): Promise<RunResult> => {
    const call = { command, ...options };
    calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...answer(call) };
  };
  return { calls, run };
}

export function writeMcpHubSettings(home: string, settings: Record<string, unknown> = {}) {
  const dir = join(home, ".local/share/hedge-mcphub/data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mcp_settings.json"), JSON.stringify({
    mcpServers: { tickets: {}, "calendar": {} },
    systemConfig: { install: { baseUrl: "http://127.0.0.1:3317/mcphub" } },
    bearerKeys: [{ id: "hedge-management", name: "Hedge local management", token: managementToken, enabled: true, kind: "system", accessType: "all" }],
    ...settings,
  }));
}

export function writeMachineFile(home: string, role: string) {
  mkdirSync(join(home, ".config/hedge"), { recursive: true });
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role }));
}

export function fakeHub(home: string, fields: Partial<Hub> = {}): Hub & { printed: string[] } {
  const printed: string[] = [];
  return {
    home,
    root: join(import.meta.dir, ".."),
    platform: "linux",
    uid: 1000,
    gid: 1000,
    hubName: () => "my-hub",
    gateway: {},
    run: fakeRun().run,
    fetch: mcphubFetch(fakeMcpHub({ home })),
    sleep: async () => {},
    print: (line) => { printed.push(line); },
    printed,
    ...fields,
  };
}

export const environmentOf = (home: string) => readFileSync(join(home, ".local/share/hedge-mcphub/runtime.env"), "utf8").split("\n").filter(Boolean);
const mounts = (command: string[]) => command.flatMap((arg, index) => (command[index - 1] === "-v" ? [{ Source: arg.split(":")[0]!, Destination: arg.split(":")[1]! }] : []));

export type FakeContainer = { Config: { Labels: Record<string, string>; Env: string[] }; Image: string; State: { Running: boolean }; Mounts: Array<{ Source?: string; Destination: string }> };

export function dockerHost(home: string, start?: FakeContainer) {
  let container = start;
  const answer = (call: RunCall) => {
    const [tool, noun, verb] = call.command;
    if (tool !== "docker") return {};
    if (noun === "container" && verb === "inspect") return container ? { stdout: JSON.stringify([container]) } : { code: 1, stderr: "No such container" };
    if (noun === "image" && verb === "inspect") return { stdout: JSON.stringify([{ Id: `sha256:${call.command[3]}` }]) };
    if (noun === "run") {
      const labels = Object.fromEntries(call.command.flatMap((arg, index) => (call.command[index - 1] === "--label" ? [arg.split("=")] : [])));
      container = { Config: { Labels: { ...labels, "org.hedge.patch": "1.1.0-elicitation" }, Env: [...environmentOf(home), "PATH=/usr/local/bin"] }, Image: `sha256:${call.command.at(-2)}`, State: { Running: true }, Mounts: mounts(call.command) };
    }
    if (noun === "stop") container!.State.Running = false;
    if (noun === "rm") container = undefined;
    return {};
  };
  return Object.assign(answer, { container: () => container });
}
