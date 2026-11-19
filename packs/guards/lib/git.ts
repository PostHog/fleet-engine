import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withDirectories } from "./directories.ts";
import { shortCluster } from "./kill.ts";
import { type Command, commandsIn } from "./shell-words.ts";

export type Repo = { config: (key: string) => string | undefined; values: (key: string) => string[]; branch?: string; branches: string[]; refs: string[]; agents?: string; stack?: number };
export type ReadRepo = (dir: string, selectors: string[]) => Repo | undefined;

export const largestForcePush = 5;
const mainBranches = new Set(["main", "master"]);
const commitRequiredLetters = "mFCct";
const commitOptionalLetters = "Su";
const commitValued = new Set(["--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--trailer", "--cleanup", "--pathspec-from-file"]);
const pushValued = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

const hooksReason = (person: string) => "Fleet blocked this command: it skips the Git hooks, which run the repository's checks. "
  + `Let them run: fix what they report, then commit or push with hooks on. If a hook is broken, stop and ask ${person}.`;

const mainReason = (target: string, slug: string, upstream: boolean, person: string) => `Fleet blocked this command: it pushes to \`${target}\` of ${slug}`
  + (upstream ? `, because the branch tracks \`${target}\` and push.default is upstream,` : "")
  + " and that repository takes changes through pull requests. Push to your own branch: `git push -u origin HEAD:refs/heads/<branch>`. "
  + `If this repository takes pushes to ${target}, stop and ask ${person} to add ${slug} to guards.main-push-repos.`;

const forceReason = (person: string) => "Fleet blocked this command: it force-pushes without a lease, which can drop commits someone else pushed. "
  + "Use `git push --force-with-lease=<branch>:<expected sha> origin <branch>`, without a `+` on the refspec. "
  + `If you need to overwrite the branch anyway, stop and ask ${person}.`;

const burstReason = (count: number, person: string) => `Fleet blocked this command: it force-pushes ${count} branches at once, `
  + "and bursts like that make GitHub fail many CI runs at startup. "
  + `Push in batches of at most ${largestForcePush} branches, about a minute apart. If that does not fit, stop and ask ${person}.`;

const aliasReason = (person: string) => "Fleet blocked this command: it makes an alias or a wrapper command, such as `gh stack alias`, "
  + "`gh alias set sp 'stack push'`, a shell alias, or `gh alias import`, that can hide gh stack pushes from this guard. "
  + `Run \`gh stack\` itself. If you need the alias, stop and ask ${person}.`;

export const githubSlug = (url: string) => url.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)?.slice(1, 3).join("/");

/** An AGENTS.md line such as "Commit and push directly to `main`", without a "never" or "not". */
export const agentsPushToMain = (text = "") => text.split("\n").some((line) =>
  /\b(?:commit|push)\w*\b.*\b(?:directly|straight)\s+to\s+`?(?:main|master)\b/i.test(line) && !/\b(?:never|not|don't|do not|avoid)\b/i.test(line));

const configKey = (key: string) => {
  const parts = key.split(".");
  return parts.length < 3 ? key.toLowerCase() : [parts[0].toLowerCase(), ...parts.slice(1, -1), parts.at(-1)!.toLowerCase()].join(".");
};

function insideWorkTree(dir: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return true;
    if (dirname(current) === current) return false;
  }
}

const selectsRepository = (selectors: string[]) => selectors.some((selector) => /^--(?:git-dir|work-tree)/.test(selector));

export const readRepo: ReadRepo = (dir, selectors) => {
  if (!existsSync(dir) || (!selectsRepository(selectors) && !insideWorkTree(dir))) return undefined;
  const git = (args: string[], required = true) => {
    const result = Bun.spawnSync(["git", ...selectors, ...args], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    if (result.exitCode === 0) return result.stdout.toString();
    if (required || result.exitCode === null) throw new Error(`\`git ${args.join(" ")}\` failed in ${dir}`);
    return undefined;
  };
  if (git(["rev-parse", "--git-dir"], false) === undefined) return undefined;
  const top = git(["rev-parse", "--show-toplevel"], false)?.trim();
  const values = new Map<string, string[]>();
  for (const entry of git(["config", "--list", "-z"])!.split("\0").filter(Boolean)) {
    const split = entry.indexOf("\n");
    const key = configKey(split < 0 ? entry : entry.slice(0, split));
    values.set(key, [...values.get(key) ?? [], split < 0 ? "true" : entry.slice(split + 1)]);
  }
  const agents = top && join(top, "AGENTS.md");
  const branch = git(["symbolic-ref", "-q", "--short", "HEAD"], false)?.trim() || undefined;
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], false)?.trim();
  return {
    values: (key) => values.get(configKey(key)) ?? [],
    config: (key) => values.get(configKey(key))?.at(-1),
    branch,
    ...refsOf(git(["for-each-ref", "--format=%(refname)"])!),
    agents: agents && existsSync(agents) ? readFileSync(agents, "utf8") : undefined,
    stack: commonDir && branch ? stackSize(join(commonDir, "gh-stack"), branch) : undefined,
  };
};

