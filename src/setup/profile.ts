import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackManifest, Profile, ProfileFile, SettingValue } from "../pack/types.ts";
import { bothChanged, loadProfile, pullProfile, pushedBehind, pushedFirst, pushFailed, saveAnswers } from "../profile/profile.ts";
import type { Machine } from "./commands.ts";
import { defaultSources, engineRepo } from "./defaults.ts";
import { profileFile } from "../legacy.ts";
import { knowGitHub } from "./known-hosts.ts";
import { withoutCredentials } from "../credentials.ts";
import { releaseIn, releaseRefsAtHead } from "../update.ts";
import type { Draft } from "./questions.ts";
import type { Step } from "./runner.ts";
import { Stopped, type Terminal } from "./terminal.ts";

export const profileRepoName = (login: string) => `${login.toLowerCase()}-hedge`;
export const profileTopic = (login: string) => `hedge-for-${login.toLowerCase()}`;
export const memoryRepoName = "hedge-memory";
const oldProfileRepoName = "hedge-profile";
const legacyProfileRepoName = "fleet-profile";
const legacyMemoryRepoName = "fleet-memory";
export const profilePath = (home: string) => join(home, ".local", "share", "hedge", "profile");

export type ProfileContext = {
  terminal: Terminal;
  machine: Machine;
  home: string;
  engineRoot: string;
  nonInteractive: boolean;
  draft: Draft;
  current?: string;
  packs(): PackManifest[];
  /** Called once hedge.json holds every answer and is pushed: the draft is no longer needed. */
  saved(dir: string): Promise<void>;
};

export function profileStep(context: ProfileContext): Step {
  return { id: "profile", title: "Make your profile", minutes: 1, kind: "auto", run: () => makeProfile(context) };
}

