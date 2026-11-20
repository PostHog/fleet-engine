import { Database } from "bun:sqlite";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Finding } from "../../pack/types.ts";
import type { Adapter } from "../../reconciler/apply.ts";
import { customFleetEngine, fleetEngineInstalled, inLegacyEngine, oldJob, underLegacyPath } from "../../legacy.ts";
import { skipOtherHome, spawnRunner, type CommandRunner } from "../run.ts";
import { localT3Server } from "../t3/session.ts";
import type { T3Server } from "../t3/port.ts";

export type FleetPiece = { kind: "launchd" | "systemd" | "container" | "t3" | "cron" | "process"; name: string; pid?: number };
export type OldTasks = { list(): Promise<Array<{ id: string; enabled: boolean }>>; setEnabled(id: string, enabled: boolean): Promise<void>; saved?: true };
export type Running = { pid: number; ppid: number; argv: string[]; fleetEngine?: string; cwd?: string };
export type FleetOptions = { run?: CommandRunner; accountHome?: () => Promise<string | undefined>; uid?: number; tasks?: (home: string) => Promise<OldTasks | undefined>; sleep?: (ms: number) => Promise<void>; processes?: () => Promise<Running[]> };
export type Retirement = { retired: string[]; left: string[]; notes: string[] };
export type FleetAdapter = Adapter & { installed(home: string): boolean; retire(home: string, platform: NodeJS.Platform): Promise<Retirement | undefined>; holds(home: string, platform: NodeJS.Platform): Promise<Finding[]> };

const launchdPrefixes = ["dev.fleet.", "com.fleet."];
const unitPrefix = "fleet-";
const containerName = "fleet-mcphub";
const containerLabel = "org.fleet.service";
export const fleetTaskPrefix = "fleet:";
const notLoaded = 113;
const cronMarker = /\s# fleet:([A-Za-z0-9._-]+)$/;
const exitPolls = 20;
const exitPollMs = 500;

const shellPrograms = new Set(["sh", "bash", "dash", "zsh"]);
const jobLauncher = /\/\.local\/state\/fleet\/jobs\/([A-Za-z0-9._-]+)\.sh$/;
const packCommand = /\/packs\/[^/]+\/commands\/([a-z0-9-]+)\.ts$/;
const jobChildren: ReadonlyArray<readonly string[]> = [["update"], ["agent-update"]];
const jobOrChild = (argv: string[]) => oldJob(argv) ?? jobChildren.find((command) => command.every((word, index) => argv[index] === word));
const codexInstaller = "/packs/base/lib/install-codex.sh";
const interpreters = new Set([...shellPrograms, "node", "bun"]);
const agentUpdateInstallers: ReadonlyArray<readonly string[]> = [["claude", "update"], ["claude", "plugin"], ["codex", "plugin"], ["t3", "update"], ["t3", "doctor"], ["bun", "add", "-g", "@openai/codex@latest"]];
const installerCommands: ReadonlyArray<{ job: string; command: readonly string[] }> = [
  ...agentUpdateInstallers.map((command) => ({ job: "agent-update", command })),
  { job: "update", command: ["bun", "install", "--frozen-lockfile", "--production"] },
];

function installerIn(argv: string[]) {
  const starts = interpreters.has(basename(argv[0] ?? "")) ? [0, 1] : [0];
  for (const at of starts) {
    const words = [basename(argv[at] ?? ""), ...argv.slice(at + 1)];
    const installer = installerCommands.find(({ command }) => command.every((word, index) => words[index] === word));
    if (installer) return installer;
  }
  return undefined;
}

function fleetInstaller(home: string, { argv, fleetEngine, cwd }: Running): string | undefined {
  const fromFleet = (fleetEngine?.startsWith("/") && underLegacyPath(home, fleetEngine)) || (cwd?.startsWith("/") && inLegacyEngine(home, cwd));
  const installer = fromFleet ? installerIn(argv) : undefined;
  return installer && `${installer.job}: ${installer.command.slice(0, 2).join(" ")}`;
}

