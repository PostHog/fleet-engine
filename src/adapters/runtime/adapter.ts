import { rm } from "node:fs/promises";
import { inside } from "../../files/install.ts";
import type { Finding, Plan } from "../../pack/types.ts";
import { runtimeRecord, runtimeStateTarget } from "../../runtime/active.ts";
import { optional, writeWithBackups } from "../provider-config/store.ts";
import type { Adapter, AdapterResult } from "../../reconciler/apply.ts";
import { importRuntime, runtimeSetting, type LoadRuntime } from "../../runtime/load.ts";
import type { AgentRuntime, AgentTasks, RuntimeAdapter } from "../../sdk/runtime.ts";

/** scheduler: the runtime runs scheduled agent prompts itself. Without one, the Jobs adapter runs each as a timed job that starts a thread. */
export type SelectedTasks = { name: string; title: string; scheduler: boolean; tasks: AgentTasks | undefined };
export type EngineRuntimeAdapter = Adapter & { tasks(): Promise<SelectedTasks | undefined> };

type Loaded = { name: string; runtime: AgentRuntime; adapter?: RuntimeAdapter };

const finding = (id: string, say: string, repair: Finding["repair"] = "human"): Finding => ({ id: `runtime:${id}`, pack: "engine", say, repair });

export async function runtimeAdapter(plan: Plan | undefined, load: LoadRuntime = importRuntime): Promise<EngineRuntimeAdapter> {
  const loaded: Loaded[] = [];
  const failures: Finding[] = [];
  for (const [name, entry] of Object.entries(plan?.runtimes ?? {})) {
    try {
      const runtime = await load(entry.path);
      loaded.push({ name, runtime, adapter: runtime.adapter?.() });
    } catch (error) {
      failures.push(finding(`load:${name}`, `Hedge could not load the ${name} runtime of the ${entry.pack} pack: ${(error as Error).message}`));
    }
  }
  let applied = false;
  return {
    name: "runtime",
    targets: (current) => loaded.flatMap((item) => item.adapter?.targets?.(current) ?? []),
    async apply(current, context) {
      const result: AdapterResult = { actions: [], findings: [...failures] };
      if (current.runtime && Object.keys(current.runtimes ?? {}).length && !current.runtimes?.[current.runtime]) {
        result.findings.push(finding("missing", `${runtimeSetting} names the ${current.runtime} runtime, and no pack on this machine brings it. Add its pack with hedge packs --add <pack>, or set ${runtimeSetting} to a runtime you have.`));
      }
      const record = runtimeRecord(current, [...loaded].sort((a, b) => Number(b.name === current.runtime) - Number(a.name === current.runtime)).map((item) => item.runtime.threadVariable));
      const saved = record ? `${JSON.stringify(record, null, 2)}\n` : undefined;
      const before = await optional(inside(context.home, runtimeStateTarget));
      if (saved !== before) {
        result.actions.push({ target: runtimeStateTarget, operation: saved === undefined ? "remove" : before === undefined ? "create" : "replace" });
        if (!context.dryRun) {
          if (saved === undefined) await rm(inside(context.home, runtimeStateTarget), { force: true });
          else await writeWithBackups(context.home, [{ target: runtimeStateTarget, before, after: saved }]);
        }
      }
      for (const item of loaded) {
        if (!item.adapter) continue;
        const part = await item.adapter.apply(current, context);
        result.actions.push(...part.actions);
        result.findings.push(...part.findings);
        if (part.blocked) result.blocked = true;
        if (part.failed) result.failed = true;
      }
      applied = true;
      return result;
    },
    async tasks() {
      const selected = loaded.find((item) => item.name === plan?.runtime);
      if (!selected) return undefined;
      return { name: selected.name, title: selected.runtime.title, scheduler: Boolean(selected.adapter?.tasks), tasks: applied ? await selected.adapter?.tasks?.() : undefined };
    },
  };
}
