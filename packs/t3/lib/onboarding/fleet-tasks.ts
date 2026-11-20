import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { FleetTasks } from "../../../../src/sdk/runtime.ts";
import type { T3Server } from "../adapter/port.ts";
import { localT3Server } from "../adapter/session.ts";

export function scheduledTasks(server: T3Server = localT3Server) {
  return async (home: string): Promise<FleetTasks | undefined> => {
    if (!(await server.answering(home))) return savedTasks(join(home, ".t3/userdata/statev2.sqlite"));
    return {
      list: () => server.session(home, async (rpc) => (await rpc.first<{ tasks: Array<{ id: string; enabled: boolean }> }>("scheduledTasks.subscribe", {})).tasks),
      setEnabled: (id, enabled) => server.session(home, async (rpc) => void (await rpc.call("scheduledTasks.setEnabled", { id, enabled }))),
    };
  };
}

function savedTasks(store: string): FleetTasks | undefined {
  if (lstatSync(store, { throwIfNoEntry: false }) === undefined) return undefined;
  return {
    saved: true,
    async list() {
      const db = new Database(store, { readonly: true });
      try {
        if (!db.query("select 1 from sqlite_master where type = 'table' and name = 'scheduled_tasks'").get()) return [];
        return db.query<{ id: string; enabled: number }, []>("select task_id as id, enabled from scheduled_tasks").all().map((row) => ({ id: row.id, enabled: row.enabled !== 0 }));
      } finally {
        db.close();
      }
    },
    setEnabled: async () => Promise.reject(new Error("T3 Code is stopped")),
  };
}
