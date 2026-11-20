import type { MachineFile } from "../pack/types.ts";
import { loadProfile, pullProfile, saveAnswers, saveMachine } from "../profile/profile.ts";
import type { AgentRuntime } from "../sdk/runtime.ts";
import type { Machine } from "./commands.ts";
import { onboardingContext } from "./devbox.ts";
import type { Terminal } from "./terminal.ts";

export type RemoveContext = { home: string; terminal: Terminal; machine: Machine; machineFile: MachineFile; runtime?: AgentRuntime };

/** Takes a replaced hub or node out of the profile and this machine's list, and unlinks it in the runtime here. It unlinks first, so a failed unlink changes nothing and a second run tries again; the profile is pushed on every run, so a push that failed before reaches the remote now. The hub stops its tunnel, disk watch and link at its next hedge update. */
export async function removeDevbox(host: string, context: RemoveContext) {
  const { terminal, machineFile, runtime } = context;
  const profileDir = machineFile.profileDir;
  if (profileDir) await pullProfile(profileDir);
  const profile = profileDir ? await loadProfile(profileDir) : undefined;
  if (profile?.hub === host) throw new Error(`${host} is your hub. Run hedge hub here on the new hub first, then hedge devbox remove ${host}.`);
  const recorded = { ...machineFile.t3Environments };
  const listed = [...(profile?.devboxes ?? []), ...(machineFile.devboxes ?? []), ...Object.keys(recorded)].includes(host);
  if (!listed) throw new Error(`${host} is not one of your devboxes. hedge devbox lists them.`);
  const onboarding = runtime?.onboarding?.();
  const unlinked = onboarding && (await onboarding.unlink(host, { ...onboardingContext(context.machine, terminal, `hedge devbox remove ${host}`), home: context.home, ids: recorded }));
  if (profileDir) await saveAnswers(profileDir, { devboxes: (profile?.devboxes ?? []).filter((name) => name !== host) }, { push: true });
  const { [host]: _, ...kept } = recorded;
  machineFile.devboxes = (machineFile.devboxes ?? []).filter((name) => name !== host);
  machineFile.t3Environments = kept;
  await saveMachine(context.home, machineFile);
  const hubStops = "The hub stops its tunnel, disk watch and link to it at its next hedge update.";
  if (unlinked?.unlinked) return terminal.print(`✓ Removed ${host} from your profile and unlinked it in ${runtime!.title} here. ${hubStops}`);
  terminal.print(`✓ Removed ${host} from your profile. ${hubStops}`);
  if (unlinked?.hint) terminal.print(`· ${unlinked.hint}`);
}
