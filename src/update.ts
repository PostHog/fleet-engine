import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { linkOnPath } from "./adapters/provider-config/store.ts";
import { inside } from "./files/install.ts";
import { tryLock, type Held } from "./lock.ts";
import { repoUrl, withoutUserinfo } from "./pack/sources.ts";
import type { ProfileFile } from "./pack/types.ts";
import { engineRepo } from "./setup/defaults.ts";

export type Child = { exited: Promise<number>; kill(signal?: NodeJS.Signals): void };

export type UpdateOptions = {
  home: string;
  engineDir: string;
  readProfile: () => Promise<{ profileDir: string; engine: ProfileFile["engine"] }>;
  print: (line: string) => void;
  runApply: () => Child;
};

type Run = Omit<UpdateOptions, "readProfile"> & { profileDir: string; engine: ProfileFile["engine"] };

type Version = { tag: string; parts: [number, number, number] };

const releaseRefs = "refs/hedge/releases";
export const recordedReleasesAtHead = (engineDir: string) => ["git", "-C", engineDir, "for-each-ref", "--points-at", "HEAD", "--format=%(refname)", releaseRefs];
export const releaseRefsAtHead = (engineDir: string) => ["git", "-C", engineDir, "for-each-ref", "--points-at", "HEAD", "--format=%(refname)", releaseRefs, "refs/tags"];
export const releaseIn = (refs: string) => refs.split("\n").map((ref) => ref.trim().replace(/^refs\/(?:hedge\/releases|tags)\//, "")).find((tag) => parse(tag)?.tag === tag);

export function noticePath(home: string) {
  return join(home, ".local", "state", "hedge", "update.json");
}

export async function readNotice(home: string): Promise<string | undefined> {
  const file = Bun.file(noticePath(home));
  if (!(await file.exists())) return undefined;
  const notice = (await file.json()) as { newMajor?: string };
  return notice.newMajor ? `Hedge ${notice.newMajor} is out. It is a new major version, so hedge update does not apply it. Read its changelog, then change the engine ref in your profile.` : undefined;
}

class Stopped extends Error {}

type OnStop = "kill" | "finish";

const running = new Set<Child>();
let stopping: NodeJS.Signals | undefined;

function track<T extends Child>(start: () => T, onStop: OnStop = "kill"): T {
  if (stopping && onStop === "kill") throw new Stopped();
  const child = start();
  if (onStop === "finish") return child;
  running.add(child);
  void child.exited.finally(() => running.delete(child));
  return child;
}

const stop = (signal: NodeJS.Signals) => {
  stopping = signal;
  for (const child of running) child.kill(signal);
};

type StepIo = { cwd?: string; env?: Record<string, string | undefined>; stdio: ["ignore" | "inherit", number | "inherit", number | "inherit"] };

export function startStep(command: string[], io: StepIo): Child {
  const child = Bun.spawn(command, { ...io, detached: true });
  return {
    exited: child.exited,
    kill(signal = "SIGTERM") {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
  };
}

const homeLock = ".local/state/hedge/update.lock";
const anotherUpdateRuns = "hedge update: another hedge update is running. Run it again when that one ends.";
const throughLink = (path: string) => `hedge update: ${path} is a link, so hedge update does not lock through it. Remove it, then run hedge update again.`;

function lockOnce(path: string) {
  try {
    return tryLock(path, { follow: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return "link" as const;
    throw error;
  }
}

async function takeLocks(home: string, engineDir: string): Promise<Held[] | string> {
  const link = await linkOnPath(home, homeLock);
  if (link) return throughLink(link);
  const common = await git(engineDir, "rev-parse", "--git-common-dir");
  if (!common.ok) return `hedge update: ${engineDir} is not an engine checkout: ${common.err}`;
  const held: Held[] = [];
  for (const path of [inside(home, homeLock), join(realpathSync(resolve(engineDir, common.out)), "hedge-update.lock")]) {
    const lock = lockOnce(path);
    if (lock && lock !== "link") {
      held.push(lock);
      continue;
    }
    releaseAll(held);
    return lock === "link" ? throughLink(path) : anotherUpdateRuns;
  }
  return held;
}

const releaseAll = (held: Held[]) => held.reverse().forEach((lock) => lock.release());

export async function update(given: UpdateOptions): Promise<number> {
  const print = (line: string) => given.print(withoutUserinfo(line));
  const held = await takeLocks(given.home, given.engineDir);
  if (typeof held === "string") return print(held), 1;
  process.on("SIGTERM", stop).on("SIGINT", stop);
  try {
    const code = await updateAlone({ ...given, print, ...(await given.readProfile()) });
    return stopping ? 128 + constants.signals[stopping] : code;
  } catch (error) {
    if (error instanceof Stopped && stopping) return 128 + constants.signals[stopping];
    throw error;
  } finally {
    process.off("SIGTERM", stop).off("SIGINT", stop);
    stopping = undefined;
    releaseAll(held);
  }
}

async function updateAlone(options: Run): Promise<number> {
  const origin = await ready(options);
  if (!origin) return 1;
  const before = (await git(options.engineDir, "rev-parse", "HEAD")).out;
  const moved = options.engine.channel === "track" ? await trackMain(options, origin.url) : await followRelease(options, origin.url, origin.switched);
  if (!moved) return 1;
  const failed = await installPackages(options.engineDir, "kill");
  if (failed !== undefined) return await rollBack(options, before, failed), 1;
  if (!(await recordRelease(options, moved))) return 1;
  if (!(await saveOrigin(options, origin))) return 1;
  const profileMoved = await pullProfile(options);
  const applied = await track(options.runApply).exited;
  return applied === 0 && !profileMoved ? 1 : applied;
}

async function pullProfile(options: Run) {
  const remotes = await git(options.profileDir, "remote");
  if (!remotes.ok || !remotes.out) return true;
  const pulled = await git(options.profileDir, "pull", "-q", "--ff-only");
  if (!pulled.ok) options.print(`hedge update: your profile did not fast-forward, so this machine applies its last version and the update counts as failed: ${pulled.err}`);
  return pulled.ok;
}

const formerEngines = new Set(["posthog/fleet-engine", "silthus/fleet-engine"]);
const githubRepo = (url: string) => url.match(/^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)?.slice(1, 3).join("/").toLowerCase();
const namesThisEngine = (wanted: string, origin: string) => formerEngines.has(githubRepo(wanted) ?? "") && githubRepo(origin) === engineRepo.toLowerCase();

type Origin = { url: string; switched: boolean; exists: boolean };

async function ready(options: Run): Promise<false | Origin> {
  const status = await git(options.engineDir, "status", "--porcelain");
  if (!status.ok) return options.print(`hedge update: ${options.engineDir} is not an engine checkout: ${status.err}`), false;
  if (status.out) return options.print(`hedge update: ${options.engineDir} has local changes. Save them elsewhere and remove them, then run hedge update again.`), false;
  const wanted = repoUrl(options.engine.repo);
  const origin = await git(options.engineDir, "config", "--get", "remote.origin.url");
  if (origin.ok && (origin.out === wanted || namesThisEngine(wanted, origin.out))) return { url: origin.out, switched: false, exists: true };
  return { url: wanted, switched: true, exists: origin.ok };
}

async function saveOrigin(options: Run, origin: Origin) {
  if (!origin.switched) return true;
  const changed = await git(options.engineDir, "remote", origin.exists ? "set-url" : "add", "origin", origin.url);
  if (!changed.ok) return options.print(`hedge update: the engine's packages are installed, but could not point the engine at ${origin.url}: ${changed.err}. Run hedge update again to finish the update.`), false;
  options.print(`The engine now comes from ${options.engine.repo}.`);
  return true;
}

type Moved = false | { release?: { tag: string; commit: string } };

async function recordRelease(options: Run, moved: Exclude<Moved, false>) {
  if (!moved.release) return true;
  const { tag, commit } = moved.release;
  const recorded = await git(options.engineDir, "update-ref", `${releaseRefs}/${tag}`, commit);
  if (!recorded.ok) options.print(`hedge update: the engine is at ${tag}, but could not record that release: ${recorded.err}. Run hedge update again to finish the update.`);
  return recorded.ok;
}

async function withFetched(options: Run, url: string, ref: string, use: (commit: string) => Promise<Moved>): Promise<Moved> {
  const fetching = `refs/hedge/fetching/${randomUUID()}/${ref.replace(/^refs\/(?:heads|tags)\//, "")}`;
  try {
    const fetched = await git(options.engineDir, "fetch", "-q", "--depth", "1", "--no-tags", url, `+${ref}:${fetching}`);
    if (!fetched.ok) return options.print(`hedge update: could not fetch the engine: ${fetched.err}`), false;
    const commit = await git(options.engineDir, "rev-parse", "--verify", `${fetching}^{commit}`);
    if (!commit.ok) return options.print(`hedge update: could not read the fetched engine: ${commit.err}`), false;
    return await use(commit.out);
  } finally {
    await gitAs("finish", options.engineDir, "update-ref", "-d", fetching);
  }
}

async function trackMain(options: Run, url: string): Promise<Moved> {
  return withFetched(options, url, "refs/heads/main", async (commit) => {
    const checkedOut = await git(options.engineDir, "checkout", "-q", "--detach", commit);
    if (!checkedOut.ok) return options.print(`hedge update: could not check out main: ${checkedOut.err}`), false;
    options.print(`Engine follows main at ${(await git(options.engineDir, "rev-parse", "--short", "HEAD")).out}.`);
    return {};
  });
}

async function releases(options: Run, url: string) {
  const listed = await git(options.engineDir, "ls-remote", "--tags", url, "refs/tags/v*");
  if (!listed.ok) return options.print(`hedge update: could not fetch the engine: ${listed.err}`), undefined;
  const commits = new Map<string, string>();
  for (const [commit, ref] of listed.out.split("\n").map((line) => line.split("\t"))) {
    const name = ref?.replace(/^refs\/tags\//, "");
    if (name && commit && (name.endsWith("^{}") || !commits.has(name))) commits.set(name.replace(/\^\{\}$/, ""), commit);
  }
  return [...commits].flatMap(([tag, commit]) => {
    const version = parse(tag);
    return version ? [{ ...version, commit }] : [];
  });
}

async function followRelease(options: Run, url: string, switched: boolean): Promise<Moved> {
  const versions = await releases(options, url);
  if (!versions) return false;
  const pin = parse(options.engine.ref);
  if (!pin) return options.print(`hedge update: the release channel needs a version tag as the engine ref, not ${options.engine.ref}.`), false;
  const sameMajor = versions.filter((version) => version.parts[0] === pin.parts[0]).sort(compare);
  const target = sameMajor.at(-1) ?? pin;
  const newer = versions.filter((version) => version.parts[0] > pin.parts[0]).sort(compare).at(-1);
  await saveNotice(options.home, newer?.tag);
  if (newer) options.print(`Hedge ${newer.tag} is out. It is a new major version, so this update stays on v${pin.parts[0]}.`);
  const head = (await git(options.engineDir, "rev-parse", "HEAD")).out;
  const installed = versions.filter((version) => version.commit === head).sort(compare).at(-1);
  if (switched) return checkOutRelease(options, url, target);
  if (!installed) {
    options.print(`Engine stays at ${head.slice(0, 7)}, which is not a release, so hedge update does not move it back. Set engine.channel to track to follow main, or run get.sh --ref ${target.tag}.`);
    return {};
  }
  if (compare(installed, target) >= 0) return options.print(`Engine is at ${installed.tag}.`), { release: { tag: installed.tag, commit: head } };
  return checkOutRelease(options, url, target);
}

async function checkOutRelease(options: Run, url: string, target: Version): Promise<Moved> {
  return withFetched(options, url, `refs/tags/${target.tag}`, async (commit) => {
    const checkedOut = await git(options.engineDir, "checkout", "-q", "--detach", commit);
    if (!checkedOut.ok) return options.print(`hedge update: could not check out ${target.tag}: ${checkedOut.err}`), false;
    options.print(`Engine is at ${target.tag}.`);
    return { release: { tag: target.tag, commit } };
  });
}

async function installPackages(engineDir: string, onStop: OnStop) {
  try {
    const { code, out, err } = await piped([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: engineDir, timeout: 300_000, onStop });
    return code === 0 ? undefined : (err || out).trim();
  } catch (error) {
    if (error instanceof Stopped) return "";
    throw error;
  }
}

async function piped(command: string[], { cwd, env, timeout, onStop = "kill" }: { cwd?: string; env?: Record<string, string | undefined>; timeout: number; onStop?: OnStop }) {
  const files = ["out", "err"].map((stream) => join(tmpdir(), `hedge-update-${randomUUID()}.${stream}`));
  const fds = files.map((file) => openSync(file, "wx", 0o600));
  try {
    const child = track(() => startStep(command, { cwd, env, stdio: ["ignore", fds[0]!, fds[1]!] }), onStop);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    const code = await child.exited.finally(() => clearTimeout(timer));
    const [out, err] = files.map((file) => readFileSync(file, "utf8"));
    return { code, out: out!, err: err! };
  } finally {
    fds.forEach((fd) => closeSync(fd));
    files.forEach((file) => rmSync(file, { force: true }));
  }
}

async function rollBack(options: Run, before: string, installError: string) {
  const failed = stopping ? `hedge update: stopped by ${stopping} while it installed the engine's packages in ${options.engineDir}` : `hedge update: could not install the engine's packages in ${options.engineDir}`;
  const restored = await gitAs("finish", options.engineDir, "checkout", "-q", "--force", "--detach", before);
  if (!restored.ok) return options.print(`${failed}, and could not roll the engine back to ${before.slice(0, 7)}: ${restored.err}. Run get.sh again to repair it.\n${installError}`);
  const repair = (await installPackages(options.engineDir, "finish")) === undefined ? "" : " Its packages did not install either, so run get.sh again to repair it.";
  options.print(`${failed}, so the update was rolled back. The engine stays at ${before.slice(0, 7)}.${repair}\n${installError}`.trimEnd());
}

async function saveNotice(home: string, newMajor: string | undefined) {
  const path = noticePath(home);
  if (!newMajor) return rm(path, { force: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ newMajor }) + "\n");
}

function parse(tag: string): Version | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return match ? { tag: tag.trim(), parts: [Number(match[1]), Number(match[2]), Number(match[3])] } : undefined;
}

function compare(a: Version, b: Version) {
  return a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2];
}

const git = (dir: string, ...args: string[]) => gitAs("kill", dir, ...args);

async function gitAs(onStop: OnStop, dir: string, ...args: string[]) {
  const env = { ...Bun.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  const { code, out, err } = await piped(["git", "-C", dir, ...args], { env, timeout: 120_000, onStop });
  return { ok: code === 0, out: out.trim(), err: err.trim().split("\n").at(-1) ?? "" };
}
