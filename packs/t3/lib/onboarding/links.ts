import { hostname } from "node:os";
import { onHub, quote } from "../../../../src/hub/ssh.ts";
import type { ExecResult, Machine } from "../../../../src/setup/commands.ts";
import type { NodeIds, OnboardingContext } from "../../../../src/sdk/runtime.ts";
import { restartCommand } from "../adapter/service.ts";
import { forgetWeight } from "./balance.ts";
import { addressHere, connectAddressWithin, pairing, t3HomeGuard, tunnelLimitReached } from "./connect.ts";

/** This machine links the devbox through its T3 Connect address; the devbox links back only when T3 Connect is on here too. */
export async function linkBothWays(host: string, { here: machine, on, print, rerun }: OnboardingContext) {
  const box = on(host);
  const here = hostname();
  const link = async (from: Machine, fromName: string, address: string, to: Machine, toName: string) => {
    const paired = await from.exec(["t3", "pair", "--ttl", "5m", "--label", toName]);
    const found = paired.code === 0 ? pairing(paired.output) : undefined;
    if (!found) throw new Error(`${fromName} did not give a pairing code. Check that T3 Code runs there, then run ${rerun} again.`);
    const linked = await to.exec(["t3", "environment", "link", address, "--pairing-code", found.code, "--access", "full-access"]);
    if (linked.code !== 0) throw new Error(`could not link ${fromName} from ${toName}: ${linked.output.trim().split("\n").at(-1) ?? ""}`);
  };
  const boxAddress = await connectAddressWithin(box);
  const limit = boxAddress ? undefined : await tunnelLimitReached(box);
  if (limit) throw new Error(`${host} has no T3 Connect tunnel: T3 Code there says ${limit}. Free one: run t3 connect logout on a machine that no longer needs T3 Connect, or unlink it in T3 Connect. Then run ${restartCommand} on ${host}, and run ${rerun} again.`);
  if (!boxAddress) throw new Error(`${host} has no T3 Connect address yet. Update T3 Code on ${host}, then run ${rerun} again.`);
  await link(box, host, boxAddress, machine, here);
  const connectHere = await addressHere(machine, rerun);
  if (connectHere.address) await link(machine, here, connectHere.address, box, host);
  else if (connectHere.on) throw new Error(`T3 Connect is on here, but Hedge could not find this machine's tunnel address. Update T3 Code here, then run ${rerun} again so ${host} links back.`);
  else print(`  · ${host} does not link back to this machine, because T3 Connect is off here. Turn it on with t3 up --connect, and T3 Code on ${host} can pair with this machine.`);
}

const hubLinkLimitMs = 5 * 60_000;
const remotePath = `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH";`;

export async function linkFromHub(host: string, hub: string, { here, on, print, hubIsHere, hubTook }: OnboardingContext & { hubIsHere: boolean; hubTook: boolean }) {
  const id = await nodeEnvironmentId(on(host));
  const link = id === undefined ? undefined : (await t3Links(hubIsHere ? here : on(hub))).find((entry) => entry.environmentId === id);
  if (link?.status === "reachable") return print(`✓ The hub, ${hub}, reaches ${host} in T3 Code.`);
  const linked = hubTook && (await here.exec(onHub(hub, ["peers", "link", host]), { timeoutMs: hubLinkLimitMs })).code === 0;
  const fix = hubIsHere ? `run hedge peers link ${host} here now` : `run ssh ${hub} ${quote(`${remotePath} hedge peers link ${host}`)} now`;
  const state = link ? `lists ${host} in T3 Code as ${link.status ?? "not reachable"}` : `has not linked ${host} in T3 Code yet`;
  print(linked ? `✓ The hub, ${hub}, linked ${host} in T3 Code.` : `· The hub, ${hub}, ${state}. To link it, ${fix}.`);
}

/** Unlinks the host in T3 Code here, and drops its load balancing weight. It unlinks first, so a failed unlink changes nothing and a second run tries again. */
export async function unlink(host: string, { here, on, home, ids, rerun }: OnboardingContext & { home: string; ids: NodeIds }) {
  const links = await t3Links(here);
  const id = await environmentOf(host, ids, links, on(host));
  const linked = id !== undefined && links.some((link) => link.environmentId === id);
  if (linked) {
    const unlinked = await here.exec(["t3", "environment", "unlink", id]);
    if (unlinked.code !== 0) throw new Error(`T3 Code here could not unlink ${host}: ${unlinked.output.trim().split("\n").at(-1) ?? ""} Fix that, then run ${rerun} again.`);
  }
  if (id) await forgetWeight(home, id);
  return linked ? { unlinked: true } : { unlinked: false, hint: `T3 Code here has no link to ${host} that Hedge can find. When T3 Code still lists it, remove it in Settings → Environments.` };
}

/** The id Hedge recorded for the host when it last answered; else the id the host reports, unless Hedge recorded it for another host; else the one link here labelled with its name. */
async function environmentOf(host: string, recorded: NodeIds, links: T3Link[], node: Machine) {
  if (recorded[host]) return recorded[host];
  const reported = await nodeEnvironmentId(node);
  const others = Object.entries(recorded).filter(([name]) => name !== host).map(([, id]) => id);
  if (reported && !others.includes(reported)) return reported;
  return linkByLabel(links, host)?.environmentId;
}

/** A workspace that is gone and was never recorded cannot say its id, so the one link here labelled with its name stands in, as T3 often labels a machine by its host name. */
function linkByLabel(links: T3Link[], host: string) {
  const names = new Set([host, host.replace(/^coder\./, "")]);
  const matching = links.filter((link) => link.label !== undefined && names.has(link.label));
  return matching.length === 1 ? matching[0] : undefined;
}

export type T3Link = { environmentId: string; label?: string; status?: string };

export async function t3Links(machine: Machine): Promise<T3Link[]> {
  const links = parsedList(await machine.exec(["t3", "environment", "list", "--json"]));
  return links.filter((link): link is T3Link => typeof link?.environmentId === "string" && (link.status === undefined || typeof link.status === "string"));
}

function parsedList(result: ExecResult): Array<{ environmentId?: unknown; label?: string; status?: unknown }> {
  if (result.code !== 0) return [];
  try {
    const list: unknown = JSON.parse(result.stdout);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** The id T3 Code on that host goes by, the key of its load balancing weight and of its link here. */
export async function nodeEnvironmentId(node: Machine) {
  return validEnvironmentId((await node.exec(["sh", "-c", environmentIdScript])).stdout);
}

export function validEnvironmentId(text: string) {
  const id = text.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : undefined;
}

const environmentIdScript = `${t3HomeGuard} cat "\${T3CODE_HOME:-$HOME/.t3}/userdata/environment-id"`;
