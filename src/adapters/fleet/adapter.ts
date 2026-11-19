import { Database } from "bun:sqlite";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../../pack/types.ts";
import type { Adapter } from "../../reconciler/apply.ts";
import { legacyPaths } from "../../legacy.ts";
import { skipOtherHome, spawnRunner, type CommandRunner } from "../run.ts";
import { localT3Server } from "../t3/session.ts";
import type { T3Server } from "../t3/port.ts";

export type FleetPiece = { kind: "launchd" | "systemd" | "container" | "t3" | "cron"; name: string };
/** saved: the tasks T3 Code keeps while its server is stopped, which Hedge can read but not change. */
export type OldTasks = { list(): Promise<Array<{ id: string; enabled: boolean }>>; setEnabled(id: string, enabled: boolean): Promise<void>; saved?: true };
export type FleetOptions = { run?: CommandRunner; accountHome?: () => Promise<string | undefined>; uid?: number; tasks?: (home: string) => Promise<OldTasks | undefined> };
/** retired: what retire stopped. left: each piece that is not verified stopped, with why. notes: what retire could not look at. */
export type Retirement = { retired: string[]; left: string[]; notes: string[] };
/** holds: what keeps hedge apply from starting anything, which apply asks before it loads the plan. */
export type FleetAdapter = Adapter & { retire(home: string, platform: NodeJS.Platform): Promise<Retirement | undefined>; holds(home: string, platform: NodeJS.Platform): Promise<Finding[]> };

const launchdPrefixes = ["dev.fleet.", "com.fleet."];
const unitPrefix = "fleet-";
const containerName = "fleet-mcphub";
const containerLabel = "org.fleet.service";
export const fleetTaskPrefix = "fleet:";
const notLoaded = 113;
const cronMarker = /\s# fleet:([A-Za-z0-9._-]+)$/;

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const hadFleet = (home: string) => legacyPaths.some(([before]) => present(join(home, before)));
/** A slice runs nothing by itself, and it has no [Install] section, so systemd shows it static and turning it off would remove its file. */
const passive = (unit: string) => unit.endsWith(".slice");
const names = (folder: string, keep: (name: string) => boolean) => {
  try {
    return readdirSync(folder).filter(keep);
  } catch {
    return [];
  }
};
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const why = (output: { code: number; stderr?: string }) => (output.stderr ?? "").trim().split("\n").at(-1) || `exit ${output.code}`;
export const describe = (piece: FleetPiece) => ({ launchd: `launchd agent ${piece.name}`, systemd: `systemd unit ${piece.name}`, container: `Docker container ${piece.name}`, t3: `T3 Code task ${piece.name}`, cron: `cron job ${piece.name}` })[piece.kind];

/** The T3 Code scheduled tasks on this machine: from its server, or from its state store while it is stopped. Undefined when T3 Code has neither. */
export function scheduledTasks(server: T3Server = localT3Server) {
  return async (home: string): Promise<OldTasks | undefined> => {
    if (!(await server.answering(home))) return savedTasks(join(home, ".t3/userdata/statev2.sqlite"));
    return {
      list: () => server.session(home, async (rpc) => (await rpc.first<{ tasks: Array<{ id: string; enabled: boolean }> }>("scheduledTasks.subscribe", {})).tasks),
      setEnabled: (id, enabled) => server.session(home, async (rpc) => void (await rpc.call("scheduledTasks.setEnabled", { id, enabled }))),
    };
  };
}

function savedTasks(store: string): OldTasks | undefined {
  if (!present(store)) return undefined;
  return {
    saved: true,
    async list() {
      const db = new Database(store, { readonly: true });
      try {
        return db.query<{ id: string; enabled: number }, []>("select task_id as id, enabled from scheduled_tasks").all().map((row) => ({ id: row.id, enabled: row.enabled !== 0 }));
      } finally {
        db.close();
      }
    },
    setEnabled: async () => Promise.reject(new Error("T3 Code is stopped")),
  };
}

type Found = { pieces: FleetPiece[]; unclear: string[]; notes: string[] };