function github(machine: Machine) {
  const gh = async (...args: string[]) => {
    const result = await machine.exec(["gh", ...args]);
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${lastLine(result.output)}`);
    return result.output.trim();
  };
  const visibility = async (repo: string) => {
    const view = await machine.exec(["gh", "repo", "view", repo, "--json", "visibility", "--jq", ".visibility"]);
    if (view.code === 0) return view.output.trim();
    if (view.output.includes("Could not resolve to a Repository")) return undefined;
    throw new Error(`could not look up ${repo}: ${lastLine(view.output)}`);
  };
  const exists = async (repo: string) => (await visibility(repo)) !== undefined;
  return { gh, exists, visibility, login: () => gh("api", "user", "--jq", ".login") };
}

const kinds = {
  memory: { key: "memory.repo", noun: "memory repo", description: "My agents' shared memory" },
  context: { key: "context.repo", noun: "context repo", description: "What my agents learn and record" },
};

export function namedMemory(settings: Record<string, unknown>) {
  return settings["memory.repo"] !== undefined ? { named: settings["memory.repo"], kind: "memory" as const } : { named: settings["context.repo"], kind: "context" as const };
}

export async function memoryRepo(machine: Machine, named: unknown, login?: string, kind: keyof typeof kinds = "memory") {
  const { key, noun, description } = kinds[named === undefined ? "memory" : kind];
  const onGitHub = typeof named === "string" ? githubSlug(named, key) : undefined;
  if (typeof named === "string" && !onGitHub) return { repo: named, missing: false, make: async (print: (line: string) => void) => print(`✓ Using your ${noun} ${named}`) };
  const { gh, visibility, login: signedIn } = github(machine);
  const owner = onGitHub ? undefined : (login ?? (await signedIn()));
  let slug = onGitHub ?? `${owner}/${memoryRepoName}`;
  let seen = await visibility(slug);
  if (seen === undefined && owner) {
    const legacy = `${owner}/${legacyMemoryRepoName}`;
    const legacySeen = await visibility(legacy);
    if (legacySeen !== undefined) [slug, seen] = [legacy, legacySeen];
  }
  const missing = seen === undefined;
  if (!missing && !isPrivate(seen)) throw new Error(`${slug} is not private, and agents write notes about you there. Make it private, or name a private repo with --set ${key}=<owner/name>.`);
  const make = async (print: (line: string) => void) => {
    if (missing) await gh("repo", "create", slug, "--private", "--description", description);
    print(missing ? `✓ Created the private repo ${slug}` : `✓ Reusing your repo ${slug}`);
  };
  return { repo: typeof named === "string" && /:\/\/|@/.test(named) ? named : slug, missing, make };
}

function githubSlug(named: string, key: string) {
  if (/^[\w.-]+\/[\w.-]+$/.test(named)) return named;
  const [, host, path] = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)(?::\d*)?(\/[^?#]*)?/i.exec(named) ?? /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.*)$/.exec(named) ?? [];
  if (!host || !/^(?:www\.)?github\.com\.?$/i.test(host)) return undefined;
  const slug = /^\/?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(path ?? "")?.[1];
  if (!slug) throw new Error(`${named} is on GitHub, but Hedge cannot read its owner/name. Set ${key}=<owner/name>.`);
  return slug;
}

async function lookUp(machine: Machine, home: string, packs: PackManifest[], picked: string[], current?: string) {
  const { gh, exists, login: signedIn } = github(machine);
  const login = await signedIn();
  const name = profileRepoName(login);
  const org = profileOrg(packs, picked);
  const own = current ? await githubOrigin(machine, current) : undefined;
  const dir = own && current ? current : profilePath(home);
  const inUse = own ?? (await clonedProfile(machine, dir, login));
  const owners = [...(org ? [org] : []), login];
  const named = [`${login}/${name}`, org && `${org}/${oldProfileRepoName}-${login}`, `${login}/${oldProfileRepoName}`, org && `${org}/${legacyProfileRepoName}-${login}`, `${login}/${legacyProfileRepoName}`];
  const theirs = async (repo: string) => {
    const view = JSON.parse(await gh("repo", "view", repo, "--json", "repositoryTopics")) as Topics;
    const marks = (view.repositoryTopics ?? []).map((topic) => topic.name).filter((topic) => topic.startsWith("hedge-for-"));
    return marks.length > 0 && !marks.includes(profileTopic(login));
  };
  let found: string | undefined;
  for (const repo of [inUse, ...named]) if (!found && repo && (await exists(repo)) && (repo === inUse || same(owner(repo), login) || !(await theirs(repo)))) found = repo;
  found ??= await markedProfile(gh, owners, login);
  if (found && !same(found, `${login}/${oldProfileRepoName}`)) await requirePrivate(machine, found);
  if (found) await checkout(machine, home, dir, found);
  const personal = found !== undefined && same(owner(found), login) && !found.toLowerCase().endsWith(`/${legacyProfileRepoName}`);
  return { gh, login, exists, theirs, name, org, dir, found, personal };
}

type Topics = { repositoryTopics: Array<{ name: string }> | null };

async function markedProfile(gh: (...args: string[]) => Promise<string>, owners: string[], login: string) {
  for (const listed of owners) {
    const repos = JSON.parse(await gh("repo", "list", listed, "--limit", "10000", "--json", "nameWithOwner,repositoryTopics,viewerPermission")) as Array<Topics & { nameWithOwner: string; viewerPermission: string }>;
    const marks = repos.filter((repo) => repo.repositoryTopics?.some((topic) => topic.name === profileTopic(login)));
    const marked = marks.find((repo) => same(listed, login) || repo.viewerPermission === "ADMIN") ?? marks[0];
    if (marked && !same(listed, login) && marked.viewerPermission !== "ADMIN") throw new Error(`${marked.nameWithOwner} has your profile topic ${profileTopic(login)}, but you do not administer it, so Hedge does not trust it. When it is your profile, ask an ${listed} admin to make you its admin. When it is not, remove the topic. Then run hedge setup again.`);
    if (marked) return marked.nameWithOwner;
  }
  return undefined;
}

const owner = (repo: string) => repo.split("/")[0]!;

const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

export async function existingProfile(machine: Machine, home: string, packs: PackManifest[], picked: string[]): Promise<Profile | undefined> {
  const { found, dir } = await lookUp(machine, home, packs, picked);
  return found && existsSync(profileFile(dir)) ? loadProfile(dir) : undefined;
}

async function makeProfile(context: ProfileContext) {
  const { terminal, machine, home, draft } = context;
  const { gh, login, exists, theirs, name, org, dir, found, personal } = await lookUp(machine, home, context.packs(), draft.packs ?? [], context.current);
  const create = (repo: string) => machine.exec(["gh", "repo", "create", repo, "--private", "--description", "My Hedge profile"]);
  const saved = found ? savedSettings(dir) : {};
  const chosen = namedMemory({ ...saved, ...draft.settings });
  const shared = draft.packs?.includes("memory") ? chosen : chosen.kind === "context" && chosen.named !== undefined && draft.packs?.includes("context-library") ? chosen : undefined;
  const memory = shared && (await memoryRepo(machine, shared.named, login, shared.kind));
  const proposed = `${org ?? login}/${name}`;
  const confirmed = await confirm(context, found ? undefined : proposed, memory?.missing ? [memory.repo] : [], org, exists);
  let profileRepo = found ?? confirmed ?? proposed;
  const inOrg = () => org !== undefined && same(owner(profileRepo), org);
  if (!found) {
    const made = await create(profileRepo);
    if (made.code !== 0 && inOrg() && !(await exists(profileRepo))) {
      terminal.print(`  · The ${org} org did not let you create ${profileRepo} (${lastLine(made.output).replace(/^GraphQL: /, "")}), so Hedge uses your own account.`);
      profileRepo = `${login}/${profileRepo.split("/")[1]}`;
      await gh("repo", "create", profileRepo, "--private", "--description", "My Hedge profile");
    } else if (made.code !== 0 && !inOrg()) throw new Error(`gh repo create failed: ${lastLine(made.output)}`);
    else if (made.code !== 0) throw new Error((await theirs(profileRepo)) ? `${profileRepo} is another person's Hedge profile. Run hedge setup again and type another name for yours.` : `${profileRepo} exists, but Hedge cannot tell whether you made it. When it is yours, run gh repo edit ${profileRepo} --add-topic ${profileTopic(login)}, then run hedge setup again. When it is not, run hedge setup again and type another name for yours.`);
    if (inOrg()) await requirePrivate(machine, profileRepo);
    const marked = await machine.exec(["gh", "repo", "edit", profileRepo, "--add-topic", profileTopic(login)]);
    if (marked.code !== 0) throw new Error(`Hedge made ${profileRepo} but could not mark it as your profile (${lastLine(marked.output)}). Run gh repo edit ${profileRepo} --add-topic ${profileTopic(login)}, then run hedge setup again.`);
    terminal.print(`  ✓ Created the private repo ${profileRepo}${inOrg() ? ` in the ${org} org` : ""}`);
  } else terminal.print(`  ✓ Reusing your repo ${found}`);
  await memory?.make((line) => terminal.print(`  ${line}`));
  if (org && found && personal) {
    terminal.print(`  · Your team keeps profiles in the ${org} org. To move yours there, run:`);
    terminal.print(`      gh api -X POST repos/${found}/transfer -f new_owner=${org} -f new_name=${name}`);
    terminal.print(`      git -C ${dir} remote set-url origin https://github.com/${org}/${name}.git`);
  }

  if (!found) await checkout(machine, home, dir, profileRepo);
  const target = await saveTarget(machine, dir);
  await git(machine, dir, "config", "user.name", login);
  await git(machine, dir, "config", "user.email", `${login}@users.noreply.github.com`);
  await startFiles(dir, context, inOrg() ? org : undefined);
  const started = await untracked(machine, dir, startFileNames);
  const answeredElsewhere = (draft.inferred ?? []).filter((key) => Object.hasOwn(saved, key));
  Object.assign(draft, { settings: { ...draft.settings, ...Object.fromEntries(answeredElsewhere.map((key) => [key, saved[key] as SettingValue])) } });
  const { inferred: _inferred, ...picked } = draft;
  const answers: Partial<ProfileFile> = {
    ...(existsSync(profileFile(dir)) ? {} : { schema: 1, engine: await enginePin(context), sources: defaultSources, plan: "both", settings: {}, workflows: {} }),
    ...picked,
    ...(memory && memory.repo !== shared?.named ? { settings: { ...draft.settings, "memory.repo": memory.repo } } : {}),
  };
  if (started.length) {
    await git(machine, dir, "add", "--", ...started);
    await git(machine, dir, "commit", "-q", "-m", "Start my Hedge profile", "--", ...started);
  }
  const answered = await saveAnswers(dir, answers);
  await pushAnswers(machine, dir, target, answered || started.length > 0);
  terminal.print(`  ✓ Saved your answers in ${profileRepo}. Every machine of yours reads it.`);
  await context.saved(dir);
}

