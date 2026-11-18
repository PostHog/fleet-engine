import { join } from "node:path";
import { become } from "../../../src/runner/become.ts";
import { runCommand } from "../lib/command.ts";
import { numberSetting } from "../lib/settings.ts";

await runCommand(() => {
  const { HEDGE_HEAVY_ROUTE: _, HEDGE_HEAVY_ROUTED: routed, ...inherited } = Bun.env;
  const route = routed ? undefined : (JSON.parse(Bun.env.HEDGE_HANDLERS || "{}") as Record<string, string>)["heavy-route"];
  const env = { ...inherited, HEDGE_HEAVY_SLOTS: Bun.env.HEDGE_HEAVY_SLOTS || String(numberSetting("base.heavySlots")), ...(route ? { HEDGE_HEAVY_ROUTE: route } : {}) };
  return become(["sh", join(import.meta.dir, "../lib/heavy.sh"), ...Bun.argv.slice(2)], env);
});
