import { join } from "node:path";
import type { MachineFile, Plan } from "../pack/types.ts";
import { saveMachine, validHost } from "../profile/profile.ts";
import { defaultRuntime, engineRuntime, planRuntime } from "../runtime/load.ts";
import type { AgentRuntime } from "../sdk/runtime.ts";
import type { Machine } from "../setup/commands.ts";
import { balanceThreads } from "../setup/devbox-balance.ts";
import { removeDevbox } from "../setup/devbox-remove.ts";
import { devboxSteps, type LeftStep, linkFromHub, listInProfile, nameBox, overSsh, printLeftForYou, profileForBox, tellHub } from "../setup/devbox.ts";
import { FlagError, refuseUnusableDevbox } from "../setup/flags.ts";
import { runSteps } from "../setup/runner.ts";
import { Stopped, type Terminal } from "../setup/terminal.ts";

export type DevboxCommandContext = { home: string; terminal: Terminal; machine: Machine; machineFile: MachineFile; plan: Plan };

const usage = "usage: hedge devbox, hedge devbox add <ssh host>, hedge devbox remove <ssh host>, or hedge devbox address";

/** Lists the devboxes, or makes an SSH host a devbox with the same steps setup runs. */
export async function devboxCommand(args: string[], context: DevboxCommandContext): Promise<number> {
  const { terminal, machineFile } = context;
  if (!args.length) {
    const hosts = machineFile.devboxes ?? [];
    terminal.print(hosts.length ? `Your devboxes: ${hosts.join(", ")}` : "No devbox yet.");
    terminal.print("Add one with hedge devbox add <ssh host>.");
    return 0;
  }
  const [action, host, ...rest] = args;
  if ((action !== "add" && action !== "remove") || !host || rest.length || !validHost(host)) throw new FlagError(usage);
  const runtime = await planRuntime(context.plan).catch(() => undefined);
  if (action === "remove") return await removeDevbox(host, { ...context, runtime }), 0;
  refuseUnusableDevbox(host);
  await nameBox(overSsh(context.machine, host), host);
  const remember = () => saveMachine(context.home, machineFile);
  if (!machineFile.devboxes?.includes(host)) {
    machineFile.devboxes = [...(machineFile.devboxes ?? []), host];
    await remember();
  }
  const listedHub = await listInProfile(machineFile.profileDir, host);
  const hub = listedHub && listedHub !== host ? listedHub : undefined;
  const hubTook = hub !== undefined && (await tellHub(context, hub, host));
  let left: LeftStep[] = [];
  const steps = () => devboxSteps(host, { terminal, machine: context.machine, nonInteractive: false, plan: context.plan.ai, models: context.plan.models, profile: () => profileForBox(context.machine, machineFile.profileDir), rerun: `hedge devbox add ${host}`, runtime, leftForYou: (steps) => (left = [...left, ...steps]), ...(context.plan.engineRoot ? { engineRoot: context.plan.engineRoot } : {}) });
  try {
    await runSteps(steps, {
      terminal,
      done: (machineFile.setup?.done ?? []).filter((id) => id !== `devbox:${host}:coder`),
      async save(done) {
        machineFile.setup = { ...machineFile.setup, done };
        await remember();
      },
    });
    terminal.print("");
    terminal.print(`${host} is your devbox now. It runs your profile${runtime?.onboarding ? `, and ${runtime.title} here and there can reach each other` : ""}.`);
    if (hub) await linkFromHub({ ...context, runtime, ...(machineFile.name ? { self: machineFile.name } : {}) }, hub, host, hubTook);
    await balanceThreads({ ...context, runtime });
    return 0;
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    terminal.print("");
    terminal.print(`Stopped. Run hedge devbox add ${host} again to pick up where it stopped.`);
    return 130;
  } finally {
    printLeftForYou(terminal, host, left);
  }
}

export const asksAddress = (args: string[]) => args.length === 1 && args[0] === "address";

export async function printAddress({ machine, terminal, runtime }: Pick<DevboxCommandContext, "machine" | "terminal"> & { runtime?: AgentRuntime }) {
  const chosen = runtime ?? (await engineRuntime(engineRoot, defaultRuntime));
  const address = chosen?.onboarding?.().address;
  if (!address) throw new Error(`${chosen?.title ?? "The runtime"} gives other machines no address for this one.`);
  terminal.print(await address(machine));
  return 0;
}

const engineRoot = join(import.meta.dir, "../..");