export async function saveSettings(machine: Machine, dir: string, settings: Record<string, SettingValue>) {
  const target = await saveTarget(machine, dir);
  await pullProfile(dir);
  await pushAnswers(machine, dir, target, await saveAnswers(dir, { settings }));
}

export async function pushAnswers(machine: Machine, dir: string, target: string[], committed: boolean) {
  const pushed = await machine.exec(["git", "-C", dir, "push", "-q", ...target]);
  if (pushed.code !== 0) throw pushedBehind(pushed.output) ? new Error(pushedFirst(dir, committed)) : pushFailed(dir, pushed.output);
}

/** The profile repo this machine's clone already uses, when its name is one setup makes for this login. */
async function clonedProfile(machine: Machine, dir: string, login: string) {
  const repo = await githubOrigin(machine, dir);
  const seen = repo?.toLowerCase();
  const ours = (name: string) => seen !== undefined && (seen === `${login}/${name}`.toLowerCase() || seen.endsWith(`/${name}-${login}`.toLowerCase()));
  return seen?.endsWith(`/${profileRepoName(login)}`) || ours(oldProfileRepoName) || ours(legacyProfileRepoName) ? repo : undefined;
}

async function githubOrigin(machine: Machine, dir: string) {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const origin = await machine.exec(["git", "-C", dir, "config", "--get", "remote.origin.url"]);
  return origin.code === 0 ? githubRepoOf(origin.output.trim()) : undefined;
}