/** Every running piece of the engine from before the rename, Fleet, found by its name or label prefix. */
export function fleetAdapter(options: FleetOptions = {}): FleetAdapter {
  const run = options.run ?? spawnRunner;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const tasksOf = options.tasks ?? scheduledTasks();
  const launchdTarget = (label: string) => `gui/${uid}/${label}`;
  const crontab = async () => {
    const listed = await run(["crontab", "-l"]);
    if (listed.code === 0) return { lines: listed.stdout.split("\n").filter(Boolean) };
    return { lines: [], unclear: listed.code === 127 || /no crontab/i.test(listed.stderr ?? "") ? undefined : `crontab -l did not answer (${why(listed)})` };
  };
  const cronId = (line: string) => cronMarker.exec(line)?.[1];

  async function find(home: string, platform: NodeJS.Platform, tasks: OldTasks | undefined): Promise<Found> {
    const found: Found = { pieces: [], unclear: [], notes: [] };
    if (!hadFleet(home)) return found;
    const add = (kind: FleetPiece["kind"], name: string) => void (found.pieces.some((piece) => piece.kind === kind && piece.name === name) || found.pieces.push({ kind, name }));
    if (platform === "darwin") {
      for (const file of names(join(home, "Library/LaunchAgents"), (name) => launchdPrefixes.some((prefix) => name.startsWith(prefix)) && name.endsWith(".plist"))) add("launchd", file.slice(0, -".plist".length));
      const listed = await run(["launchctl", "list"]);
      if (listed.code !== 0) found.unclear.push(`launchctl list did not answer (${why(listed)})`);
      for (const line of lines(listed.stdout)) {
        const label = line.split(/\s+/).at(-1)!;
        if (launchdPrefixes.some((prefix) => label.startsWith(prefix))) add("launchd", label);
      }
    } else {
      const files = names(join(home, ".config/systemd/user"), (name) => name.startsWith(unitPrefix) && !passive(name));
      const loaded = await run(["systemctl", "--user", "list-units", "--all", "--plain", "--no-legend", "--full", `${unitPrefix}*`]);
      if (loaded.code !== 0 && loaded.code !== 127 && files.length) found.unclear.push(`systemd's user manager did not answer (${why(loaded)})`);
      const installed = loaded.code === 0 ? await run(["systemctl", "--user", "list-unit-files", "--plain", "--no-legend", `${unitPrefix}*`]) : { code: 1, stdout: "" };
      for (const name of [...files, ...lines(loaded.code === 0 ? loaded.stdout : ""), ...lines(installed.stdout)].map((line) => line.split(/\s+/)[0]!)) if (name.startsWith(unitPrefix) && !passive(name)) add("systemd", name);
      const table = await crontab();
      if (table.unclear) found.unclear.push(table.unclear);
      for (const id of table.lines.map(cronId)) if (id) add("cron", id);
    }
    const containers = await run(["docker", "ps", "-a", "--format", `{{.Names}}\t{{.Label "${containerLabel}"}}`]);
    if (containers.code === 0) {
      for (const [name, label] of containers.stdout.split("\n").filter(Boolean).map((line) => line.split("\t"))) if (name === containerName || label) add("container", name!);
    } else if (containers.code !== 127 && present(join(home, ".local/share/fleet-mcphub"))) found.unclear.push(`Docker did not answer (${why(containers)}), so Hedge could not check the ${containerName} container`);
    if (!tasks) found.notes.push("T3 Code is not running, so Hedge did not look at its scheduled tasks. hedge apply checks them once T3 Code runs.");
    else {
      try {
        for (const task of await tasks.list()) if (task.id.startsWith(fleetTaskPrefix)) add("t3", task.id);
      } catch (error) {
        found.unclear.push(`T3 Code did not list its scheduled tasks (${(error as Error).message})`);
      }
    }
    return found;
  }

  /** Why the piece is not verified stopped, or undefined when it is. */
  async function stillOn(piece: FleetPiece, tasks: OldTasks | undefined): Promise<string | undefined> {
    if (piece.kind === "launchd") {
      const printed = await run(["launchctl", "print", launchdTarget(piece.name)]);
      if (printed.code !== notLoaded) return printed.code === 0 ? "it is still loaded" : `launchctl print exit ${printed.code}`;
      const listed = await run(["launchctl", "print-disabled", `gui/${uid}`]);
      if (listed.code !== 0) return `launchctl print-disabled exit ${listed.code}`;
      const off = lines(listed.stdout).some((line) => new RegExp(`^"${piece.name.replaceAll(".", "\\.")}" => (?:disabled|true)$`).test(line));
      return off ? undefined : "launchd still has it enabled, so it starts again at the next login";
    }
    if (piece.kind === "systemd") {
      const shown = await run(["systemctl", "--user", "show", "--property=LoadState,ActiveState,UnitFileState", piece.name]);
      if (shown.code !== 0) return why(shown);
      const state = new Map(lines(shown.stdout).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
      const active = state.get("ActiveState");
      const file = state.get("UnitFileState");
      if (active === undefined || file === undefined) return "systemd did not show its state";
      if (!["inactive", "failed"].includes(active)) return `it is ${active}`;
      if (["disabled", "masked"].includes(file) || (file === "" && state.get("LoadState") === "not-found")) return undefined;
      return `it is ${file || "in no unit file state"}`;
    }
    if (piece.kind === "container") {
      const inspected = await run(["docker", "inspect", "--format", "{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}", piece.name]);
      if (inspected.code !== 0) return /no such/i.test(inspected.stderr ?? "") ? undefined : why(inspected);
      const [running, restart = ""] = inspected.stdout.trim().split(" ");
      if (running !== "false") return "it is still running";
      return ["no", ""].includes(restart) ? undefined : `Docker starts it again, because its restart policy is ${restart}`;
    }
    if (piece.kind === "cron") {
      const table = await crontab();
      if (table.unclear) return table.unclear;
      return table.lines.some((line) => cronId(line) === piece.name) ? "it is still in your crontab" : undefined;
    }
    if (!tasks) return "T3 Code is not running";
    try {
      if ((await tasks.list()).find((task) => task.id === piece.name)?.enabled !== true) return undefined;
      return tasks.saved ? "it is on in T3 Code, which is stopped. Start T3 Code so Hedge can turn it off" : "it is still on";
    } catch (error) {
      return `T3 Code did not list it (${(error as Error).message})`;
    }
  }

  async function stop(piece: FleetPiece, tasks: OldTasks | undefined) {
    if (piece.kind === "launchd") {
      await run(["launchctl", "bootout", launchdTarget(piece.name)]);
      await run(["launchctl", "disable", launchdTarget(piece.name)]);
    } else if (piece.kind === "systemd") {
      if ((await run(["systemctl", "--user", "disable", "--now", piece.name])).code !== 0) await run(["systemctl", "--user", "stop", piece.name]);
    } else if (piece.kind === "container") {
      await run(["docker", "update", "--restart=no", piece.name]);
      await run(["docker", "stop", piece.name]);
    } else if (piece.kind === "cron") {
      const table = await crontab();
      if (table.unclear) return;
      const kept = table.lines.filter((line) => cronId(line) !== piece.name);
      await run(["crontab", "-"], { input: kept.length ? `${kept.join("\n")}\n` : "" });
    } else await tasks?.setEnabled(piece.name, false).catch(() => undefined);
  }

  /** Each piece found now, and each of earlier, that is not verified stopped. */
  async function still(home: string, platform: NodeJS.Platform, earlier: FleetPiece[] = []) {
    const tasks = await tasksOf(home).catch(() => undefined);
    const found = await find(home, platform, tasks);
    const on: Array<{ piece: FleetPiece; reason: string }> = [];
    const pieces = [...found.pieces, ...earlier.filter((piece) => !found.pieces.some((item) => item.kind === piece.kind && item.name === piece.name))];
    for (const piece of pieces) {
      const reason = await stillOn(piece, tasks);
      if (reason) on.push({ piece, reason });
    }
    return { found, on, tasks };
  }

  return {
    name: "fleet",
    targets: () => [],
    async apply() {
      return { actions: [], findings: [] };
    },
    async holds(home, platform) {
      if (!hadFleet(home)) return [];
      const skipped = await skipOtherHome("fleet", "the jobs from before the rename", home, options);
      if (skipped) return skipped.findings;
      const { found, on } = await still(home, platform);
      const fix = "Run hedge retire-fleet, then hedge apply.";
      const findings: Finding[] = [
        ...on.map(({ piece, reason }) => ({ id: `fleet:${piece.name}`, pack: "engine", say: `The ${describe(piece)} from before the rename still runs (${reason}), so Hedge started nothing. ${fix}`, repair: "human" as const })),
        ...found.unclear.map((text) => ({ id: "fleet:unclear", pack: "engine", say: `${text}, so Hedge cannot tell whether Fleet still runs, and started nothing. ${fix}`, repair: "human" as const })),
      ];
      return findings;
    },
    async retire(home, platform) {
      if (!hadFleet(home)) return { retired: [], left: [], notes: [] };
      const skipped = await skipOtherHome("fleet", "the jobs from before the rename", home, options);
      if (skipped?.findings.length) throw new Error(skipped.findings[0]!.say);
      if (skipped) return undefined;
      const before = await still(home, platform);
      for (const piece of before.found.pieces) await stop(piece, before.tasks);
      const after = await still(home, platform, before.found.pieces);
      const left = [...after.on.map(({ piece, reason }) => `${describe(piece)}: ${reason}`), ...after.found.unclear];
      const retired = before.on.filter(({ piece }) => !after.on.some((item) => item.piece.kind === piece.kind && item.piece.name === piece.name)).map(({ piece }) => describe(piece));
      return { retired, left, notes: after.found.notes };
    },
  };
}
