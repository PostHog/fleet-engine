import type { RuntimeThreads, Where } from "../../../src/sdk/runtime.ts";

export type Machine = { host: string; where: Where; problem?: string };
export type MachineReport<R> = (R & { host: string; error?: undefined }) | { host: string; error: string };

export async function readMachines(threads: Pick<RuntimeThreads, "machines">, host: string): Promise<Machine[]> {
  return (await threads.machines()).map((machine) =>
    machine.self ? { host, where: {} } : { host: machine.name, where: { machine: machine.name }, ...(machine.problem ? { problem: machine.problem } : {}) });
}

export function pickMachine(machines: Machine[], host: string): Machine {
  const found = machines.find((machine) => machine.host === host || machine.where.machine === host);
  if (found) return found;
  const others = machines.flatMap((machine) => (machine.where.machine ? [machine.host] : []));
  throw new Error(`No machine ${host}. Reachable: ${others.join(", ") || "none"}.`);
}

export function readEachMachine<R>(machines: Machine[], read: (where: Where) => Promise<R>): Promise<MachineReport<R>[]> {
  return Promise.all(machines.map(async ({ host, where, problem }): Promise<MachineReport<R>> => {
    if (problem) return { host, error: problem };
    try {
      return { ...(await read(where)), host };
    } catch (error) {
      return { host, error: (error as Error).message };
    }
  }));
}