type StackCatalog = { stacks?: { branches?: { branch?: string; pullRequest?: { merged?: boolean } }[] }[] };

export function stackSize(catalog: string, branch: string): number | undefined {
  if (!existsSync(catalog)) return undefined;
  try {
    const file = JSON.parse(readFileSync(catalog, "utf8")) as StackCatalog;
    const stack = file.stacks?.find((each) => each.branches?.some((ref) => ref.branch === branch));
    return stack?.branches?.filter((ref) => !ref.pullRequest?.merged).length;
  } catch {
    return undefined;
  }
}

const stackPushActions = new Set(["push", "submit", "sync"]);
const stackValued = new Set(["--base", "--remote", "-b", "-r", "-R", "--repo"]);

const operandsOf = (args: string[]) => args.filter((arg, index) => !arg.startsWith("-") && !stackValued.has(args[index - 1] ?? ""));
const extensionGroups = new Set(["extension", "extensions", "ext"]);
const stackActions = new Set([...stackPushActions, "link", "alias"]);
const largestWrapper = 4096;

function stackWrapper(name: string): boolean {
  const path = join(homedir(), ".local/bin", name);
  try {
    return statSync(path).size <= largestWrapper && /\bgh\s+stack\b/.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function stackArgs(name: string, args: string[]): string[] | undefined {
  if (name === "gh") {
    const [group, action, extension] = operandsOf(args);
    if (extensionGroups.has(group ?? "") && action === "exec" && extension === "stack") return args.slice(args.indexOf("exec") + 1);
    return group === "stack" ? args : undefined;
  }
  if (!stackActions.has(operandsOf(args)[0] ?? "")) return undefined;
  return name === "gh-stack" || stackWrapper(name) ? ["stack", ...args] : undefined;
}

const makesAlias = (args: string[]) => operandsOf(args)[1] === "alias" && !args.includes("--remove");
const truthy = /^(?:1|t|true)$/i;
const falsy = /^(?:0|f|false)$/i;

/**
 * Whether gh prints help for `gh alias …`: `-h` before any `--` does at once, and otherwise the last `--help` or
 * `--help=<bool>` decides. After `--` it is an operand, such as an import file; a value gh cannot read counts as no help.
 */
function asksHelp(args: string[]): boolean {
  let help = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "-h") return true;
    if (arg === "--help") help = true;
    const value = /^(?:--help|-h)=(.*)$/.exec(arg)?.[1];
    if (value === undefined) continue;
    if (truthy.test(value)) help = true;
    else if (falsy.test(value)) help = false;
    else return false;
  }
  return help;
}

function ghAliasHidesStack(name: string, args: string[]): boolean {
  const [group, action, , expansion] = operandsOf(args);
  if (name !== "gh" || group !== "alias" || asksHelp(args)) return false;
  if (action === "import") return true;
  if (action !== "set") return false;
  return expansion === undefined || args.some((arg) => /^(?:-s|--shell)(?:=|$)/.test(arg)) || /^!|\bstack\b/.test(expansion);
}

