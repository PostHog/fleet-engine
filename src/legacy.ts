import { randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "./files/private.ts";

export const profileFileName = "hedge.json";
export const legacyProfileFileName = "fleet.json";

/** The profile file in dir: hedge.json, or fleet.json when only a profile from before the rename is there. */
export function profileFile(dir: string): string {
  const current = join(dir, profileFileName);
  const legacy = join(dir, legacyProfileFileName);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** Sets each HEDGE_ variable that is unset from its FLEET_ variable, so a setup from before the rename keeps its settings. */
export function adoptLegacyEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("FLEET_") || value === undefined) continue;
    const current = `HEDGE_${key.slice("FLEET_".length)}`;
    if (env[current] === undefined) env[current] = value;
  }
}

/** env with a FLEET_ copy of each HEDGE_ variable, for packs from before the rename that read the old names. The copy replaces a FLEET_ variable that env already has, so the HEDGE_ value always wins. */
export function withLegacyNames(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const legacy = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("HEDGE_")).map(([key, value]) => [`FLEET_${key.slice("HEDGE_".length)}`, value]));
  return { ...env, ...legacy };
}

/** Paths under the home folder that the engine owned before the rename, and their new names. */
export const legacyPaths: ReadonlyArray<readonly [string, string]> = [
  [".config/fleet", ".config/hedge"],
  [".local/state/fleet", ".local/state/hedge"],
  [".local/share/fleet", ".local/share/hedge"],
  [".local/share/fleet-cli-proxy", ".local/share/hedge-cli-proxy"],
  [".local/share/fleet-hub-https", ".local/share/hedge-hub-https"],
  [".local/share/fleet-mcphub", ".local/share/hedge-mcphub"],
  [".ssh/fleet_ed25519", ".ssh/hedge_ed25519"],
  [".ssh/fleet_ed25519.pub", ".ssh/hedge_ed25519.pub"],
  [".ssh/fleet-allowed-signers", ".ssh/hedge-allowed-signers"],
  [".ssh/fleet-coder-git.pub", ".ssh/hedge-coder-git.pub"],
  [".ssh/fleet-peers.conf", ".ssh/hedge-peers.conf"],
];

/** Writes the hedge command beside the fleet command that get.sh wrote before the rename, so hedge runs from a login shell after an update. Returns whether it wrote one. */
export function linkHedgeCommand(home: string, engineRoot: string): boolean {
  const old = join(home, ".local/bin/fleet");
  const current = join(home, ".local/bin/hedge");
  if (present(current) || !present(old)?.isFile() || readFileSync(old, "utf8").split("\n")[1] !== "# Fleet") return false;
  writeFileSync(current, `#!/bin/sh\n# Hedge\nexec sh '${join(engineRoot, "hedge").replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  return true;
}

const legacyFilesGroup = "fleet";
const filesGroup = "hedge";
const statePath = ".local/state/hedge/state.json";
const machinePath = ".config/hedge/machine.json";

const present = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Copies each path from before the rename to its new name, when nothing has
 * the new name yet. The old paths stay as they are, and a link in them is not
 * copied. Then it takes over the ownership records of the copies. Returns the
 * paths it copied.
 */
export async function copyLegacyPaths(home: string): Promise<Array<readonly [string, string]>> {
  const copied = legacyPaths.filter(([before, after]) => {
    const old = present(join(home, before));
    if (!old || old.isSymbolicLink() || present(join(home, after))) return false;
    copyWhole(join(home, before), join(home, after));
    return true;
  });
  await takeOverRecords(home);
  await pointMachineAtCopies(home);
  return copied;
}

function copyWhole(from: string, to: string) {
  const partial = `${to}.${randomUUID()}.partial`;
  try {
    copyTree(from, partial);
    renameSync(partial, to);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

function copyTree(from: string, to: string) {
  const info = lstatSync(from);
  if (info.isFile()) {
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    chmodSync(to, info.mode & 0o7777);
  } else if (info.isDirectory()) {
    mkdirSync(to, { mode: 0o700 });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
    chmodSync(to, info.mode & 0o7777);
  }
}

/** The copy of an old path, or undefined when the path is not in an old tree. */
function copyOf(path: string): string | undefined {
  const match = legacyPaths.find(([before]) => path === before || path.startsWith(`${before}/`));
  return match && `${match[1]}${path.slice(match[0].length)}`;
}

const sameFile = (one: string, other: string) => present(one)?.isFile() && present(other)?.isFile() && readFileSync(one).equals(readFileSync(other));

/**
 * Takes over the ownership records of a state copied from before the rename,
 * once. A record of a file in an old path moves to its copy only when the copy
 * holds the same bytes. Hedge drops every other record in an old path, so it
 * never owns a file in the old tree.
 */
async function takeOverRecords(home: string) {
  const path = join(home, statePath);
  if (!present(path)?.isFile()) return;
  const state = JSON.parse(readFileSync(path, "utf8")) as { version: number; groups: Record<string, Record<string, unknown>> };
  const { [legacyFilesGroup]: legacy, ...others } = state.groups;
  if (!legacy || others[filesGroup]) return;
  const follow = (target: string) => {
    const copy = copyOf(target);
    return copy === undefined ? target : sameFile(join(home, target), join(home, copy)) ? copy : undefined;
  };
  const records = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).flatMap(([target, entry]) => (follow(target) === undefined ? [] : [[follow(target)!, entry]])));
  const groups = Object.fromEntries(Object.entries({ ...others, [filesGroup]: legacy }).map(([name, entries]) => [name, records(entries)]));
  await writePrivateFile(path, JSON.stringify({ ...state, groups }, null, 2) + "\n");
}

/** Points the machine file at the copy of a profile that was in an old path. */
async function pointMachineAtCopies(home: string) {
  const path = join(home, machinePath);
  if (!present(path)?.isFile()) return;
  const machine = JSON.parse(readFileSync(path, "utf8")) as { profileDir?: unknown };
  if (typeof machine.profileDir !== "string" || !machine.profileDir.startsWith(`${home}/`)) return;
  const copy = copyOf(machine.profileDir.slice(home.length + 1));
  if (copy === undefined || !present(join(home, copy))?.isDirectory()) return;
  await writePrivateFile(path, JSON.stringify({ ...machine, profileDir: join(home, copy) }, null, 2) + "\n");
}
