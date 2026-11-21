import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { inside } from "../../../src/files/install.ts";
import { templatePrefix, templatesDir, wantedTemplates } from "./templates.ts";
import type { Finding, Plan } from "../../../src/pack/types.ts";
import type { AdapterResult } from "../../../src/reconciler/apply.ts";
import type { RuntimeAdapter } from "../../../src/sdk/runtime.ts";
import { linkOnPath, readState, withLock, writeWithBackups, type Write } from "../../../src/adapters/provider-config/store.ts";
import { skipOtherHome, type HomeGuard } from "../../../src/adapters/run.ts";

export const herdrPack = "herdr";

const finding = (id: string, say: string, repair: Finding["repair"] = "human"): Finding => ({ id: `herdr:${id}`, pack: "engine", say, repair });

export const usesHerdr = (plan: Plan) => plan.packs.some((pack) => pack.name === herdrPack && pack.available);

export function herdrAdapter(options: HomeGuard = {}): RuntimeAdapter & { targets(): string[] } {
  return {
    targets: () => [],
    async apply(plan, { home, dryRun }) {
      const result: AdapterResult = { actions: [], findings: [] };
      const owned = await ownedTemplates(home);
      if (!usesHerdr(plan) && owned.length === 0) return result;
      const skipped = await skipOtherHome("herdr", "your Herdr templates", home, options);
      if (skipped) return skipped;
      const link = await linkOnPath(home, templatesDir);
      if (link) return result.findings.push(finding("link", `Left your Herdr templates alone: ${link} is a link. Hedge writes templates only through plain folders.`)), result;
      const reconcile = async () => {
        const wanted = usesHerdr(plan) ? wantedTemplates(plan.models) : new Map<string, string>();
        const writes: Write[] = [];
        for (const [target, after] of wanted) {
          const before = await readState(home, target);
          if (before !== after) writes.push({ target, before, after });
        }
        const stale = owned.filter((target) => !wanted.has(target));
        for (const write of writes) result.actions.push({ target: write.target, operation: write.before === undefined ? "create" : "replace" });
        for (const target of stale) result.actions.push({ target, operation: "remove" });
        if (dryRun) return result;
        await writeWithBackups(home, writes);
        for (const target of stale) await rm(inside(home, target), { force: true });
        return result;
      };
      return dryRun ? reconcile() : withLock(home, reconcile);
    },
  };
}

async function ownedTemplates(home: string): Promise<string[]> {
  const names = await readdir(inside(home, templatesDir)).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(templatePrefix) && name.endsWith(".md")).sort().map((name) => join(templatesDir, name));
}
