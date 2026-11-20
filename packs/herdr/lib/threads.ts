import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRow } from "../../../src/pack/types.ts";
import type { RuntimeMachine, RuntimeThread, RuntimeThreads, ThreadState } from "../../../src/sdk/runtime.ts";
import { hcFinished, hcNotFound, hcProblem, spawnHc, type Hc } from "./hc.ts";
import { templateName } from "./templates.ts";

export const hedgeSpace = "hedge";
export const threadLabel = "hedge.thread";
export const threadsDir = ".local/state/hedge/herdr/threads";

type Status = { state?: string; kind?: string; msg?: string };
export type Terminal = {
  address?: string; name?: string; state?: string; title?: string; cwd?: string; parent?: string | null;
  status?: Status | null; status_ms?: number | null; created_ms?: number; finished_ms?: number | null; turn?: number;
  labels?: Record<string, string>; first_message?: { sent?: boolean; reason?: string };
};
type Machine = { name?: string; id?: string; state?: string; why?: string | null };

export type HerdrThreadOptions = { hc?: Hc; home?: string };

const digest = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const states: Record<string, ThreadState> = { working: "working", blocked: "blocked", done: "done", idle: "idle", error: "error" };
const kinds = new Set(["question", "permission", "auth"]);
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : undefined);

export function terminalName(title: string, key: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 23).replace(/-+$/, "");
  return [slug, digest(key).slice(0, 8)].filter(Boolean).join("-");
}

function terminals(stdout: string): Terminal[] {
  const parsed = JSON.parse(stdout) as { terminals?: Terminal[] } | Terminal[];
  return Array.isArray(parsed) ? parsed : (parsed.terminals ?? []);
}

const machineOf = (address: string) => (address.includes("/") ? address.slice(0, address.indexOf("/")) : undefined);
const qualified = (id: string, machine?: string) => (machine && !id.includes("/") ? `${machine}/${id}` : id);

export function fromTerminal(terminal: Terminal): RuntimeThread {
  const id = terminal.address ?? terminal.name ?? "";
  const finished = terminal.state === "finished";
  const reported = terminal.status?.state ? states[terminal.status.state] : undefined;
  const state: ThreadState = finished ? "done" : (reported ?? "idle");
  const kind = terminal.status?.kind && kinds.has(terminal.status.kind) ? (terminal.status.kind as "question" | "permission" | "auth") : "permission";
  const machine = machineOf(id);
  return {
    id,
    ...(machine ? { machine } : {}),
    title: terminal.title || terminal.name || id,
    state,
    ...(state === "blocked" ? { blocked: { kind, key: `${id}:${terminal.turn ?? 0}` } } : {}),
    ...(finished ? { closed: "settled" as const } : {}),
    ...(terminal.parent ? { parentId: qualified(terminal.parent, machine) } : {}),
    ...(terminal.cwd ? { cwd: terminal.cwd } : {}),
    ...(iso(terminal.status_ms ?? terminal.finished_ms ?? terminal.created_ms) ? { updatedAt: iso(terminal.status_ms ?? terminal.finished_ms ?? terminal.created_ms) } : {}),
    ...(terminal.status?.state === "error" && terminal.status.msg ? { error: terminal.status.msg } : {}),
  };
}

const isAgent = (terminal: Terminal) => Boolean(terminal.status || terminal.labels?.[threadLabel]);

export function herdrThreads(models: ModelRow[], { hc = spawnHc(), home = homedir() }: HerdrThreadOptions = {}): RuntimeThreads {
  const listAll = async (all: boolean) => {
    const listed = await hc(["ls", "--json", ...(all ? ["--all"] : [])]);
    if (listed.code !== 0) throw new Error(`herdr-core did not list its terminals: ${hcProblem(listed)}`);
    return terminals(listed.stdout).filter(isAgent).map(fromTerminal);
  };
  const list: RuntimeThreads["list"] = async (options = {}) => {
    const threads = await listAll(Boolean(options.includeClosed));
    return threads.filter((thread) => thread.machine === options.machine && (options.includeClosed || !thread.closed));
  };
  return {
    async start({ key, title, prompt, modelRole, machine, cwd: folder }) {
      const row = models.find((candidate) => candidate.role === modelRole);
      if (!row) throw new Error(`The model table of your AI plan has no ${modelRole} row, so Hedge cannot start the thread.`);
      const label = `${threadLabel}=${digest(key)}`;
      const listed = await hc(["ls", "--all", "--json", "--label", label]);
      if (listed.code !== 0) throw new Error(`herdr-core did not list its terminals: ${hcProblem(listed)}`);
      const existing = terminals(listed.stdout)[0];
      if (existing?.address) return { id: existing.address };
      const cwd = folder ?? (machine ? threadsDir : join(home, threadsDir));
      if (!machine && !folder) await mkdir(cwd, { recursive: true, mode: 0o700 });
      const name = terminalName(title, key);
      const started = await hc([
        "run", "--json", "--bg", "--keep", "--no-parent", "--name", name, "--cwd", cwd, ...(machine ? ["--on", machine] : []),
        "--label", label, "--label", `herdr.space=${hedgeSpace}`, templateName(row.role), prompt,
      ]);
      if (started.code !== 0) throw new Error(`herdr-core did not start ${name}: ${hcProblem(started)}`);
      const terminal = JSON.parse(started.stdout) as Terminal;
      const id = terminal.address ?? qualified(name, machine);
      if (terminal.first_message?.sent === false) {
        throw new Error(`herdr-core started ${name} (${id}), but the agent did not take its task (${terminal.first_message.reason ?? "no reason given"}). Open it with hc attach ${id}, or from the Herdr app.`);
      }
      return { id };
    },
    async send({ id, text, machine }) {
      const sent = await hc(["send", qualified(id, machine), text]);
      if (sent.code === hcNotFound || sent.code === hcFinished) return false;
      if (sent.code !== 0) throw new Error(`herdr-core did not send to ${id}: ${hcProblem(sent)}`);
      return true;
    },
    list,
    async find(id, options = {}) {
      const target = qualified(id, options.machine);
      const threads = await listAll(true);
      return threads.find((thread) => thread.id === target) ?? threads.find((thread) => thread.id.endsWith(`/${id}`) && thread.machine === options.machine);
    },
    async read(id, options = {}) {
      const read = await hc(["read", qualified(id, options.machine), "--lines", String(options.tail ? Math.max(options.tail * 20, 200) : 400)]);
      if (read.code !== 0) throw new Error(`herdr-core did not read ${id}: ${hcProblem(read)}`);
      return { screen: read.stdout };
    },
    async machines() {
      const listed = await hc(["machine", "ls", "--json"]);
      if (listed.code !== 0) throw new Error(`herdr-core did not list its machines: ${hcProblem(listed)}`);
      const parsed = JSON.parse(listed.stdout) as { machines?: Machine[] } | Machine[];
      const machines = Array.isArray(parsed) ? parsed : (parsed.machines ?? []);
      const self: RuntimeMachine = { name: "this machine", id: "local", self: true };
      return [self, ...machines.map((machine) => ({ name: machine.name ?? machine.id ?? "", id: machine.id ?? machine.name ?? "", self: false, ...(machine.state === "connected" ? {} : { problem: machine.why ?? machine.state ?? "not connected" }) }))];
    },
  };
}
