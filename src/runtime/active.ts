import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRow, Plan } from "../pack/types.ts";
import type { AgentRuntime, RuntimeThreads } from "../sdk/runtime.ts";
import { importRuntime, selectedRuntime, type LoadRuntime } from "./load.ts";

export const runtimeVariable = "HEDGE_RUNTIME";
export const runtimeStateTarget = ".local/state/hedge/runtime.json";

/**
 * What a pack command or a hook needs to reach the profile's runtime: hedge passes it in HEDGE_RUNTIME, and apply saves it
 * for hooks. threadVariables holds each runtime's thread variable; only the saved record has them, because apply loads the runtimes.
 */
export type RuntimeRecord = { name: string; path: string; runtimes: Record<string, string>; models: ModelRow[]; threadVariables?: string[] };

type Env = Record<string, string | undefined>;

export function runtimeRecord(plan: Pick<Plan, "runtime" | "runtimes" | "models">, threadVariables?: string[]): RuntimeRecord | undefined {
  const selected = selectedRuntime(plan);
  if (!selected) return undefined;
  return {
    name: selected.name, path: selected.path, runtimes: Object.fromEntries(Object.entries(plan.runtimes ?? {}).map(([name, entry]) => [name, entry.path])), models: plan.models,
    ...(threadVariables?.length ? { threadVariables } : {}),
  };
}

const parse = (text: string | undefined) => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as RuntimeRecord;
  } catch {
    return undefined;
  }
};

function readSaved(home: string): RuntimeRecord | undefined {
  try {
    return parse(readFileSync(join(home, runtimeStateTarget), "utf8"));
  } catch {
    return undefined;
  }
}

export function readRuntimeRecord(env: Env = Bun.env, home = env.HOME ?? homedir()): RuntimeRecord | undefined {
  const saved = readSaved(home);
  const passed = parse(env[runtimeVariable]);
  return passed ? { ...passed, ...(saved?.threadVariables ? { threadVariables: saved.threadVariables } : {}) } : saved;
}

export type ActiveRuntime = { runtime: AgentRuntime; threads: RuntimeThreads; record: RuntimeRecord };

/** The profile's runtime, for code that runs outside the engine's process: a pack command, a hook, or a service. */
export async function activeRuntime(env: Env = Bun.env, home = env.HOME ?? homedir(), load: LoadRuntime = importRuntime): Promise<ActiveRuntime> {
  const record = readRuntimeRecord(env, home);
  if (!record) throw new Error("Hedge has not chosen a runtime on this machine yet. Run hedge apply.");
  const runtime = await load(record.path);
  return { runtime, threads: runtime.threads({ home, models: record.models }), record };
}

const engineRoot = join(import.meta.dir, "..", "..");
let bundled: string[] | undefined;

/** The thread variables of the runtime packs that ship with the engine, for a machine where apply has not saved them yet. */
export function bundledThreadVariables(root = engineRoot): string[] {
  if (bundled && root === engineRoot) return bundled;
  const found: string[] = [];
  for (const name of readdirSync(join(root, "packs")).sort()) {
    const manifest = (() => {
      try {
        return JSON.parse(readFileSync(join(root, "packs", name, "pack.json"), "utf8")) as { runtime?: { path?: string } };
      } catch {
        return undefined;
      }
    })();
    if (!manifest?.runtime?.path) continue;
    const runtime = (require(join(root, "packs", name, manifest.runtime.path)) as { default?: AgentRuntime }).default;
    if (runtime?.threadVariable) found.push(runtime.threadVariable);
  }
  if (root === engineRoot) bundled = found;
  return found;
}

/** The id of the thread this process runs in, from the thread variable of any runtime on this machine. */
export function threadOfProcess(env: Env = Bun.env, home = env.HOME ?? homedir()): string | undefined {
  for (const name of readRuntimeRecord(env, home)?.threadVariables ?? bundledThreadVariables()) if (env[name]) return env[name];
  return undefined;
}

/** The same, with the runtime that set it, loading each runtime when apply has not saved their variables yet. */
export async function currentThread(env: Env = Bun.env, home = env.HOME ?? homedir(), load: LoadRuntime = importRuntime): Promise<{ runtime: string; id: string } | undefined> {
  const record = readRuntimeRecord(env, home);
  for (const [name, path] of Object.entries(record?.runtimes ?? {})) {
    const runtime = await load(path).catch(() => undefined);
    const id = runtime && env[runtime.threadVariable];
    if (id) return { runtime: name, id };
  }
  return undefined;
}