function fleetJob(home: string, words: string[]): string | undefined {
  const [program = "", script = "", ...rest] = words;
  const ours = (path: string) => path.startsWith("/") && underLegacyPath(home, path);
  const job = (argv: string[]) => jobOrChild(argv)?.join(" ");
  if (basename(program) === "fleet" && ours(program)) return job([script, ...rest]);
  if (!ours(script)) return undefined;
  if (shellPrograms.has(basename(program))) {
    const launcher = jobLauncher.exec(script)?.[1];
    if (script.endsWith(codexInstaller)) return "agent-update: install-codex.sh";
    return basename(script) === "fleet" ? job(rest) : launcher && `job ${launcher}`;
  }
  if (basename(program) !== "bun") return undefined;
  if (script.endsWith("/src/cli.ts")) return job(rest);
  const command = packCommand.exec(script)?.[1];
  return command ? job([command, ...rest]) : undefined;
}

const vanished = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
const engineIn = (environ: string) => environ.split("\0").find((entry) => entry.startsWith("FLEET_ENGINE_DIR="))?.slice("FLEET_ENGINE_DIR=".length);

export function procProcesses(uid: number, root = "/proc"): () => Promise<Running[]> {
  return async () => {
    let entries: string[];
    try {
      entries = readdirSync(root).filter((name) => /^[0-9]+$/.test(name));
    } catch (error) {
      throw new Error(`${root} could not be read (${(error as Error).message})`);
    }
    return entries.flatMap((name): Running[] => {
      const dir = join(root, name);
      try {
        if (statSync(dir).uid !== uid) return [];
        const argv = readFileSync(join(dir, "cmdline"), "utf8").split("\0");
        if (argv.at(-1) === "") argv.pop();
        const stat = readFileSync(join(dir, "stat"), "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        const installer = Boolean(installerIn(argv));
        const fleetEngine = installer ? engineIn(readFileSync(join(dir, "environ"), "utf8")) : undefined;
        const cwd = installer ? readlinkSync(join(dir, "cwd")) : undefined;
        return argv.length ? [{ pid: Number(name), ppid, argv, fleetEngine, cwd }] : [];
      } catch (error) {
        if (vanished(error)) return [];
        throw new Error(`process ${name} could not be read (${(error as Error).message})`);
      }
    });
  };
}

function descendants(running: Running[], pid: number): number[] {
  return running.filter((item) => item.ppid === pid && item.pid !== pid).flatMap((item) => [item.pid, ...descendants(running, item.pid)]);
}

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
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
const listedNothing = (output: { code: number; stdout: string; stderr?: string }) => output.code === 1 && !output.stdout.trim() && !(output.stderr ?? "").trim();
export const describe = (piece: FleetPiece) => ({ launchd: `launchd agent ${piece.name}`, systemd: `systemd unit ${piece.name}`, container: `Docker container ${piece.name}`, t3: `T3 Code task ${piece.name}`, cron: `cron job ${piece.name}`, process: `running command ${piece.name}` })[piece.kind];

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
        if (!db.query("select 1 from sqlite_master where type = 'table' and name = 'scheduled_tasks'").get()) return [];
        return db.query<{ id: string; enabled: number }, []>("select task_id as id, enabled from scheduled_tasks").all().map((row) => ({ id: row.id, enabled: row.enabled !== 0 }));
      } finally {
        db.close();
      }
    },
    setEnabled: async () => Promise.reject(new Error("T3 Code is stopped")),
  };
}

