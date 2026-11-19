import type { OldTasks } from "../adapters/fleet/adapter.ts";
import type { CommandRunner } from "../adapters/run.ts";

/** launchd for uid 501. It refuses to load a dev.hedge or com.hedge agent while its dev.fleet or com.fleet agent runs. stuck agents ignore bootout; unclear ones make launchctl print fail; failing ones do not load; pinned ones stay enabled. */
export function fakeLaunchd(oldLabel: (label: string) => string = (label) => label.replace(/^(dev|com)\.hedge\./, "$1.fleet.").replace(/\.hedge-/, ".fleet-")) {
  const loaded = new Set<string>();
  const disabled = new Set<string>();
  const stuck = new Set<string>();
  const unclear = new Set<string>();
  const failing = new Set<string>();
  const pinned = new Set<string>();
  const calls: string[][] = [];
  const label = (target: string) => target.replace(/^gui\/501\//, "");
  const run: CommandRunner = async (command) => {
    calls.push(command);
    const [tool, verb, target, file] = command;
    if (tool !== "launchctl") return { code: 127, stdout: "" };
    if (verb === "list") return { code: 0, stdout: `PID\tStatus\tLabel\n${[...loaded].map((name) => `123\t0\t${name}`).join("\n")}\n` };
    if (verb === "print-disabled") return { code: 0, stdout: `disabled services = {\n${[...disabled].map((name) => `\t"${name}" => disabled\n`).join("")}}\n` };
    if (verb === "print") return { code: unclear.has(label(target!)) ? 127 : loaded.has(label(target!)) ? 0 : 113, stdout: "" };
    if (verb === "bootout" && !stuck.has(label(target!))) loaded.delete(label(target!));
    if (verb === "disable" && pinned.has(label(target!))) return { code: 1, stdout: "", stderr: "Could not disable service: 1: Operation not permitted\n" };
    if (verb === "disable") disabled.add(label(target!));
    if (verb === "bootstrap") {
      const name = file!.split("/").at(-1)!.replace(/\.plist$/, "");
      if (loaded.has(oldLabel(name))) throw new Error(`launchd loaded ${name} while ${oldLabel(name)} still runs`);
      if (failing.has(name)) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" };
      loaded.add(name);
    }
    return { code: 0, stdout: "" };
  };
  return { run, loaded, disabled, stuck, unclear, failing, pinned, calls };
}

/** The Docker CLI. down makes every command fail as it does while the daemon is stopped. A pinned container keeps its restart policy. */
export function fakeDocker() {
  const containers = new Map<string, { running: boolean; restart: string; label?: string; pinned?: boolean }>();
  const state = { down: false };
  const run: CommandRunner = async (command) => {
    if (command[0] !== "docker") return { code: 127, stdout: "" };
    if (state.down) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\n" };
    const [verb] = command.slice(1);
    const name = command.at(-1)!;
    const container = containers.get(name);
    if (verb === "ps") return { code: 0, stdout: [...containers].map(([id, item]) => `${id}\t${item.label ?? ""}\n`).join("") };
    if (!container) return { code: 1, stdout: "", stderr: `Error: No such object: ${name}\n` };
    if (verb === "inspect") return { code: 0, stdout: `${container.running} ${container.restart}\n` };
    if (verb === "update" && container.pinned) return { code: 1, stdout: "", stderr: "Error response from daemon: cannot update container\n" };
    if (verb === "update") container.restart = "no";
    if (verb === "stop") container.running = false;
    return { code: 0, stdout: "" };
  };
  return { run, containers, state };
}

/** T3 Code's scheduled tasks. refuse makes every change fail. */
export function fakeTasks(tasks: Array<{ id: string; enabled: boolean }> = []) {
  const items = new Map(tasks.map((task) => [task.id, { ...task }]));
  const state = { refuse: false };
  const client: OldTasks = {
    list: async () => [...items.values()].map((task) => ({ ...task })),
    setEnabled: async (id, enabled) => {
      if (state.refuse) throw new Error("T3 Code closed the connection");
      items.set(id, { ...items.get(id)!, enabled });
    },
  };
  return { client, items, state };
}

/** crontab with one user's table. refuse makes every write fail. */
export function fakeCrontab(text = "") {
  const table = { text, refuse: false };
  const run: CommandRunner = async (command, options) => {
    if (command.join(" ") === "crontab -l") return table.text ? { code: 0, stdout: table.text } : { code: 1, stdout: "", stderr: "no crontab for hedge\n" };
    if (command.join(" ") !== "crontab -") return { code: 127, stdout: "" };
    if (table.refuse) return { code: 1, stdout: "", stderr: "crontab: cannot write\n" };
    table.text = options?.input ?? "";
    return { code: 0, stdout: "" };
  };
  return { run, table };
}

/** Sends each command to the first fake that knows its tool. */
export const runners = (...fakes: CommandRunner[]): CommandRunner => async (command, options) => {
  for (const fake of fakes) {
    const answer = await fake(command, options);
    if (answer.code !== 127) return answer;
  }
  return { code: 127, stdout: "" };
};
