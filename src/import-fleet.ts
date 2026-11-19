import { randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { inside } from "./files/install.ts";
import { inLegacyPath, legacyPaths, renamed, underLegacyPath } from "./legacy.ts";
import { linkOnPath, withLock } from "./adapters/provider-config/store.ts";

type State = { version: number; groups: Record<string, Record<string, unknown>> };

const machineFile = ".config/fleet/machine.json";
const stateFile = ".local/state/fleet/state.json";
const notImported = new Set([".local/state/fleet", ".local/share/fleet"]);
const runState = /^(?:logs?|locks?|cache|caches|\.cache|node_modules|.+\.(?:log|lock|pid|partial|tmp))$/;

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false });

/** Copies the setup from before the rename to the new paths, once, and never changes an old path. Returns what it copied. */
export async function importFleet(home: string): Promise<string[]> {
  if (!legacyPaths.some(([before]) => present(join(home, before)))) return [];
  return withLock(home, async () => {
    const records = oldState(home);
    const writtenByApply = (target: string) => Object.values(records?.groups ?? {}).some((group) => Object.hasOwn(group, target));
    const imported: string[] = [];
    for (const [before, after] of legacyPaths.filter(([before]) => !notImported.has(before))) {
      const from = join(home, before);
      if (!present(from)?.isFile() && !present(from)?.isDirectory()) continue;
      const skip = (path: string) => path === join(home, machineFile) || writtenByApply(relative(home, path));
      if (await publish(home, after, (partial) => copyTree(from, partial, skip))) imported.push(`~/${before} to ~/${after}`);
    }
    if (records && (await publish(home, ".local/state/hedge/state.json", (partial) => writeFileSync(partial, JSON.stringify(takenOver(records), null, 2) + "\n", { mode: 0o600 })))) imported.push(`the files ~/${stateFile} owns`);
    imported.push(...(await importMachine(home)));
    return imported;
  });
}

function oldState(home: string): State | undefined {
  const path = join(home, stateFile);
  return present(path)?.isFile() ? (JSON.parse(readFileSync(path, "utf8")) as State) : undefined;
}

/** The fleet group becomes the hedge group. A target that both name keeps its hedge owner, and no group keeps a target in an old path. */
function takenOver(state: State): State {
  const { fleet = {}, hedge = {}, ...others } = state.groups;
  const groups = Object.entries({ ...others, hedge: { ...fleet, ...hedge } }).map(([name, entries]) => [name, Object.fromEntries(Object.entries(entries).filter(([target]) => !inLegacyPath(target)))]);
  return { ...state, groups: Object.fromEntries(groups) };
}

/** The machine file, with profileDir on a copy of the profile when the profile was in an old path. The copy counts only when it is the same repository at the same commit; else profileDir goes and setup asks for the profile again. */
async function importMachine(home: string): Promise<string[]> {
  const path = join(home, machineFile);
  if (!present(path)?.isFile()) return [];
  const machine = JSON.parse(readFileSync(path, "utf8")) as { profileDir?: unknown };
  const imported: string[] = [];
  const profile = typeof machine.profileDir === "string" ? machine.profileDir : undefined;
  if (profile && underLegacyPath(home, profile)) {
    const target = renamed(relative(home, profile));
    if (target && (await publish(home, target, (partial) => copyTree(profile, partial, () => false)))) imported.push(`${profile} to ~/${target}`);
    if (target && sameCheckout(profile, join(home, target))) machine.profileDir = join(home, target);
    else delete machine.profileDir;
  }
  if (await publish(home, ".config/hedge/machine.json", (partial) => writeFileSync(partial, JSON.stringify(machine, null, 2) + "\n", { mode: 0o600 }))) imported.push(`~/${machineFile} to ~/.config/hedge/machine.json`);
  return imported;
}

function sameCheckout(original: string, copy: string): boolean {
  const git = (dir: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  };
  const common = git(copy, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common || !`${realpathSync(common)}/`.startsWith(`${realpathSync(copy)}/`)) return false;
  return ["HEAD", "origin"].every((what) => {
    const read = (dir: string) => (what === "HEAD" ? git(dir, "rev-parse", "HEAD") : git(dir, "remote", "get-url", "origin") ?? "");
    return read(original) !== undefined && read(original) === read(copy);
  });
}

/** Copies regular files and folders with their modes. Links, run state, and the paths skip names stay behind. */
function copyTree(from: string, to: string, skip: (path: string) => boolean) {
  const info = lstatSync(from);
  if (info.isFile()) {
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    chmodSync(to, info.mode & 0o7777);
  } else if (info.isDirectory()) {
    mkdirSync(to, { mode: 0o700 });
    for (const name of readdirSync(from)) if (!runState.test(name) && !skip(join(from, name)) && (present(join(from, name))?.isFile() || present(join(from, name))?.isDirectory())) copyTree(join(from, name), join(to, name), skip);
    chmodSync(to, info.mode & 0o7777);
  }
}

/** Builds target beside it, then puts it in place only while nothing has its name. Refuses when target or a folder on its way is a link. */
async function publish(home: string, target: string, build: (partial: string) => void): Promise<boolean> {
  const path = inside(home, target);
  const linked = async () => {
    const link = await linkOnPath(home, target);
    if (link) throw new Error(`${link} is a link or a file, so Hedge did not bring the Fleet copy to ~/${target}. Move it away, then run get.sh again.`);
  };
  await linked();
  if (present(path)) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await linked();
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    build(partial);
    return lstatSync(partial).isDirectory() ? claimFolder(partial, path) : claimFile(partial, path);
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

const taken = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";

function claimFolder(partial: string, path: string): boolean {
  try {
    mkdirSync(path);
  } catch (error) {
    if (taken(error)) return false;
    throw error;
  }
  renameSync(partial, path);
  return true;
}

function claimFile(partial: string, path: string): boolean {
  try {
    linkSync(partial, path);
    return true;
  } catch (error) {
    if (taken(error)) return false;
    throw error;
  }
}
