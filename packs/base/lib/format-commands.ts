import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

export type LintStagedConfig = Record<string, unknown>;
export type RunCommand = (command: string[], cwd: string, timeoutMs: number) => Promise<string | undefined>;
export type FindFormatter = (name: string, root: string) => Promise<string | undefined>;
type Formatter = { subcommands?: string[]; flags: string[]; values?: string[]; loadsCode?: true; always?: string[] };

const configFiles = [".lintstagedrc", ".lintstagedrc.json"];
export const formatters: Record<string, Formatter> = {
  prettier: {
    loadsCode: true,
    flags: ["--write", "-w", "--check", "--list-different", "-l", "--ignore-unknown", "-u", "--no-error-on-unmatched-pattern", "--single-quote", "--jsx-single-quote", "--no-semi", "--use-tabs", "--no-bracket-spacing"],
    values: ["--log-level", "--tab-width", "--print-width", "--trailing-comma", "--prose-wrap", "--end-of-line", "--arrow-parens", "--quote-props"],
  },
  eslint: { loadsCode: true, flags: ["--fix", "--quiet", "--no-warn-ignored", "--no-error-on-unmatched-pattern", "--report-unused-disable-directives"], values: ["--max-warnings"] },
  oxlint: { loadsCode: true, flags: ["--fix", "--fix-suggestions", "--quiet", "--deny-warnings", "--no-error-on-unmatched-pattern"], values: ["--max-warnings"] },
  stylelint: { loadsCode: true, flags: ["--fix", "--quiet", "--allow-empty-input"], values: ["--max-warnings"] },
  markdownlint: { loadsCode: true, flags: ["--fix"] },
  "markdownlint-cli2": { loadsCode: true, flags: ["--fix", "--no-globs"] },
  dprint: { loadsCode: true, subcommands: ["fmt", "check"], flags: ["--allow-no-files"] },
  biome: { subcommands: ["check", "format", "lint"], flags: ["--write", "--apply", "--fix", "--unsafe", "--no-errors-on-unmatched", "--error-on-warnings"], values: ["--diagnostic-level", "--files-ignore-unknown", "--colors"] },
  ruff: { subcommands: ["check", "format"], flags: ["--fix", "--unsafe-fixes", "--exit-non-zero-on-fix", "--force-exclude", "--quiet", "-q", "--no-cache", "--show-fixes"], values: ["--line-length", "--target-version"], always: ["--no-cache"] },
  black: { loadsCode: true, flags: ["--quiet", "-q", "--fast", "--preview", "--skip-string-normalization", "-S"], values: ["--line-length", "-l", "--target-version", "-t"] },
  isort: { flags: ["--quiet", "-q", "--filter-files", "--atomic"], values: ["--profile"] },
  gofmt: { flags: ["-w", "-s", "-l"] },
  goimports: { flags: ["-w", "-l"] },
  shfmt: { flags: ["-w", "--write", "-s", "--simplify", "-ci", "-bn", "-sr", "-l", "-d"], values: ["-i", "--indent"] },
  "clang-format": { flags: ["-i"], values: ["--style"] },
  taplo: { subcommands: ["format", "fmt"], flags: [] },
  yamlfmt: { flags: [] },
};
const toolPins = [".tool-versions", ".mise.toml", "mise.toml", ".mise.local.toml", "mise.local.toml", ".mise", "mise", ".config/mise.toml", ".config/mise", ".rtx.toml", ".prototools", ".python-version", ".node-version", ".nvmrc", ".go-version"];
const plainValue = /^[A-Za-z0-9_-]+$/;
const globSyntax = /[*?[\]{}]/;

function matches(pattern: string, path: string): boolean {
  try {
    return new Bun.Glob(pattern).match(pattern.includes("/") ? path : basename(path));
  } catch {
    return false;
  }
}

