import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const profileFileName = "hedge.json";
export const legacyProfileFileName = "fleet.json";

export function profileFile(dir: string): string {
  const current = join(dir, profileFileName);
  const legacy = join(dir, legacyProfileFileName);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function adoptLegacyEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("FLEET_") || value === undefined) continue;
    const current = `HEDGE_${key.slice("FLEET_".length)}`;
    if (env[current] === undefined) env[current] = value;
  }
}

export function withLegacyNames(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const legacy = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("HEDGE_")).map(([key, value]) => [`FLEET_${key.slice("HEDGE_".length)}`, value]));
  return { ...env, ...legacy };
}

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

export const oldJobCommands: ReadonlyArray<readonly string[]> = [
  ["nightly"], ["refresh"], ["prune", "--auto"], ["usage", "flush"], ["context", "sync"], ["box", "sweep"], ["box", "nightly"], ["box", "grants"], ["box", "restore"],
  ["secret", "sweep"], ["dream", "run"], ["peers", "renew"], ["peers", "restore"], ["disk-watch"], ["cli-proxy-balance"], ["memory-sync"], ["recover"], ["run"],
];

export const oldJob = (argv: string[]) => oldJobCommands.find((command) => command.every((word, index) => argv[index] === word));

export const isOldJob = (argv: string[]) => oldJob(argv) !== undefined;

export const fleetIsHedge = "Fleet is now Hedge. Run: curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh";

export const inLegacyPath = (target: string): boolean => legacyPaths.some(([before]) => target === before || target.startsWith(`${before}/`));

export function renamed(target: string): string | undefined {
  const match = legacyPaths.find(([before]) => target === before || target.startsWith(`${before}/`));
  return match && `${match[1]}${target.slice(match[0].length)}`;
}

const real = (path: string): string => {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(real(parent), basename(full));
  }
};

function underHome(home: string, path: string, inside: (relative: string) => boolean): boolean {
  const homes = new Set([resolve(home), real(home)]);
  return [resolve(path), real(path)].some((full) => [...homes].some((root) => full.startsWith(`${root}/`) && inside(full.slice(root.length + 1))));
}

export const underLegacyPath = (home: string, path: string): boolean => underHome(home, path, inLegacyPath);

export const legacyEngine = ".local/share/fleet/engine";

export function fleetEngineInstalled(home: string): boolean {
  return lstatSync(join(home, legacyEngine), { throwIfNoEntry: false }) !== undefined;
}

const fleetCommand = /^exec sh '(.*)\/fleet' "\$@"$/m;

export function customFleetEngine(home: string, next: string): string | undefined {
  const engine = join(home, legacyEngine);
  if (lstatSync(engine, { throwIfNoEntry: false })?.isSymbolicLink()) return `${engine} is a link, and Hedge finds and stops only a Fleet engine that sits in ${engine} itself, so Hedge changed nothing. Stop Fleet's services, cron jobs and fleet: tasks in T3 Code by hand and delete the link ${engine}, or move the engine to ${engine} in place of the link. Then run ${next} again.`;
  const wrapper = join(home, ".local/bin/fleet");
  let text: string;
  try {
    text = readFileSync(wrapper, "utf8");
  } catch {
    return undefined;
  }
  if (text.split("\n")[1] !== "# Fleet") return undefined;
  const named = fleetCommand.exec(text)?.[1];
  const plain = named !== undefined && named.startsWith("/") && !named.includes("'");
  if (plain && (resolve(named) === resolve(engine) || real(named) === real(engine))) return undefined;
  const folder = named === undefined ? "a folder that Hedge cannot read from that file" : named.replaceAll("'\\''", "'");
  return `${wrapper} runs a Fleet engine in ${folder}, and Hedge finds and stops only the Fleet engine in ${engine}, so Hedge changed nothing. Stop Fleet's services, cron jobs and fleet: tasks in T3 Code by hand and delete ${wrapper}, or move the engine to ${engine} and change the path in ${wrapper} to match. Then run ${next} again.`;
}

export const inLegacyEngine = (home: string, path: string): boolean => underHome(home, path, (relative) => relative === legacyEngine || relative.startsWith(`${legacyEngine}/`));

export function renamedPath(home: string, path: string): string | undefined {
  for (const full of [resolve(path), real(path)])
    for (const root of new Set([resolve(home), real(home)])) {
      const after = full.startsWith(`${root}/`) ? renamed(full.slice(root.length + 1)) : undefined;
      if (after) return join(root, after);
    }
  return undefined;
}

export const inAnyLegacyPath = (path: string): boolean => [resolve(path), real(path)].some((full) => legacyPaths.some(([before]) => full.includes(`/${before}/`) || full.endsWith(`/${before}`)));

export function refuseLegacyPath(path: string) {
  if (inAnyLegacyPath(path)) throw new Error(`${path} is in a Fleet path from before the rename, so Hedge does not write there.`);
}
