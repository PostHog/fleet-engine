import { existsSync, lstatSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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

/** env with a FLEET_ copy of each HEDGE_ variable, for packs from before the rename that read the old names. */
export function withLegacyNames(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const legacy = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("HEDGE_")).map(([key, value]) => [`FLEET_${key.slice("HEDGE_".length)}`, value]));
  return { ...legacy, ...env };
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

const present = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Moves each path from before the rename to its new name and leaves a link at
 * the old name, so hooks, jobs and scripts that still name it keep working.
 * A path whose new name is taken stays as it is: the new one wins. Returns the
 * paths it moved.
 */
export async function migrateLegacyPaths(home: string): Promise<Array<readonly [string, string]>> {
  const moved = legacyPaths.filter(([before, after]) => {
    const old = present(join(home, before));
    if (!old || old.isSymbolicLink() || present(join(home, after))) return false;
    renameSync(join(home, before), join(home, after));
    symlinkSync(basename(after), join(home, before));
    return true;
  });
  await renameStateEntries(home);
  return moved;
}

const linkedPrefixes = (home: string) => legacyPaths.filter(([before]) => present(join(home, before))?.isSymbolicLink());

/** Points the file ownership records at the new paths, so apply does not look for its files through the links. */
async function renameStateEntries(home: string) {
  const path = join(home, statePath);
  if (!present(path)?.isFile()) return;
  const state = JSON.parse(readFileSync(path, "utf8")) as { version: number; groups: Record<string, Record<string, unknown>> };
  const groups = { ...state.groups };
  if (groups[legacyFilesGroup] && !groups[filesGroup]) {
    groups[filesGroup] = groups[legacyFilesGroup];
    delete groups[legacyFilesGroup];
  }
  const prefixes = linkedPrefixes(home);
  const renamed = (target: string) => {
    const match = prefixes.find(([before]) => target === before || target.startsWith(`${before}/`));
    return match ? `${match[1]}${target.slice(match[0].length)}` : target;
  };
  const next = Object.fromEntries(Object.entries(groups).map(([name, entries]) => [name, Object.fromEntries(Object.entries(entries).map(([target, entry]) => [Object.hasOwn(entries, renamed(target)) ? target : renamed(target), entry]))]));
  const text = JSON.stringify({ ...state, groups: next }, null, 2) + "\n";
  if (text !== readFileSync(path, "utf8")) await writePrivateFile(path, text);
}
