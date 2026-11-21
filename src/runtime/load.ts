import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { LoadedPack, Plan } from "../pack/types.ts";
import type { AgentRuntime, RuntimeThreads } from "../sdk/runtime.ts";

export const runtimeSetting = "base.runtime";
export const defaultRuntime = "t3";

export type LoadRuntime = (path: string) => Promise<AgentRuntime>;

const loaded = new Map<string, Promise<AgentRuntime>>();

export const importRuntime: LoadRuntime = (path) => {
  let runtime = loaded.get(path);
  if (!runtime) {
    runtime = import(path).then((module: { default?: AgentRuntime }) => {
      if (!module.default?.name || typeof module.default.threads !== "function") throw new Error(`${path} does not export an agent runtime as its default`);
      return module.default;
    });
    loaded.set(path, runtime);
  }
  return runtime;
};

export function selectedRuntime(plan: Pick<Plan, "runtime" | "runtimes">): { name: string; pack: string; path: string } | undefined {
  const name = plan.runtime;
  const entry = name ? plan.runtimes?.[name] : undefined;
  return name && entry ? { name, ...entry } : undefined;
}

/** Threads that load their implementation on first use. */
export function lazyThreads(load: () => Promise<RuntimeThreads>): RuntimeThreads {
  let threads: Promise<RuntimeThreads> | undefined;
  const get = () => (threads ??= load());
  return {
    start: async (def) => (await get()).start(def),
    send: async (def) => (await get()).send(def),
    list: async (options) => (await get()).list(options),
    find: async (id, options) => (await get()).find(id, options),
    read: async (id, options) => (await get()).read(id, options),
    machines: async () => (await get()).machines(),
  };
}

/** The selected runtime's threads, loaded on first use, so a command that never starts a thread works while no runtime loads. */
export function planThreads(plan: Pick<Plan, "runtime" | "runtimes" | "models">, home: string, load: LoadRuntime = importRuntime): RuntimeThreads {
  return lazyThreads(async () => (await planRuntime(plan, load)).threads({ home, models: plan.models }));
}

/** The runtimes that these packs bring, by name; a runtime whose module fails to load is left out. */
export async function packRuntimes(packs: LoadedPack[], load: LoadRuntime = importRuntime): Promise<Map<string, AgentRuntime>> {
  const runtimes = new Map<string, AgentRuntime>();
  for (const { manifest, dir } of packs) {
    if (!manifest.runtime || runtimes.has(manifest.runtime.name)) continue;
    const runtime = await load(join(dir, manifest.runtime.path)).catch(() => undefined);
    if (runtime) runtimes.set(manifest.runtime.name, runtime);
  }
  return runtimes;
}

/** The named runtime among the engine's own packs, for a command that runs before a profile exists. */
export async function engineRuntime(engineRoot: string, name: string): Promise<AgentRuntime | undefined> {
  const packs = await loadPacks(engineRoot).catch(() => []);
  return (await packRuntimes(packs.filter((pack) => pack.manifest.runtime?.name === name))).get(name);
}

export async function planRuntime(plan: Pick<Plan, "runtime" | "runtimes">, load: LoadRuntime = importRuntime): Promise<AgentRuntime> {
  const selected = selectedRuntime(plan);
  if (!selected) throw new Error(`No pack on this machine brings the ${plan.runtime ?? defaultRuntime} runtime that ${runtimeSetting} names.`);
  return load(selected.path);
}