/** The variables that move gh's config directory, and a read of one as `$NAME` or `${NAME}`. */
const configVariable = /\b(?:GH_CONFIG_DIR|XDG_CONFIG_HOME|HOME)\b/;
const configRead = /\$(?:\{(?:GH_CONFIG_DIR|XDG_CONFIG_HOME|HOME)\}|(?:GH_CONFIG_DIR|XDG_CONFIG_HOME|HOME)\b)/g;
/** `sudo` and `doas` switch the user, and `env` or `exec` with an option can clear, unset or split the environment. */
const environmentWrapper = /(?:^|[^\w.-])(?:(?:sudo|doas)(?![\w.-])|(?:env|exec)\s+-)/;

/**
 * Whether gh may read another config than the one the agent's environment names: the command names a variable that
 * moves it other than to read it, or runs gh through a wrapper that changes the user or the environment. The guard
 * does not follow the shell's assignments, exports, tildes and unsets; it refuses them.
 */
const movesGhConfig = (command: string) => configVariable.test(command.replace(configRead, "")) || environmentWrapper.test(command);

/** gh's aliases from the config the agent's environment names; undefined when the guard cannot tell what gh reads. */
function ghAliases(): Record<string, unknown> | undefined {
  const { GH_CONFIG_DIR: named, XDG_CONFIG_HOME: configHome, HOME: home } = process.env;
  const directory = named || (configHome ? join(configHome, "gh") : join(home ?? "", ".config", "gh"));
  if (!isAbsolute(directory)) return undefined;
  let text: string;
  try {
    text = readFileSync(join(directory, "config.yml"), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : undefined;
  }
  return aliasesIn(text);
}

/**
 * The aliases of a gh config. gh reads the first YAML document and the first of duplicate keys, and Bun the last, so the
 * config must be one block mapping, with as many lines at the indent of its aliases as Bun reads aliases.
 */
function aliasesIn(text: string): Record<string, unknown> | undefined {
  let parsed: { aliases?: Record<string, unknown> } | null;
  try {
    parsed = Bun.YAML.parse(text) as typeof parsed;
  } catch {
    return undefined;
  }
  const aliases = parsed?.aliases ?? {};
  let lines = 0;
  let indent: number | undefined;
  let inAliases = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const leading = /^\s*/.exec(line)![0].length;
    if (leading === 0) {
      const top = /^[\w-]+:(?:[ \t](.*))?$/.exec(line);
      if (!top) return undefined;
      inAliases = line.startsWith("aliases:");
      if (inAliases && !/^\s*(?:\{\}\s*)?(?:#.*)?$/.test(top[1] ?? "")) return undefined;
      continue;
    }
    if (inAliases && leading <= (indent ??= leading)) lines++;
  }
  return lines === Object.keys(aliases).length ? aliases : undefined;
}

/** gh's own alias subcommands, which run before any alias of the same name. */
const aliasActions = new Set(["set", "delete", "list", "ls", "import"]);
/** gh groups an alias must not reach: the stack extension, alias management, and extensions. */
const guardedGroups = new Set(["stack", "alias", ...extensionGroups]);
/** gh's built-in commands that an alias may start with. Any other first word may be an extension or another alias. */
const builtins = new Set(["alias", "api", "attestation", "auth", "browse", "cache", "codespace", "completion", "config", "extension", "gist", "gpg-key", "help", "issue", "label", "org", "pr", "project", "release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status", "variable", "version", "workflow"]);
const plainName = /^[\w.:-]+(?: [\w.:-]+)*$/;
const plainExpansion = /^[\w \t\r\n=.,:/@+%-]*$/;

/**
 * The last name words of the aliases that may reach a guarded group: an expansion that is not plain words, that does
 * not start with a gh built-in, that names a guarded group, or that names a word of another such alias. Undefined when
 * an alias name is not plain words, since gh unquotes it.
 */
function unsafeAliasWords(aliases: Record<string, unknown>): Set<string> | undefined {
  const names = Object.keys(aliases);
  if (names.some((name) => !plainName.test(name))) return undefined;
  const unsafe = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    const reached = new Set([...guardedGroups, ...[...unsafe].flatMap((name) => name.split(" "))]);
    for (const name of names) {
      if (unsafe.has(name)) continue;
      const expansion = aliases[name];
      const words = typeof expansion === "string" ? expansion.split(/[ \t\r\n]+/).filter(Boolean) : [];
      if (typeof expansion === "string" && plainExpansion.test(expansion) && builtins.has(words[0] ?? "") && !words.some((word) => reached.has(word))) continue;
      unsafe.add(name);
      changed = true;
    }
  }
  return new Set([...unsafe].map((name) => name.split(" ").at(-1)!));
}

/**
 * The call's arguments when none of the agent's own gh aliases can hide a stack push in it, else undefined. gh picks an
 * alias through its leading words, synonyms such as `ext`, flags between words, and chains of aliases, so the guard
 * does not expand: it refuses any call that names the last word of an alias that may reach `gh stack`, `gh alias` or
 * an extension, and any call whose command may move gh's config. Only gh's own alias subcommands, which run before any
 * alias, skip the check.
 */
function expandedGh(args: string[], command: string): string[] | undefined {
  if (args[0] === "alias" && aliasActions.has(args[1] ?? "")) return args;
  const aliases = movesGhConfig(command) ? undefined : ghAliases();
  const unsafe = aliases && unsafeAliasWords(aliases);
  return unsafe && !args.some((arg) => unsafe.has(arg)) ? args : undefined;
}

function stackPushes(args: string[], repo: () => Repo | undefined): number {
  const [group, action, ...rest] = operandsOf(args);
  if (group !== "stack") return 0;
  if (stackPushActions.has(action ?? "")) {
    const found = repo();
    return found ? found.stack ?? 0 : largestForcePush + 1;
  }
  if (action !== "link") return 0;
  return rest.filter((arg) => !/^\d+$/.test(arg) && !/^https?:\/\//.test(arg)).length;
}

function refsOf(listing: string) {
  const refs = listing.split("\n").filter(Boolean);
  return { refs, branches: refs.filter((ref) => ref.startsWith("refs/heads/")).map(branchName) };
}

const isTrue = (value: string | undefined) => value !== undefined && /^(?:true|yes|on|1)$/i.test(value);

type GitCall = { dir: string | undefined; selectors: string[]; settings: string[]; sub?: string; args: string[] };

function gitCall(args: string[], cwd: string | undefined, env: ReadonlyMap<string, string>): GitCall {
  let dir = cwd;
  const selectors: string[] = [];
  const settings: string[] = [];
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-C") dir = dir === undefined ? undefined : resolve(dir, args[++index] ?? ".");
    else if (arg === "-c") settings.push(args[++index] ?? "");
    else if (/^-c./.test(arg)) settings.push(arg.slice(2));
    else if (arg === "--config-env") settings.push(fromEnvironment(args[++index] ?? "", env));
    else if (arg.startsWith("--config-env=")) settings.push(fromEnvironment(arg.slice("--config-env=".length), env));
    else if (arg === "--git-dir" || arg === "--work-tree") selectors.push(`${arg}=${args[++index] ?? ""}`);
    else if (/^--(?:git-dir|work-tree)=/.test(arg)) selectors.push(arg);
    else if (arg === "--namespace") index++;
    else if (!arg.startsWith("-")) break;
  }
  return { dir, selectors, settings, sub: args[index], args: args.slice(index + 1) };
}

function fromEnvironment(setting: string, env: ReadonlyMap<string, string>): string {
  const split = setting.indexOf("=");
  if (split < 0) return setting;
  const name = setting.slice(split + 1);
  return `${setting.slice(0, split)}=${env.get(name) ?? process.env[name] ?? ""}`;
}

function withSettings(repo: Repo, settings: string[]): Repo {
  const given = new Map<string, string[]>();
  for (const setting of settings) {
    const split = setting.indexOf("=");
    const key = configKey(split < 0 ? setting : setting.slice(0, split));
    given.set(key, [...given.get(key) ?? [], split < 0 ? "true" : setting.slice(split + 1)]);
  }
  return { ...repo, config: (key) => given.get(configKey(key))?.at(-1) ?? repo.config(key), values: (key) => [...repo.values(key), ...given.get(configKey(key)) ?? []] };
}

function shortSkipsHooks(arg: string): { skips: boolean; takesNext: boolean } {
  for (let letter = 1; letter < arg.length; letter++) {
    const char = arg[letter];
    if (char === "n") return { skips: true, takesNext: false };
    if (commitRequiredLetters.includes(char)) return { skips: false, takesNext: letter === arg.length - 1 };
    if (commitOptionalLetters.includes(char)) return { skips: false, takesNext: false };
  }
  return { skips: false, takesNext: false };
}

function skipsCommitHooks(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return false;
    if (arg === "--no-verify") return true;
    if (commitValued.has(arg)) index++;
    else if (/^-[A-Za-z]+$/.test(arg)) {
      const { skips, takesNext } = shortSkipsHooks(arg);
      if (skips) return true;
      if (takesNext) index++;
    }
  }
  return false;
}

