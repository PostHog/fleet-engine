import { readFileSync, writeFileSync } from "node:fs";
import { fakeCrontab, runners } from "./old-fleet.ts";
import { fakeSystemd } from "./systemd.ts";

/** What the fake schedulers hold between calls. both names each time a new unit started while its old one ran. */
export type SchedulerState = { units: Record<string, { active: boolean; enabled: boolean }>; failing: string[]; crontab: string; both: string[] };

export const emptySchedulers = (): SchedulerState => ({ units: {}, failing: [], crontab: "", both: [] });

/** Runs one systemctl or crontab command against the state in a file, as a real scheduler keeps its state between commands. */
export async function runScheduler(stateFile: string, command: string[], input: string | undefined) {
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as SchedulerState;
  const systemd = fakeSystemd();
  for (const [unit, value] of Object.entries(state.units)) systemd.units.set(unit, value);
  for (const unit of state.failing) systemd.failing.add(unit);
  const cron = fakeCrontab(state.crontab);
  try {
    return await runners(systemd.run, cron.run)(command, input === undefined ? {} : { input });
  } catch (error) {
    state.both.push((error as Error).message);
    return { code: 1, stdout: "", stderr: `${(error as Error).message}\n` };
  } finally {
    writeFileSync(stateFile, JSON.stringify({ ...state, units: Object.fromEntries(systemd.units), crontab: cron.table.text }));
  }
}

if (import.meta.main) {
  const [stateFile, ...command] = process.argv.slice(2);
  const input = command.join(" ") === "crontab -" ? await Bun.stdin.text() : undefined;
  const answer = await runScheduler(stateFile!, command, input);
  process.stdout.write(answer.stdout);
  process.stderr.write(answer.stderr ?? "");
  process.exit(answer.code);
}
