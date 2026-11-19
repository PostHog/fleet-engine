import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const profileFileName = "hedge.json";
export const legacyProfileFileName = "fleet.json";

/** The profile file in dir: hedge.json, or fleet.json when only a profile from before the rename is there. */
export function profileFile(dir: string): string {
  const current = join(dir, profileFileName);
  const legacy = join(dir, legacyProfileFileName);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** Sets each HEDGE_ variable that is unset from its FLEET_ variable. A HEDGE_ variable that is set, even to an empty string, wins. */
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

/** The commands that the jobs and services of the engine from before the rename run. Each is the start of an argument list. */
export const oldJobCommands: ReadonlyArray<readonly string[]> = [
  ["nightly"], ["refresh"], ["prune", "--auto"], ["usage", "flush"], ["context", "sync"], ["box", "sweep"], ["box", "nightly"], ["box", "grants"], ["box", "restore"],
  ["secret", "sweep"], ["dream", "run"], ["peers", "renew"], ["peers", "restore"], ["disk-watch"], ["cli-proxy-balance"], ["memory-sync"], ["recover"], ["run"],
];

export const isOldJob = (argv: string[]) => oldJobCommands.some((command) => command.every((word, index) => argv[index] === word));

export const fleetIsHedge = "Fleet is now Hedge. Run: curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh";

/** Whether target, relative to the home folder, is a path from before the rename or inside one. */
export const inLegacyPath = (target: string): boolean => legacyPaths.some(([before]) => target === before || target.startsWith(`${before}/`));

/** The new name of target, relative to the home folder, or undefined when it is not in a path from before the rename. */
export function renamed(target: string): string | undefined {
  const match = legacyPaths.find(([before]) => target === before || target.startsWith(`${before}/`));
  return match && `${match[1]}${target.slice(match[0].length)}`;
}

/** path with every link resolved, including the links above a part of it that does not exist yet. */
const real = (path: string): string => {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(real(parent), basename(full));
  }
};

/** Whether the absolute path is in a path from before the rename, as written or with its links resolved. */
export function underLegacyPath(home: string, path: string): boolean {
  const homes = new Set([resolve(home), real(home)]);
  return [resolve(path), real(path)].some((full) => [...homes].some((root) => full.startsWith(`${root}/`) && inLegacyPath(full.slice(root.length + 1))));
}

/** The Hedge path of a path in a Fleet path from before the rename, as written or with its links resolved. */
export function renamedPath(home: string, path: string): string | undefined {
  for (const full of [resolve(path), real(path)])
    for (const root of new Set([resolve(home), real(home)])) {
      const after = full.startsWith(`${root}/`) ? renamed(full.slice(root.length + 1)) : undefined;
      if (after) return join(root, after);
    }
  return undefined;
}

/** Whether path, as written or with its links resolved, is in a Fleet path from before the rename below any home folder. */
export const inAnyLegacyPath = (path: string): boolean => [resolve(path), real(path)].some((full) => legacyPaths.some(([before]) => full.includes(`/${before}/`) || full.endsWith(`/${before}`)));

export function refuseLegacyPath(path: string) {
  if (inAnyLegacyPath(path)) throw new Error(`${path} is in a Fleet path from before the rename, so Hedge does not write there.`);
}
