import type { ExecResult, Machine } from "../../../../src/setup/commands.ts";
import { pollMs } from "../../../../src/setup/human.ts";
import type { NodeSignIn } from "../../../../src/sdk/runtime.ts";

/** T3 Connect on the box: t3 up signs in, installs the relay client, and restarts the service so the link takes effect. */
export function t3Connect(host: string, box: Machine): NodeSignIn {
  return {
    id: "t3",
    title: `Link T3 Connect on ${host}`,
    why: "T3 Code on your other devices reaches the devbox through T3 Connect.",
    command: ["t3", "up", "--connect", "--yes", "--headless"],
    probe: async () => (await linkedStatus(box)) !== undefined,
  };
}

/** Where other machines reach this one through T3 Connect, once it is linked: its own tunnel, never the shared relay. */
async function connectAddress(machine: Machine): Promise<string | undefined> {
  const state = await linkedStatus(machine);
  if (!state) return undefined;
  const tunnel = hostnameOf(state.tunnelHostname) ?? (await tunnelFromServer(machine));
  return tunnel && `https://${tunnel}`;
}

async function linkedStatus(machine: Machine) {
  const state = await connectStatus(machine);
  return state && isLinked(state) ? state : undefined;
}

const connectStatus = async (machine: Machine) => parsed<{ desired?: unknown; authenticated?: unknown; linked?: unknown; tunnelHostname?: unknown }>(await machine.exec(["t3", "connect", "status", "--json"]));

const isLinked = (state: { authenticated?: unknown; linked?: unknown }) => state.authenticated === true && state.linked === true;

/** Waits a bounded time for a tunnel that is still starting after T3 Connect links. */
export async function connectAddressWithin(machine: Machine): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    const address = await connectAddress(machine);
    if (address || attempt === tunnelStartPolls) return address;
    await machine.sleep(pollMs);
  }
}

const tunnelStartPolls = 15;

export async function addressHere(machine: Machine, rerun: string): Promise<{ on: boolean; address?: string }> {
  const state = await connectStatus(machine);
  if (!state) throw new Error(`T3 Code here did not answer t3 connect status. Check that T3 Code runs here, then run ${rerun} again.`);
  if (!isLinked(state) && state.desired === false) return { on: false };
  if (!isLinked(state)) throw new Error(`T3 Connect here is not ready: t3 connect status says authenticated ${String(state.authenticated)} and linked ${String(state.linked)}. Wait until T3 Code here is up, or run t3 up --connect here, then run ${rerun} again.`);
  const address = await connectAddressWithin(machine);
  return address ? { on: true, address } : { on: true };
}

export async function printableAddress(machine: Machine) {
  const here = await addressHere(machine, "hedge devbox address");
  if (!here.on) throw new Error("T3 Connect is off on this machine. Turn it on with t3 up --connect.");
  if (!here.address) throw new Error("T3 Connect is on here, but T3 Code gives no tunnel address for this machine yet.");
  return here.address;
}

/** For T3 CLIs that do not print the tunnel hostname yet: asks the live T3 server on that machine with a short read-only session, and revokes the session after. */
async function tunnelFromServer(machine: Machine): Promise<string | undefined> {
  const origin = await liveServerOrigin(machine);
  if (!origin) return undefined;
  const session = parsed<{ sessionId?: unknown; token?: unknown }>(await machine.exec(["t3", "auth", "session", "issue", "--json", "--ttl", "5m", "--label", "hedge", "--subject", "hedge", "--scope", "relay:read"]));
  if (typeof session?.sessionId !== "string" || typeof session.token !== "string") return undefined;
  try {
    const headers = `authorization: Bearer ${session.token}\nx-t3-orchestration-protocol: 2\n`;
    const linkState = parsed<{ tunnelHostname?: unknown }>(await machine.exec(["curl", "-q", "--noproxy", "*", "-fsS", "--max-time", "15", "-H", "@-", `${origin}/api/connect/link-state`], { input: headers }));
    return hostnameOf(linkState?.tunnelHostname);
  } finally {
    await machine.exec(["t3", "auth", "session", "revoke", session.sessionId]);
  }
}

function parsed<T>(result: ExecResult): T | undefined {
  if (result.code !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as T;
  } catch {
    return undefined;
  }
}

/** The T3 server's own record of where it listens, read from the same base directory the t3 commands here use (a T3CODE_HOME that T3 would trim, expand, or resolve is refused), trusted only at a numeric loopback address and while its process runs: the record T3's own CLI sends its relay sessions to. A dev server keeps its record elsewhere, so Hedge does not guess it. */
async function liveServerOrigin(machine: Machine): Promise<string | undefined> {
  const runtime = parsed<{ origin?: unknown; pid?: unknown }>(await machine.exec(["sh", "-c", runtimeRecord]));
  const url = loopbackUrl(runtime?.origin);
  const pid = runtime?.pid;
  if (!url || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  return (await machine.exec(["sh", "-c", `kill -0 ${pid}`])).code === 0 ? url.origin : undefined;
}

export async function tunnelLimitReached(machine: Machine) {
  const log = await machine.exec(["sh", "-c", recentServiceLog]);
  if (log.code !== 0) return undefined;
  const sinceStart = log.stdout.slice(log.stdout.lastIndexOf(serverStarted) + 1);
  return sinceStart.match(tunnelLimit)?.at(-1);
}

const serverStarted = "Listening on http";

const tunnelLimit = /Relay managed tunnel limit reached: this account allows at most \d+ tunnels?/g;

export const t3HomeGuard = `case "$T3CODE_HOME" in *[![:graph:]]* | [!/]* | */../* | */..) exit 1 ;; esac;`;

const runtimeRecord = `${t3HomeGuard} [ -z "$VITE_DEV_SERVER_URL" ] && cat "\${T3CODE_HOME:-$HOME/.t3}/userdata/server-runtime.json"`;

const recentServiceLog = `${t3HomeGuard} tail -c 2000000 "\${T3CODE_HOME:-$HOME/.t3}/userdata/logs/boot-service.log"`;

function loopbackUrl(value: unknown) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

const hostnameOf = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** Reads `t3 pair` output: where the environment answers, and the one-time code. */
export function pairing(output: string): { url: string; code: string } | undefined {
  const url = output.match(/^Pairing URL: (\S+)/m)?.[1];
  const code = output.match(/^Token: (\S+)/m)?.[1];
  if (!url || !code) return undefined;
  try {
    return { url: new URL(url).origin, code };
  } catch {
    return undefined;
  }
}
