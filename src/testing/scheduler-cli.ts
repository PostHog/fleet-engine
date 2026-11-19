import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fakeCrontab, runners } from "./old-fleet.ts";
import { fakeSystemd } from "./systemd.ts";

export type SchedulerState = { units: Record<string, { active: boolean; enabled: boolean }>; failing: string[]; crontab: string; both: string[]; stuck?: string[]; lastWords?: { unit: string; file: string; line: string }[] };

export const emptySchedulers = (): SchedulerState => ({ units: {}, failing: [], crontab: "", both: [] });

export async function runScheduler(stateFile: string, command: string[], input: string | undefined) {
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as SchedulerState;
  const systemd = fakeSystemd();
  for (const [unit, value] of Object.entries(state.units)) systemd.units.set(unit, value);
  for (const unit of state.failing) systemd.failing.add(unit);
  for (const unit of state.stuck ?? []) systemd.stuck.add(unit);
  const cron = fakeCrontab(state.crontab);
  try {
    return await runners(systemd.run, cron.run)(command, input === undefined ? {} : { input });
  } catch (error) {
    state.both.push((error as Error).message);
    return { code: 1, stdout: "", stderr: `${(error as Error).message}\n` };
  } finally {
    for (const { unit, file, line } of state.lastWords ?? []) if (state.units[unit]?.active && !systemd.units.get(unit)?.active) appendFileSync(file, line);
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
