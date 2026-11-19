import { existsSync } from "node:fs";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MachineFile } from "../pack/types.ts";
import { loadProfile, saveMachine } from "../profile/profile.ts";
import type { Machine } from "./commands.ts";
import { boxEnvironmentId, validEnvironmentId } from "./devbox.ts";
import type { Terminal } from "./terminal.ts";

export type BalanceContext = { home: string; terminal: Terminal; machine: Machine; machineFile: MachineFile };

type Weights = Record<string, number>;

const normal = 50;
const manualOnly = 0;
const manualSteps = "In T3 Code, open Settings → Environments → Load balancing, turn it on, and set this Mac and the hub to Manual only.";

/** T3 Code on the Mac starts new threads on the nodes: the hub, and the Mac itself until someone sets it, go to Manual only. A weight already set stays, so a node someone drains keeps draining. Hedge changes nothing unless it knows the ids of the Mac and the hub, so neither takes threads by T3's default. */
export async function balanceThreads(context: BalanceContext) {
  const { terminal, machineFile } = context;
  if (machineFile.role !== "mac" || !machineFile.profileDir) return;
  const { hub, devboxes = [] } = await loadProfile(machineFile.profileDir);
  const nodes = devboxes.filter((host) => host !== hub);
  if (!nodes.length) return terminal.print("· New threads stay on this Mac until a node runs. Add one with hedge devbox add <ssh host>.");
  const userdata = join(context.home, ".t3", "userdata");
  const path = settingsPath(context.home);
  if (!existsSync(userdata)) return terminal.print(`· T3 Code has not run on this Mac yet. Once it has, ${manualSteps}`);
  const ids = await environmentIds(context, [...new Set([...devboxes, ...(hub ? [hub] : [])])]);
  const here = validEnvironmentId(await readFile(join(userdata, "environment-id"), "utf8").catch(() => ""));
  if (!here) return terminal.print(`· Hedge cannot read T3 Code's id on this Mac, so it left load balancing alone. ${manualSteps}`);
  const hubId = hub && ids.get(hub);
  if (hub && !hubId) return terminal.print(`· Hedge cannot reach T3 Code on the hub, ${hub}, so it left load balancing alone. ${manualSteps}`);
  const document = await readDocument(path);
  if (!document) return terminal.print(`· Hedge cannot read ${path}, so it left it alone. ${manualSteps}`);
  const weights: Weights = { ...document.weights };
  weights[here] ??= manualOnly;
  for (const host of nodes) {
    const id = ids.get(host);
    if (id) weights[id] ??= normal;
  }
  if (hubId) weights[hubId] = manualOnly;
  await writeDocument(path, document.with({ loadBalancingEnabled: true, loadBalancingWeights: weights }));
  const share = (id: string | undefined) => (id === undefined ? normal : (weights[id] ?? normal)) > 0;
  const taking = [...nodes.filter((host) => share(ids.get(host))), ...(share(here) ? ["this Mac"] : [])];
  terminal.print(taking.length ? `✓ T3 Code on this Mac starts new threads on ${taking.join(" and ")}. Quit and reopen T3 Code so it reads this.` : `· Every node is set to Manual only in T3 Code on this Mac, so new threads start where you choose. ${manualSteps}`);
}

/** The id T3 Code goes by on each host, as the host reports it, or as Hedge recorded it when the host last answered. Hedge records each answer, so a host that is gone later is still known by its id. */
async function environmentIds(context: BalanceContext, hosts: string[]) {
  const recorded = { ...context.machineFile.t3Environments };
  const ids = new Map<string, string>();
  for (const host of hosts) {
    const id = (await boxEnvironmentId(context.machine, host)) ?? recorded[host];
    if (id) ids.set(host, id);
  }
  const learned = Object.fromEntries(ids);
  if (Object.entries(learned).some(([host, id]) => recorded[host] !== id)) {
    context.machineFile.t3Environments = { ...recorded, ...learned };
    await saveMachine(context.home, context.machineFile);
  }
  return ids;
}

/** Drops a machine that left from T3 Code's load balancing on this Mac. */
export async function forgetWeight(home: string, id: string) {
  const path = settingsPath(home);
  if (!existsSync(path)) return;
  const document = await readDocument(path);
  if (!document || !(id in document.weights)) return;
  const { [id]: _, ...kept } = document.weights;
  await writeDocument(path, document.with({ loadBalancingWeights: kept }));
}

const settingsPath = (home: string) => join(home, ".t3", "userdata", "client-settings.json");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** T3 Code's client settings, which an older T3 wrapped in a settings key that T3 still reads first. */
async function readDocument(path: string): Promise<{ weights: Weights; with(changes: Record<string, unknown>): Record<string, unknown> } | undefined> {
  let root: unknown = {};
  try {
    if (existsSync(path)) root = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(root)) return undefined;
  const document = root;
  const wrapped = Object.hasOwn(document, "settings");
  const settings = wrapped ? document.settings : document;
  if (!isRecord(settings)) return undefined;
  const weights = settings.loadBalancingWeights ?? {};
  if (!isRecord(weights)) return undefined;
  return {
    weights: weights as Weights,
    with: (changes) => (wrapped ? { ...document, settings: { ...settings, ...changes } } : { ...settings, ...changes }),
  };
}

/** Replaces the file T3 Code reads, through a symlink when the settings are one, as T3 itself writes them. */
async function writeDocument(path: string, document: Record<string, unknown>) {
  const target = await realpath(path).catch(() => path);
  const temporary = `${target}.hedge-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
  await rename(temporary, target);
}
