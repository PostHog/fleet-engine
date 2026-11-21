import type { MachineFile } from "../pack/types.ts";
import { loadProfile, saveMachine } from "../profile/profile.ts";
import type { AgentRuntime } from "../sdk/runtime.ts";
import type { Machine } from "./commands.ts";
import { onboardingContext } from "./devbox.ts";
import type { Terminal } from "./terminal.ts";

export type BalanceContext = { home: string; terminal: Terminal; machine: Machine; machineFile: MachineFile; runtime?: AgentRuntime };

export async function balanceThreads(context: BalanceContext) {
  const { terminal, machineFile } = context;
  const balance = context.runtime?.onboarding?.().balance;
  if (!balance || machineFile.role !== "mac" || !machineFile.profileDir) return;
  const { hub, devboxes = [] } = await loadProfile(machineFile.profileDir);
  const nodes = devboxes.filter((host) => host !== hub);
  if (!nodes.length) return terminal.print("· New threads stay on this Mac until a node runs. Add one with hedge devbox add <ssh host>.");
  const remember = async (ids: Record<string, string>) => {
    machineFile.t3Environments = ids;
    await saveMachine(context.home, machineFile);
  };
  await balance({ ...onboardingContext(context.machine, terminal, "hedge devbox add <ssh host>"), home: context.home, ...(hub ? { hub } : {}), nodes, ids: { ...machineFile.t3Environments }, remember });
}
