import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repoUrl, withoutUserinfo } from "./pack/sources.ts";
import type { ProfileFile } from "./pack/types.ts";
import { engineRepo } from "./setup/defaults.ts";

export type UpdateOptions = {
  home: string;
  engineDir: string;
  profileDir: string;
  engine: ProfileFile["engine"];
  print: (line: string) => void;
  runApply: () => Promise<number>;
};

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

export async function update(given: UpdateOptions): Promise<number> {
  const options = { ...given, print: (line: string) => given.print(withoutUserinfo(line)) };
  const origin = await ready(options);
  if (!origin) return 1;
  const before = (await git(options.engineDir, "rev-parse", "HEAD")).out;
  const moved = options.engine.channel === "track" ? await trackMain(options, origin.url) : await followRelease(options, origin.url, origin.switched);
  if (!moved) return 1;
  const failed = await installPackages(options.engineDir);
  if (failed !== undefined) return await rollBack(options, before, failed), 1;
  if (!(await recordRelease(options, moved))) return 1;
  if (!(await saveOrigin(options, origin))) return 1;
  const profileMoved = await pullProfile(options);
  const applied = await options.runApply();
  return applied === 0 && !profileMoved ? 1 : applied;
}

async function pullProfile(options: UpdateOptions) {
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

async function ready(options: UpdateOptions): Promise<false | Origin> {
  const status = await git(options.engineDir, "status", "--porcelain");
  if (!status.ok) return options.print(`hedge update: ${options.engineDir} is not an engine checkout: ${status.err}`), false;
  if (status.out) return options.print(`hedge update: ${options.engineDir} has local changes. Save them elsewhere and remove them, then run hedge update again.`), false;
  const wanted = repoUrl(options.engine.repo);
  const origin = await git(options.engineDir, "config", "--get", "remote.origin.url");
  if (origin.ok && (origin.out === wanted || namesThisEngine(wanted, origin.out))) return { url: origin.out, switched: false, exists: true };
  return { url: wanted, switched: true, exists: origin.ok };
}

async function saveOrigin(options: UpdateOptions, origin: Origin) {
  if (!origin.switched) return true;
  const changed = await git(options.engineDir, "remote", origin.exists ? "set-url" : "add", "origin", origin.url);
  if (!changed.ok) return options.print(`hedge update: the engine's packages are installed, but could not point the engine at ${origin.url}: ${changed.err}. Run hedge update again to finish the update.`), false;
  options.print(`The engine now comes from ${options.engine.repo}.`);
  return true;
}

type Moved = false | { release?: { tag: string; commit: string } };

async function recordRelease(options: UpdateOptions, moved: Exclude<Moved, false>) {
  if (!moved.release) return true;
  const { tag, commit } = moved.release;
  const recorded = await git(options.engineDir, "update-ref", `${releaseRefs}/${tag}`, commit);
  if (!recorded.ok) options.print(`hedge update: the engine is at ${tag}, but could not record that release: ${recorded.err}. Run hedge update again to finish the update.`);
  return recorded.ok;
}

async function withFetched(options: UpdateOptions, url: string, ref: string, use: (commit: string) => Promise<Moved>): Promise<Moved> {
  const fetching = `refs/hedge/fetching/${ref.replace(/^refs\/(?:heads|tags)\//, "")}`;
  try {
    const fetched = await git(options.engineDir, "fetch", "-q", "--depth", "1", "--no-tags", url, `+${ref}:${fetching}`);
    if (!fetched.ok) return options.print(`hedge update: could not fetch the engine: ${fetched.err}`), false;
    const commit = await git(options.engineDir, "rev-parse", "--verify", `${fetching}^{commit}`);
    if (!commit.ok) return options.print(`hedge update: could not read the fetched engine: ${commit.err}`), false;
    return await use(commit.out);
  } finally {
    await git(options.engineDir, "update-ref", "-d", fetching);
  }
}

async function trackMain(options: UpdateOptions, url: string): Promise<Moved> {
  return withFetched(options, url, "refs/heads/main", async (commit) => {
    const checkedOut = await git(options.engineDir, "checkout", "-q", "--detach", commit);
    if (!checkedOut.ok) return options.print(`hedge update: could not check out main: ${checkedOut.err}`), false;
    options.print(`Engine follows main at ${(await git(options.engineDir, "rev-parse", "--short", "HEAD")).out}.`);
    return {};
  });
}

async function releases(options: UpdateOptions, url: string) {
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

async function followRelease(options: UpdateOptions, url: string, switched: boolean): Promise<Moved> {
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

async function checkOutRelease(options: UpdateOptions, url: string, target: Version): Promise<Moved> {
  return withFetched(options, url, `refs/tags/${target.tag}`, async (commit) => {
    const checkedOut = await git(options.engineDir, "checkout", "-q", "--detach", commit);
    if (!checkedOut.ok) return options.print(`hedge update: could not check out ${target.tag}: ${checkedOut.err}`), false;
    options.print(`Engine is at ${target.tag}.`);
    return { release: { tag: target.tag, commit } };
  });
}

async function installPackages(engineDir: string) {
  const child = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: engineDir, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 300_000 });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return code === 0 ? undefined : (err || out).trim();
}

async function rollBack(options: UpdateOptions, before: string, installError: string) {
  const failed = `hedge update: could not install the engine's packages in ${options.engineDir}`;
  const restored = await git(options.engineDir, "checkout", "-q", "--force", "--detach", before);
  if (!restored.ok) return options.print(`${failed}, and could not roll the engine back to ${before.slice(0, 7)}: ${restored.err}. Run get.sh again to repair it.\n${installError}`);
  const repair = (await installPackages(options.engineDir)) === undefined ? "" : " Its packages did not install either, so run get.sh again to repair it.";
  options.print(`${failed}, so the update was rolled back. The engine stays at ${before.slice(0, 7)}.${repair}\n${installError}`);
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

async function git(dir: string, ...args: string[]) {
  const env = { ...Bun.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: 120_000 });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: code === 0, out: out.trim(), err: err.trim().split("\n").at(-1) ?? "" };
}