type Push = { remote?: string; refspecs: string[]; force: boolean; lease: boolean; all: boolean; tags: boolean; deletes: boolean; noVerify: boolean; dryRun: boolean };

function parsePush(args: string[]): Push {
  const push: Push = { refspecs: [], force: false, lease: false, all: false, tags: false, deletes: false, noVerify: false, dryRun: false };
  const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (pushValued.has(arg)) {
      if (arg === "--repo") push.remote = args[index + 1];
      index++;
    } else if (arg.startsWith("--repo=")) push.remote = arg.slice(7);
    else if (arg === "--no-verify") push.noVerify = true;
    else if (arg === "--dry-run" || shortCluster(arg, "n", "o")) push.dryRun = true;
    else if (arg.startsWith("--force-with-lease")) push.lease = true;
    else if (arg === "--force" || shortCluster(arg, "f", "o")) push.force = true;
    else if (arg === "--mirror") push.force = push.all = true;
    else if (arg === "--all" || arg === "--branches") push.all = true;
    else if (arg === "--tags" || arg === "--no-tags") push.tags = arg === "--tags";
    else if (arg === "--delete" || shortCluster(arg, "d", "o")) push.deletes = true;
    else if (!arg.startsWith("-")) operands.push(arg);
  }
  push.remote = operands[0] ?? push.remote;
  push.refspecs = operands.slice(1);
  return push;
}

