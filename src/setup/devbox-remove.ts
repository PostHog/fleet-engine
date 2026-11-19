import type { MachineFile } from "../pack/types.ts";
import { loadProfile, pullProfile, saveAnswers, saveMachine } from "../profile/profile.ts";
import type { Machine } from "./commands.ts";
import { forgetWeight } from "./devbox-balance.ts";
import { boxEnvironmentId, t3Links } from "./devbox.ts";
import type { Terminal } from "./terminal.ts";

export type RemoveContext = { home: string; terminal: Terminal; machine: Machine; machineFile: MachineFile };

type Link = { environmentId: string; label?: string };

/** Takes a replaced hub or node out of the profile and this machine's list, unlinks it in T3 Code here, and drops its load balancing weight. It unlinks first, so a failed unlink changes nothing and a second run tries again; the profile is pushed on every run, so a push that failed before reaches the remote now. The hub stops its tunnel, disk watch and link at its next hedge update. */
export async function removeDevbox(host: string, context: RemoveContext) {
  const { terminal, machineFile } = context;
  const profileDir = machineFile.profileDir;
  if (profileDir) await pullProfile(profileDir);
  const profile = profileDir ? await loadProfile(profileDir) : undefined;
  if (profile?.hub === host) throw new Error(`${host} is your hub. Run hedge hub here on the new hub first, then hedge devbox remove ${host}.`);
  const recorded = { ...machineFile.t3Environments };
  const listed = [...(profile?.devboxes ?? []), ...(machineFile.devboxes ?? []), ...Object.keys(recorded)].includes(host);
  if (!listed) throw new Error(`${host} is not one of your devboxes. hedge devbox lists them.`);
  const links = await t3Links(context.machine);
  const id = await environmentOf(host, recorded, links, context.machine);
  const linked = id !== undefined && links.some((link) => link.environmentId === id);
  if (linked) {
    const unlinked = await context.machine.exec(["t3", "environment", "unlink", id]);
    if (unlinked.code !== 0) throw new Error(`T3 Code here could not unlink ${host}: ${unlinked.output.trim().split("\n").at(-1) ?? ""} Fix that, then run hedge devbox remove ${host} again.`);
  }
  if (profileDir) await saveAnswers(profileDir, { devboxes: (profile?.devboxes ?? []).filter((name) => name !== host) }, { push: true });
  const { [host]: _, ...kept } = recorded;
  machineFile.devboxes = (machineFile.devboxes ?? []).filter((name) => name !== host);
  machineFile.t3Environments = kept;
  await saveMachine(context.home, machineFile);
  if (id) await forgetWeight(context.home, id);
  const hubStops = "The hub stops its tunnel, disk watch and link to it at its next hedge update.";
  if (linked) return terminal.print(`✓ Removed ${host} from your profile and unlinked it in T3 Code here. ${hubStops}`);
  terminal.print(`✓ Removed ${host} from your profile. ${hubStops}`);
  terminal.print(`· T3 Code here has no link to ${host} that Hedge can find. When T3 Code still lists it, remove it in Settings → Environments.`);
}

/** The id Hedge recorded for the host when it last answered; else the id the host reports, unless Hedge recorded it for another host; else the one link here labelled with its name. */
async function environmentOf(host: string, recorded: Record<string, string>, links: Link[], machine: Machine) {
  if (recorded[host]) return recorded[host];
  const reported = await boxEnvironmentId(machine, host);
  const others = Object.entries(recorded).filter(([name]) => name !== host).map(([, id]) => id);
  if (reported && !others.includes(reported)) return reported;
  return linkByLabel(links, host)?.environmentId;
}

/** A workspace that is gone and was never recorded cannot say its id, so the one link here labelled with its name stands in, as T3 often labels a machine by its host name. */
function linkByLabel(links: Link[], host: string) {
  const names = new Set([host, host.replace(/^coder\./, "")]);
  const matching = links.filter((link) => link.label !== undefined && names.has(link.label));
  return matching.length === 1 ? matching[0] : undefined;
}
