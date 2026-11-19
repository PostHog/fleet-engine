import { randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { inside } from "./files/install.ts";
import { inLegacyPath, legacyPaths, renamed, underLegacyPath } from "./legacy.ts";
import { linkOnPath, withLock } from "./adapters/provider-config/store.ts";
import { loadProfile } from "./profile/profile.ts";
import { asLedger } from "./reconciler/ledger.ts";

type State = { version: number; groups: Record<string, Record<string, unknown>> };

const machineFile = ".config/fleet/machine.json";
const stateFile = ".local/state/fleet/state.json";
const ledgerFile = ".local/state/fleet/steps.json";
const doneFile = ".local/state/hedge/fleet-imported";
const notImported = new Set([".local/state/fleet", ".local/share/fleet"]);
const runState = /^(?:logs?|locks?|cache|caches|\.cache|node_modules|.+\.(?:log|lock|pid|partial|tmp))$/;

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false });

/** Copies the setup from before the rename to the new paths, once, and never changes an old path. An import that stopped part way copies what is still missing on the next run. Returns what it did. */
export async function importFleet(home: string): Promise<string[]> {
  if (!legacyPaths.some(([before]) => present(join(home, before))) || present(join(home, doneFile))) return [];
  return withLock(home, async () => {
    const records = oldState(home);
    const writtenByApply = (target: string) => Object.values(records?.groups ?? {}).some((group) => Object.hasOwn(group, target));
    const done: string[] = [];
    for (const [before, after] of legacyPaths.filter(([before]) => !notImported.has(before))) {
      const skip = (path: string) => path === join(home, machineFile) || writtenByApply(relative(home, path));
      if (await importTree(home, join(home, before), after, skip)) done.push(`copied ~/${before} to ~/${after}`);
    }
    if (records && (await publishFile(home, ".local/state/hedge/state.json", (partial) => writeFileSync(partial, JSON.stringify(takenOver(records), null, 2) + "\n", { mode: 0o600 })))) done.push(`copied the files ~/${stateFile} owns`);
    done.push(...(await importLedger(home)), ...(await importMachine(home)));
    await publishFile(home, doneFile, (partial) => writeFileSync(partial, "", { mode: 0o600 }));
    return done;
  });
}

async function importLedger(home: string): Promise<string[]> {
  const path = join(home, ledgerFile);
  if (!present(path)?.isFile()) return [];
  const ledger = (() => {
    try {
      return asLedger(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return undefined;
    }
  })();
  if (!ledger) return [`left ~/${ledgerFile} behind, because it is not a Hedge step ledger`];
  const text = JSON.stringify({ version: 1, ...ledger }, null, 2) + "\n";
  return (await publishFile(home, ".local/state/hedge/steps.json", (partial) => writeFileSync(partial, text, { mode: 0o600 }))) ? [`copied the undo steps in ~/${ledgerFile}`] : [];
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

/** The machine file, with profileDir on a copy of the profile when the profile was in an old path. The copy counts only when it is the same repository at the same commit and Hedge loads it as a profile; else profileDir goes and setup asks for the profile again. */
async function importMachine(home: string): Promise<string[]> {
  const path = join(home, machineFile);
  if (!present(path)?.isFile()) return [];
  const machine = JSON.parse(readFileSync(path, "utf8")) as { profileDir?: unknown };
  const imported: string[] = [];
  const profile = typeof machine.profileDir === "string" ? machine.profileDir : undefined;
  if (profile && underLegacyPath(home, profile)) {
    const target = renamed(relative(home, profile));
    if (target && (await importTree(home, profile, target, () => false))) imported.push(`copied ${profile} to ~/${target}`);
    if (target && sameCheckout(profile, join(home, target)) && (await loads(join(home, target)))) machine.profileDir = join(home, target);
    else delete machine.profileDir;
  }
  if (await publishFile(home, ".config/hedge/machine.json", (partial) => writeFileSync(partial, JSON.stringify(machine, null, 2) + "\n", { mode: 0o600 }))) imported.push(`copied ~/${machineFile} to ~/.config/hedge/machine.json`);
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

const loads = (dir: string) => loadProfile(dir).then(() => true, () => false);

/** Copies each regular file below from that target does not have yet, one by one, with its mode, and replaces nothing. Links, run state, and the paths skip names stay behind. Returns whether it copied a file. */
async function importTree(home: string, from: string, target: string, skip: (path: string) => boolean): Promise<boolean> {
  const info = present(from);
  if (info?.isFile()) return publishFile(home, target, (partial) => (copyFileSync(from, partial, constants.COPYFILE_EXCL), chmodSync(partial, info.mode & 0o7777)));
  if (!info?.isDirectory()) return false;
  await refuseLink(home, target);
  const path = inside(home, target);
  const made = !present(path);
  if (made) mkdirSync(path, { recursive: true, mode: 0o700 });
  await refuseLink(home, target);
  let copied = false;
  for (const name of readdirSync(from)) if (!runState.test(name) && !skip(join(from, name))) copied = (await importTree(home, join(from, name), join(target, name), skip)) || copied;
  if (made) chmodSync(path, info.mode & 0o7777);
  return copied;
}

async function refuseLink(home: string, target: string) {
  const link = await linkOnPath(home, target);
  if (link) throw new Error(`${link} is a link or a file, so Hedge did not bring the Fleet copy to ~/${target}. Move it away, then run get.sh again.`);
}

/** Builds target beside it, then links it in place only while nothing has its name. Refuses when target or a folder on its way is a link. */
async function publishFile(home: string, target: string, build: (partial: string) => void): Promise<boolean> {
  const path = inside(home, target);
  await refuseLink(home, target);
  if (present(path)) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await refuseLink(home, target);
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    build(partial);
    linkSync(partial, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(partial, { force: true });
  }
}