const branchName = (ref: string) => ref.replace(/^refs\/heads\//, "");

type Target = { name: string; upstream: boolean };

function remoteOf(push: Push, repo: Repo): { name?: string; urls: string[] } {
  const branch = repo.branch;
  const name = push.remote ?? (branch && repo.config(`branch.${branch}.pushRemote`)) ?? repo.config("remote.pushDefault") ?? (branch && repo.config(`branch.${branch}.remote`)) ?? "origin";
  if (/[:/]/.test(name)) return { urls: [name] };
  const pushUrls = repo.values(`remote.${name}.pushurl`);
  return { name, urls: pushUrls.length > 0 ? pushUrls : repo.values(`remote.${name}.url`) };
}

const globPattern = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", "(.*)")}$`);

function expandWildcard(spec: string, refs: string[]): Target[] {
  const [source, destination = source] = spec.split(":");
  const pattern = globPattern(source.startsWith("refs/") ? source : `refs/heads/${source}`);
  return refs.flatMap((ref) => {
    const match = ref.match(pattern);
    return match ? [{ name: branchName(destination.replace("*", match[1])), upstream: false }] : [];
  });
}

const configuredSpecs = (push: Push, repo: Repo, remote: string | undefined) =>
  push.refspecs.length > 0 ? push.refspecs : remote ? repo.values(`remote.${remote}.push`) : [];

const mirrors = (repo: Repo, remote: string | undefined) => remote !== undefined && isTrue(repo.config(`remote.${remote}.mirror`));

/** Where each ref of a push lands, as Git resolves it, including a bare `git push` under push.default. */
function targets(push: Push, repo: Repo, remote: string | undefined): Target[] {
  const pushDefault = repo.config("push.default") ?? "simple";
  const upstreamOf = (branch: string) => repo.config(`branch.${branch}.remote`) === remote ? repo.config(`branch.${branch}.merge`) : undefined;
  const every = () => repo.branches.map((name) => ({ name, upstream: false }));
  if (push.all || mirrors(repo, remote)) return every();
  if (push.tags && push.refspecs.length === 0) return [];
  const resolveSpec = (spec: string): Target[] => {
    const bare = spec.replace(/^\+/, "");
    if (bare === ":") return every();
    if (bare.includes("*")) return expandWildcard(bare, repo.refs);
    if (bare.includes(":")) return [{ name: branchName(bare.slice(bare.indexOf(":") + 1)), upstream: false }];
    if (bare === "HEAD" || bare === "@") return repo.branch ? [{ name: repo.branch, upstream: false }] : [];
    const local = branchName(bare);
    const upstream = !push.deletes && repo.branches.includes(local) && pushDefault === "upstream" ? upstreamOf(local) : undefined;
    return [{ name: branchName(upstream ?? local), upstream: upstream !== undefined }];
  };
  const specs = configuredSpecs(push, repo, remote);
  if (specs.length > 0) return specs.flatMap(resolveSpec);
  const branch = repo.branch;
  if (!branch || pushDefault === "nothing") return [];
  if (pushDefault === "matching") return every();
  const upstream = upstreamOf(branch);
  if (pushDefault === "upstream" || pushDefault === "tracking") return upstream ? [{ name: branchName(upstream), upstream: true }] : [];
  if (pushDefault === "simple" && upstream && branchName(upstream) !== branch) return [];
  return [{ name: branch, upstream: false }];
}

const forcesWithoutLease = (push: Push, repo: Repo, remote: string | undefined) =>
  mirrors(repo, remote) || configuredSpecs(push, repo, remote).some((spec) => spec.startsWith("+"));

/** Refuses Git calls that skip hooks, pushes to main or master of a GitHub repository that takes pull requests, force pushes
 * without a lease, and leased force pushes of more than five branches at once. A dry run passes. */
export function gitRisk(command: string, cwd: string, person: string, mainPushRepos: ReadonlySet<string>, read: ReadRepo = readRepo): string | undefined {
  const repos = new Map<string, Repo | undefined>();
  const repoAt = (dir: string | undefined, selectors: string[]) => {
    if (dir === undefined) return undefined;
    const key = [dir, ...selectors].join("\0");
    if (!repos.has(key)) repos.set(key, read(dir, selectors));
    return repos.get(key);
  };
  let forced = 0;
  for (const [call, directory] of withDirectories(commandsIn(command), cwd)) {
    const called = call.name === "gh" ? expandedGh(call.args, command) : call.args;
    if (called === undefined) return aliasReason(person);
    const stack = stackArgs(call.name, called);
    if ((stack && makesAlias(stack)) || ghAliasHidesStack(call.name, called)) return aliasReason(person);
    if (stack) forced += stackPushes(stack, () => repoAt(directory, []));
    if (call.name !== "git") continue;
    const { dir, selectors, settings, sub, args } = gitCall(call.args, directory, call.env);
    if (sub !== "commit" && sub !== "push" && sub !== "merge") continue;
    if (settings.some((setting) => /^core\.hookspath=/i.test(setting))) return hooksReason(person);
    if (sub === "commit" && skipsCommitHooks(args)) return hooksReason(person);
    if (sub === "merge" && args.includes("--no-verify")) return hooksReason(person);
    if (sub !== "push") continue;
    const push = parsePush(args);
    if (push.dryRun) continue;
    if (push.noVerify) return hooksReason(person);
    if (push.force || push.refspecs.some((spec) => spec.startsWith("+"))) return forceReason(person);
    const found = repoAt(dir, selectors);
    if (!found) {
      if (push.lease) forced += push.all ? largestForcePush + 1 : Math.max(1, push.refspecs.length);
      continue;
    }
    const repo = withSettings(found, settings);
    const remote = remoteOf(push, repo);
    if (forcesWithoutLease(push, repo, remote.name)) return forceReason(person);
    const landing = targets(push, repo, remote.name);
    if (push.lease) forced += landing.length;
    const slugs = remote.urls.map(githubSlug).filter((slug): slug is string => slug !== undefined);
    const guarded = slugs.find((slug) => !mainPushRepos.has(slug.toLowerCase()));
    if (!guarded || agentsPushToMain(repo.agents)) continue;
    const main = landing.find((target) => mainBranches.has(target.name));
    if (main) return mainReason(main.name, guarded, main.upstream, person);
  }
  return forced > largestForcePush ? burstReason(forced, person) : undefined;
}

export const repoList = (value: unknown) => new Set(typeof value === "string" ? value.split(/[\s,]+/).map((repo) => repo.trim().toLowerCase()).filter(Boolean) : []);