async function currentBranch(machine: Machine, dir: string) {
  const head = await machine.exec(["git", "-C", dir, "symbolic-ref", "-q", "--short", "HEAD"]);
  if (head.code !== 0) throw new Error(`${dir} is not on a branch. Check out the branch this machine uses, then run hedge setup again.`);
  return head.output.trim();
}

async function upstreamOf(machine: Machine, dir: string, branch: string) {
  const setting = async (key: string) => {
    const value = await machine.exec(["git", "-C", dir, "config", "--get", `branch.${branch}.${key}`]);
    return value.code === 0 ? value.output.trim() : undefined;
  };
  const remote = await setting("remote");
  const merge = await setting("merge");
  if (!remote || !merge) return undefined;
  if (remote === "origin") return merge;
  const tracked = remote === "." ? `the local branch ${merge.replace(/^refs\/heads\//, "")}` : `${remote}/${merge.replace(/^refs\/heads\//, "")}`;
  throw new Error(`${dir} is on the branch ${branch}, which tracks ${tracked}, not origin. Setup takes and saves your answers only on origin, the repo it checks. Run git -C ${dir} branch --set-upstream-to origin/<branch>, then run hedge setup again.`);
}

async function trackedOnOrigin(machine: Machine, dir: string) {
  const head = await machine.exec(["git", "-C", dir, "symbolic-ref", "-q", "--short", "HEAD"]);
  return head.code === 0 ? upstreamOf(machine, dir, head.output.trim()) : undefined;
}

export async function fetchOrigin(machine: Machine, home: string, dir: string) {
  await knowGitHub(machine, home, dir);
  const fetched = await machine.exec(["git", "-C", dir, "fetch", "-q", "--prune", "origin"]);
  return fetched.code === 0 ? undefined : lastLine(fetched.output);
}

export async function takeOrigin(machine: Machine, home: string, dir: string) {
  const unreached = await fetchOrigin(machine, home, dir);
  if (unreached !== undefined) throw new Error(`git fetch in ${dir} failed: ${unreached}`);
  return takeFetched(machine, dir);
}

export async function takeFetched(machine: Machine, dir: string) {
  const merge = await trackedOnOrigin(machine, dir);
  if (!merge) return undefined;
  const fetched = await machine.exec(["git", "-C", dir, "rev-parse", "@{upstream}"]);
  if (fetched.code !== 0) {
    if ((await machine.exec(["git", "-C", dir, "rev-parse", "--verify", "-q", "HEAD"])).code !== 0) return undefined;
    throw new Error(`could not find ${merge} of origin in ${dir} after fetching origin: ${withoutCredentials(fetched.output.split("\n").find((line) => line.startsWith("fatal:")) ?? lastLine(fetched.output)).replace(/\.$/, "")}. Run git -C ${dir} pull, then run hedge setup again.`);
  }
  const merged = await machine.exec(["git", "-C", dir, "merge", "-q", "--ff-only", fetched.output.trim()]);
  return merged.code === 0 ? undefined : merged;
}

