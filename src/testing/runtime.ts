import type { StartedThread, ThreadStart } from "../sdk/index.ts";
import type { RuntimeMachine, RuntimeThread, RuntimeThreads, ThreadRead, Where } from "../sdk/runtime.ts";

export type FakeMachine = { threads?: RuntimeThread[]; reads?: Record<string, ThreadRead>; problem?: string; fails?: string };
export type Sent = { id: string; text: string; machine?: string };

/** A runtime with this machine under the key "", and other machines by name. */
export function fakeRuntime(machines: Record<string, FakeMachine>) {
  const sent: Sent[] = [];
  const started: Array<ThreadStart & Where> = [];
  const on = (where: Where = {}) => {
    const machine = machines[where.machine ?? ""];
    if (!machine) throw new Error(`no machine ${where.machine}`);
    if (machine.fails) throw new Error(machine.fails);
    return machine;
  };
  const visible = (where: Where, includeClosed = false) => (on(where).threads ?? []).filter((thread) => includeClosed || !thread.closed).map((thread) => ({ ...thread, ...(where.machine ? { machine: where.machine } : {}) }));
  const threads: RuntimeThreads = {
    async start(def): Promise<StartedThread> {
      started.push(def);
      return { id: `started-${started.length}` };
    },
    async send(def) {
      const thread = (on(def).threads ?? []).find((item) => item.id === def.id);
      if (!thread || thread.closed) return false;
      sent.push({ id: def.id, text: def.text, ...(def.machine ? { machine: def.machine } : {}) });
      return true;
    },
    list: async (options = {}) => visible(options, options.includeClosed),
    find: async (id, options = {}) => visible(options, true).find((thread) => thread.id === id),
    async read(id, options = {}) {
      const read = on(options).reads?.[id];
      if (!read) throw new Error(`no thread ${id}`);
      return read;
    },
    async machines() {
      return Object.entries(machines).map(([name, machine]): RuntimeMachine => (name ? { name, id: `env-${name}`, self: false, ...(machine.problem ? { problem: machine.problem } : {}) } : { name: "this machine", id: "local", self: true }));
    },
  };
  return { threads, sent, started };
}

export const thread = (id: string, fields: Partial<RuntimeThread> = {}): RuntimeThread => ({ id, title: `Thread ${id}`, state: "idle", updatedAt: "2026-10-01T00:00:00.000Z", ...fields });