async function tracked(path: string): Promise<boolean> {
  try {
    const child = Bun.spawn(["git", "-C", dirname(path), "ls-files", "-z", "--", `:(literal,icase)${basename(path)}`], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [listed, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code !== 0 || listed !== "";
  } catch {
    return true;
  }
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function installedFormatter(name: string, root: string): Promise<string | undefined> {
  const realRoot = realpathSync(root);
  const real = realpathSync(join(root, "node_modules/.bin", name));
  if (!inside(join(realRoot, "node_modules"), real)) return undefined;
  return (await tracked(real)) ? undefined : real;
}

function onPath(name: string, root: string): string | undefined {
  if (toolPins.some((pin) => existsSync(join(root, pin)))) return undefined;
  const path = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter);
  const found = Bun.which(name, { PATH: path });
  if (!found || !isAbsolute(found)) return undefined;
  const real = realpathSync(found);
  return inside(root, found) || inside(realpathSync(root), real) ? undefined : found;
}

export const findFormatter: FindFormatter = async (name, root) => {
  try {
    if (existsSync(join(root, "node_modules/.bin", name))) return await installedFormatter(name, root);
    return formatters[name]?.loadsCode ? undefined : onPath(name, root);
  } catch {
    return undefined;
  }
};

function allowedArguments({ subcommands, flags, values = [] }: Formatter, args: string[]): boolean {
  let index = 0;
  if (subcommands && !subcommands.includes(args[index++] ?? "")) return false;
  for (; index < args.length; index++) {
    const [flag = "", ...joined] = args[index]!.split("=");
    if (!joined.length && flags.includes(flag)) continue;
    if (!values.includes(flag)) return false;
    const value = joined.length ? joined.join("=") : args[++index];
    if (!value || !plainValue.test(value)) return false;
  }
  return true;
}

async function formatterCommand(command: string, root: string, find: FindFormatter): Promise<string[] | undefined> {
  const [program = "", ...args] = command.split(/\s+/);
  const formatter = Object.hasOwn(formatters, program) ? formatters[program] : undefined;
  if (!formatter || !allowedArguments(formatter, args)) return undefined;
  const path = await find(program, root);
  return path ? [path, ...args, ...formatter.always ?? []] : undefined;
}

export async function formatCommands(config: LintStagedConfig, root: string, file: string, find: FindFormatter = findFormatter): Promise<string[][]> {
  const path = relative(root, file);
  if (!inside(root, file) || path === "") return [];
  const commands = Object.entries(config)
    .filter(([pattern]) => !pattern.startsWith("!") && matches(pattern, path))
    .flatMap(([, value]) => [value].flat())
    .filter((command): command is string => typeof command === "string")
    .map((command) => command.trim());
  const resolved = await Promise.all([...new Set(commands)].map((command) => formatterCommand(command, root, find)));
  return resolved.filter((command): command is string[] => command !== undefined).map((command) => [...command, file]);
}

function fileInside(root: string, file: string): boolean {
  try {
    return !globSyntax.test(file) && statSync(file).isFile() && inside(realpathSync(root), realpathSync(file));
  } catch {
    return false;
  }
}

export function repositoryRoot(directory: string): string | undefined {
  if (existsSync(join(directory, ".git"))) return directory;
  const parent = dirname(directory);
  return parent === directory ? undefined : repositoryRoot(parent);
}

export function readLintStaged(root: string): LintStagedConfig | undefined {
  try {
    const file = configFiles.map((name) => join(root, name)).find(existsSync);
    const config = file ? JSON.parse(readFileSync(file, "utf8")) : JSON.parse(readFileSync(join(root, "package.json"), "utf8"))["lint-staged"];
    return typeof config === "object" && config !== null && !Array.isArray(config) ? config : undefined;
  } catch {
    return undefined;
  }
}

export async function formatEditedFile(file: string, run: RunCommand, budgetMs: number, now: () => number = Date.now, find: FindFormatter = findFormatter): Promise<string[]> {
  const root = repositoryRoot(dirname(file));
  const config = root && readLintStaged(root);
  if (!root || !config || !fileInside(root, file)) return [];
  const deadline = now() + budgetMs;
  const findings: string[] = [];
  for (const command of await formatCommands(config, root, file, find)) {
    const left = deadline - now();
    if (left <= 0) break;
    const finding = await run(command, root, left);
    if (finding) findings.push(finding);
  }
  return findings;
}