export async function saveTarget(machine: Machine, dir: string) {
  if ((await machine.exec(["git", "-C", dir, "rev-parse", "--verify", "-q", "HEAD"])).code !== 0) {
    await git(machine, dir, "symbolic-ref", "HEAD", "refs/heads/main");
    return ["-u", "origin", "main"];
  }
  const branch = await currentBranch(machine, dir);
  const merge = await upstreamOf(machine, dir, branch);
  if (!merge) throw new Error(`${dir} is on the branch ${branch}, which tracks no remote branch, so setup does not know where to save your answers. Run git -C ${dir} branch --set-upstream-to origin/<branch>, then run hedge setup again.`);
  return ["origin", `HEAD:${merge}`];
}

const isPrivate = (visibility: string | undefined) => visibility === "PRIVATE" || visibility === "INTERNAL";

async function requirePrivate(machine: Machine, repo: string) {
  if (!isPrivate(await github(machine).visibility(repo))) throw new Error(`${repo} is not private. Make it private, then run hedge setup again.`);
}

/** The GitHub org where the first picked pack that names one keeps its members' profiles. */
function profileOrg(packs: PackManifest[], picked: string[]) {
  return packs.find((pack) => pack.profileOrg && picked.includes(pack.name))?.profileOrg;
}

async function confirm({ terminal, nonInteractive }: ProfileContext, proposed: string | undefined, others: string[], org: string | undefined, exists: (repo: string) => Promise<boolean>) {
  if (!proposed && !others.length) return undefined;
  let profile = proposed && (await exists(proposed)) ? undefined : proposed;
  if (proposed && !profile && nonInteractive) throw new Error(`${proposed} is another person's Hedge profile. Run hedge setup in a terminal and type another name for yours.`);
  if (nonInteractive) return profile;
  const where = proposed && org ? `in the ${org} GitHub org, private to the org,` : "in your GitHub account";
  const show = () => {
    const missing = [...(profile ? [profile] : []), ...others];
    terminal.print(`  Hedge creates ${missing.length === 1 ? "the private repo" : "the private repos"} ${missing.join(" and ")} ${where} and pushes your answers there.`);
  };
  if (proposed && !profile) terminal.print(`  ${proposed} is another person's Hedge profile. Type another name for yours.`);
  else show();
  for (;;) {
    const reply = (await terminal.ask(proposed ? "  Go ahead? (Y/n, or type another name for your profile repo) " : "  Go ahead? (Y/n) ")).trim();
    if (["", "y", "yes"].includes(reply.toLowerCase()) && (profile || !proposed)) return profile;
    if (["n", "no"].includes(reply.toLowerCase())) {
      terminal.print("  Nothing was created.");
      throw new Stopped();
    }
    if (!proposed || ["", "y", "yes"].includes(reply.toLowerCase())) continue;
    const typed = `${owner(proposed)}/${reply}`;
    const clash = others.find((other) => same(other.split("/")[1], reply));
    const instead = profile ? `, or press ↵ for ${profile}` : "";
    if (!/^[\w.-]+$/.test(reply) || /^\.+$/.test(reply)) terminal.print("  A repo name has only letters, digits, -, _ and dots.");
    else if (clash) terminal.print(`  ${clash} is the memory repo. Type another name${instead}.`);
    else if (await exists(typed)) terminal.print(`  ${typed} exists already. Type another name${instead}.`);
    else (profile = typed), show();
  }
}