type Found = { pieces: FleetPiece[]; unclear: string[]; notes: string[] };

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
  const sleep = options.sleep ?? Bun.sleep;
  const psProcesses = async (): Promise<Running[]> => {
    const listed = await run(["ps", "-ww", "-U", String(uid), "-o", "pid=,ppid=,args="]);
    if (listed.code !== 0) throw new Error(`ps did not answer (${why(listed)})`);
    return lines(listed.stdout).map((line) => {
      const [pid, ppid, ...argv] = line.split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), argv };
    });
  };
  const processesOf = (platform: NodeJS.Platform) => options.processes ?? (platform === "linux" ? procProcesses(uid) : psProcesses);
  const oldCommands = async (home: string, platform: NodeJS.Platform): Promise<{ pieces: FleetPiece[]; running: Running[]; unclear?: string }> => {
    let running: Running[];
    try {
      running = await processesOf(platform)();
    } catch (error) {
      return { pieces: [], running: [], unclear: (error as Error).message };
    }
    const pieces = running.flatMap((item): FleetPiece[] => {
      const { pid } = item;
      const job = fleetJob(home, item.argv) ?? fleetInstaller(home, item);
      return job ? [{ kind: "process", name: `fleet ${job} (process ${pid})`, pid }] : [];
    });
    return { pieces, running };
  };
  const stillRunning = async (home: string, platform: NodeJS.Platform, piece: FleetPiece) => {
    const now = await oldCommands(home, platform);
    return now.unclear ?? (now.pieces.some((item) => item.pid === piece.pid) ? "it has not ended" : undefined);
  };

  async function find(home: string, platform: NodeJS.Platform, tasks: OldTasks | undefined): Promise<Found> {
    const found: Found = { pieces: [], unclear: [], notes: [] };
    if (!fleetEngineInstalled(home)) return found;
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
      if (loaded.code === 0 && installed.code !== 0 && !listedNothing(installed)) found.unclear.push(`systemd did not list its unit files (${why(installed)})`);
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
    const commands = await oldCommands(home, platform);
    if (commands.unclear) found.unclear.push(commands.unclear);
    for (const piece of commands.pieces) found.pieces.push(piece);
    return found;
  }

  async function stillOn(home: string, platform: NodeJS.Platform, piece: FleetPiece, tasks: OldTasks | undefined): Promise<string | undefined> {
    if (piece.kind === "process") return stillRunning(home, platform, piece);
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

  async function stop(home: string, platform: NodeJS.Platform, piece: FleetPiece, tasks: OldTasks | undefined): Promise<string | undefined> {
    if (piece.kind === "process") {
      const now = await oldCommands(home, platform);
      if (!now.pieces.some((item) => item.pid === piece.pid)) return;
      const tree = [piece.pid!, ...descendants(now.running, piece.pid!)];
      await run(["kill", "-TERM", ...tree.map(String)]);
      const alive = async () => (await processesOf(platform)().catch(() => undefined))?.some((item) => tree.includes(item.pid)) ?? true;
      for (let poll = 0; poll < exitPolls && (await alive()); poll++) await sleep(exitPollMs);
      return (await alive()) ? `${describe(piece)}: it or a command it started has not ended` : undefined;
    } else if (piece.kind === "launchd") {
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

  async function still(home: string, platform: NodeJS.Platform, earlier: FleetPiece[] = []) {
    const tasks = await tasksOf(home).catch(() => undefined);
    const found = await find(home, platform, tasks);
    const on: Array<{ piece: FleetPiece; reason: string }> = [];
    const pieces = [...found.pieces, ...earlier.filter((piece) => !found.pieces.some((item) => item.kind === piece.kind && item.name === piece.name))];
    for (const piece of pieces) {
      const reason = await stillOn(home, platform, piece, tasks);
      if (reason) on.push({ piece, reason });
    }
    return { found, on, tasks };
  }

  return {
    name: "fleet",
    installed: fleetEngineInstalled,
    targets: () => [],
    async apply() {
      return { actions: [], findings: [] };
    },
    async holds(home, platform) {
      const custom = customFleetEngine(home, "hedge apply");
      if (custom) return [{ id: "fleet:custom-engine", pack: "engine", say: custom, repair: "human" }];
      if (!fleetEngineInstalled(home)) return [];
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
      if (!fleetEngineInstalled(home)) return { retired: [], left: [], notes: [] };
      const skipped = await skipOtherHome("fleet", "the jobs from before the rename", home, options);
      if (skipped?.findings.length) throw new Error(skipped.findings[0]!.say);
      if (skipped) return undefined;
      const before = await still(home, platform);
      const stuck = new Map<FleetPiece, string>();
      for (const piece of before.found.pieces) {
        const reason = await stop(home, platform, piece, before.tasks);
        if (reason) stuck.set(piece, reason);
      }
      const after = await still(home, platform, before.found.pieces);
      const same = (piece: FleetPiece) => (item: { piece: FleetPiece }) => item.piece.kind === piece.kind && item.piece.name === piece.name;
      const left = [...after.on.map(({ piece, reason }) => `${describe(piece)}: ${reason}`), ...[...stuck].filter(([piece]) => !after.on.some(same(piece))).map(([, reason]) => reason), ...after.found.unclear];
      const retired = before.on.filter(({ piece }) => !stuck.has(piece) && !after.on.some(same(piece))).map(({ piece }) => describe(piece));
      return { retired, left, notes: after.found.notes };
    },
  };
}
