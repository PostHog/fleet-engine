import type { OldTasks } from "../adapters/fleet/adapter.ts";
import type { CommandRunner } from "../adapters/run.ts";

/** launchd for uid 501. It refuses to load a dev.hedge or com.hedge agent while its dev.fleet or com.fleet agent runs. stuck agents ignore bootout; unclear ones make launchctl print fail. */
export function fakeLaunchd(oldLabel: (label: string) => string = (label) => label.replace(/^(dev|com)\.hedge\./, "$1.fleet.").replace(/\.hedge-/, ".fleet-")) {
  const loaded = new Set<string>();
  const disabled = new Set<string>();
  const stuck = new Set<string>();
  const unclear = new Set<string>();
  const calls: string[][] = [];
  const label = (target: string) => target.replace(/^gui\/501\//, "");
  const run: CommandRunner = async (command) => {
    calls.push(command);
    const [tool, verb, target, file] = command;
    if (tool !== "launchctl") return { code: 127, stdout: "" };
    if (verb === "list") return { code: 0, stdout: `PID\tStatus\tLabel\n${[...loaded].map((name) => `123\t0\t${name}`).join("\n")}\n` };
    if (verb === "print") return { code: unclear.has(label(target!)) ? 127 : loaded.has(label(target!)) ? 0 : 113, stdout: "" };
    if (verb === "bootout" && !stuck.has(label(target!))) loaded.delete(label(target!));
    if (verb === "disable") disabled.add(label(target!));
    if (verb === "bootstrap") {
      const name = file!.split("/").at(-1)!.replace(/\.plist$/, "");
      if (loaded.has(oldLabel(name))) throw new Error(`launchd loaded ${name} while ${oldLabel(name)} still runs`);
      loaded.add(name);
    }
    return { code: 0, stdout: "" };
  };
  return { run, loaded, disabled, stuck, unclear, calls };
}

/** The Docker CLI. down makes every command fail as it does while the daemon is stopped. */
export function fakeDocker() {
  const containers = new Map<string, { running: boolean; restart: string; label?: string }>();
  const state = { down: false };
  const run: CommandRunner = async (command) => {
    if (command[0] !== "docker") return { code: 127, stdout: "" };
    if (state.down) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\n" };
    const [verb] = command.slice(1);
    const name = command.at(-1)!;
    const container = containers.get(name);
    if (verb === "ps") return { code: 0, stdout: [...containers].map(([id, item]) => `${id}\t${item.label ?? ""}\n`).join("") };
    if (!container) return { code: 1, stdout: "", stderr: `Error: No such object: ${name}\n` };
    if (verb === "inspect") return { code: 0, stdout: `${container.running}\n` };
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

/** Sends each command to the first fake that knows its tool. */
export const runners = (...fakes: CommandRunner[]): CommandRunner => async (command, options) => {
  for (const fake of fakes) {
    const answer = await fake(command, options);
    if (answer.code !== 127) return answer;
  }
  return { code: 127, stdout: "" };
};