async function checkout(machine: Machine, home: string, dir: string, repo: string) {
  if (existsSync(join(dir, ".git"))) {
    const urls = (await machine.exec(["git", "-C", dir, "config", "--get-regexp", "^remote\\.origin\\.(push)?url$"])).output.trim().split("\n").map((line) => line.split(" ").slice(1).join(" "));
    const other = urls.find((url) => githubRepoOf(url)?.toLowerCase() !== repo.toLowerCase());
    if (other !== undefined) throw new Error(`${dir} is a clone of ${other ? (githubRepoOf(other) ?? "another remote") : "nothing"}, not ${repo}. Move it away, then run hedge setup again.`);
    if (await takeOrigin(machine, home, dir)) throw new Error(`${bothChanged(dir, repo)} Move ${dir} away, then run hedge setup again: it clones ${repo} and saves your answers on top.`);
    return;
  }
  if (existsSync(dir)) throw new Error(`${dir} exists and is not your profile. Move it away, then run hedge setup again.`);
  await mkdir(join(dir, ".."), { recursive: true });
  const cloned = await machine.exec(["git", "clone", "-q", `https://github.com/${repo}.git`, dir]);
  if (cloned.code !== 0) throw new Error(`could not clone ${repo}: ${lastLine(cloned.output)}`);
}

const startFileNames = ["install.sh", "about-me.md", "README.md"];

/** owner/name of a GitHub clone URL, or undefined for any other URL. */
export function githubRepoOf(url: string) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}

function savedSettings(dir: string): Record<string, unknown> {
  try {
    return (JSON.parse(readFileSync(profileFile(dir), "utf8")) as { settings?: Record<string, unknown> }).settings ?? {};
  } catch {
    return {};
  }
}

async function untracked(machine: Machine, dir: string, names: string[]) {
  const status = await machine.exec(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all", "--", ...names]);
  return status.output.split("\n").filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
}

/** Writes the shim, "about me", and the guide when the profile lacks them. */
async function startFiles(dir: string, context: ProfileContext, sharedWith: string | undefined) {
  const write = async (name: string, make: (path: string) => Promise<void>) => {
    const path = join(dir, name);
    if (existsSync(path)) return;
    await make(path);
  };
  await write("install.sh", (path) => copyFile(join(context.engineRoot, "templates/profile/install.sh"), path));
  await write("about-me.md", (path) => writeFile(path, "# About me\n\nWrite how you like to work here. Agents read it after your packs' rules.\n"));
  await write("README.md", (path) => writeFile(path, profileGuide(context.packs(), sharedWith)));
}

/** The engine ref this profile pins: the release tag the engine runs on, or main on the track channel. */
async function enginePin({ machine, engineRoot }: ProfileContext): Promise<ProfileFile["engine"]> {
  const refs = await machine.exec(releaseRefsAtHead(engineRoot));
  const ref = refs.code === 0 ? releaseIn(refs.output) : undefined;
  return ref ? { repo: engineRepo, ref, channel: "release" } : { repo: engineRepo, ref: "main", channel: "track" };
}

async function git(machine: Machine, dir: string, ...args: string[]) {
  const result = await machine.exec(["git", "-C", dir, ...args]);
  if (result.code !== 0) throw new Error(`git ${args[0]} in ${dir} failed: ${lastLine(result.output)}`);
}

const lastLine = (text: string) => withoutCredentials(text.trim().split("\n").at(-1) ?? "");

export function profileGuide(packs: PackManifest[], sharedWith?: string) {
  const sections = packs
    .filter((pack) => pack.settings?.length)
    .map((pack) => {
      const rows = pack.settings!.map((setting) => `| \`${setting.key}\` | ${setting.question} | ${setting.default === undefined ? (setting.optional ? "not set" : "asked") : `\`${String(setting.default)}\``} |`);
      return [`### ${pack.title ?? pack.name}`, "", "| Setting | What it is | Default |", "| --- | --- | --- |", ...rows].join("\n");
    });
  return [
    "# My Hedge profile",
    "",
    "Hedge reads this repo on every machine of mine. Hedge's commands change it for me, so I rarely edit it by hand.",
    "",
    ...(sharedWith ? [`This repo lives in the ${sharedWith} org, where teammates may read it, so keep secrets out of it.`, ""] : []),
    "- `hedge.json`: my packs, my AI plans, my settings, and the workflows I turned on or off.",
    "- `about-me.md`: how I like to work. Agents read it after my packs' rules.",
    "- `install.sh`: installs Hedge from this profile. A Coder devbox runs it as my dotfiles.",
    "",
    "## Changing things",
    "",
    "- `hedge packs --add <pack>` or `--remove <pack>` turns a pack on or off.",
    "- `hedge settings` lists my settings, and `hedge set <pack.key>=<value>` changes one.",
    "",
    "Each change applies on this machine at once. My other machines pick it up at their next daily `hedge update`.",
    "",
    "## Settings",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}
