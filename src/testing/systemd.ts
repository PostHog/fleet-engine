import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../adapters/run.ts";

/** The unit from before the rename that a hedge- unit replaces. */
export const oldUnit = (unit: string) => (unit.startsWith("hedge-") ? `fleet-${unit.slice("hedge-".length).replace(/^hedge-/, "fleet-")}` : undefined);

/** A systemd user manager. It refuses to start a hedge- unit while its fleet- unit runs, so a test that runs both fails. shown replaces what show prints for a unit, as a unit stuck in a state would. fileless units run with no unit file, so list-unit-files leaves them out. */
export function fakeSystemd() {
  const units = new Map<string, { active: boolean; enabled: boolean }>();
  const shown = new Map<string, string>();
  const fileless = new Set<string>();
  const starts = new Map<string, number>();
  const calls: string[][] = [];
  const start = (unit: string) => {
    const old = oldUnit(unit);
    if (old && units.get(old)?.active) throw new Error(`systemd started ${unit} while ${old} still runs`);
  };
  const listed = (pattern: string) => [...units.keys()].filter((unit) => unit.startsWith(pattern.replace(/\*$/, "")));
  const run: CommandRunner = async (command) => {
    calls.push(command);
    if (command[0] !== "systemctl" || command[1] !== "--user") return { code: 127, stdout: "" };
    const [verb, ...rest] = command.slice(2);
    const unit = rest.at(-1)!;
    const state = units.get(unit) ?? { active: false, enabled: false };
    if (verb === "list-units") return { code: 0, stdout: listed(unit).map((name) => `${name} loaded ${units.get(name)!.active ? "active running" : "inactive dead"} Fleet\n`).join("") };
    if (verb === "list-unit-files") {
      const files = listed(unit).filter((name) => !fileless.has(name)).map((name) => `${name} ${units.get(name)!.enabled ? "enabled" : "disabled"} enabled\n`);
      return { code: files.length ? 0 : 1, stdout: files.join("") };
    }
    if (verb === "show") {
      if (shown.has(unit)) return { code: 0, stdout: shown.get(unit)! };
      const known = units.has(unit);
      return { code: 0, stdout: `LoadState=${known ? "loaded" : "not-found"}\nActiveState=${state.active ? "active" : "inactive"}\nUnitFileState=${state.enabled ? "enabled" : known ? "disabled" : ""}\nNeedDaemonReload=no\n` };
    }
    if (verb === "enable") units.set(unit, { ...state, enabled: true });
    if (verb === "restart" || verb === "start") start(unit), units.set(unit, { ...state, active: true }), starts.set(unit, (starts.get(unit) ?? 0) + 1);
    if (verb === "disable") units.set(unit, { active: rest.includes("--now") ? false : state.active, enabled: false });
    if (verb === "stop") units.set(unit, { ...state, active: false });
    return { code: 0, stdout: "" };
  };
  const service = (home: string, id: string) => {
    const unit = `hedge-${id}.service`;
    const parts = [existsSync(join(home, ".config/systemd/user", unit)), units.get(unit)?.active === true, units.get(unit)?.enabled === true];
    return parts.every(Boolean) ? "running" : parts.some(Boolean) ? "partly removed" : "gone";
  };
  const started = (id: string) => starts.get(`hedge-${id}.service`) ?? 0;
  return { run, service, started, units, shown, fileless, calls };
}
