import { shortCluster } from "./kill.ts";
import { commandsIn, type Command } from "./shell-words.ts";

const gitValueOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

function gitSubcommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    if (gitValueOptions.has(args[index])) index++;
    else if (!args[index].startsWith("-")) return args[index];
  }
  return undefined;
}

function statusMatters({ name, args: [first, second, ...rest] }: Command): string | undefined {
  if ((name === "hedge" || name === "fleet") && first === "proof" && ["gate", "review", "save"].includes(second ?? "")) return `${name} proof ${second}`;
  if (name === "git") {
    const subcommand = gitSubcommand([first, second, ...rest].filter((arg) => arg !== undefined));
    return subcommand === "push" || subcommand === "commit" ? `git ${subcommand}` : undefined;
  }
  if (name === "gh" && first === "pr" && (second === "ready" || second === "merge")) return `gh pr ${second}`;
  if (name === "gh" && first === "run" && second === "watch" && rest.includes("--exit-status")) return "gh run watch --exit-status";
  return undefined;
}

const sets = (commands: Command[], matches: (args: string[]) => boolean) => commands.some((command) => command.name === "set" && matches(command.args));
const pipefail = (args: string[]) => args.includes("pipefail");
const errexit = (args: string[]) => args.some((arg) => arg === "-e" || shortCluster(arg, "e", "o"));
const printsStatus = (command: Command | undefined) => (command?.name === "echo" || command?.name === "printf") && command.args.some((arg) => arg.includes("$?"));

export const exitMaskReason = (what: string, how: string, person: string) => `Hedge blocked this command: ${how} hides the exit status of \`${what}\`, `
  + "so a failure reads as a success. Fix: run it alone or chain the next step with `&&`; to trim output, redirect it "
  + "(`> /tmp/out.log 2>&1`) and read the file next, or start with `set -o pipefail;`. `PIPESTATUS` also works. "
  + `If you are not sure, stop and ask ${person}.`;

export function exitMaskRisk(command: string, person: string): string | undefined {
  if (command.includes("PIPESTATUS")) return undefined;
  const commands = commandsIn(command);
  if (sets(commands, pipefail)) return undefined;
  const keepsSequence = sets(commands, errexit);
  const last = commands.at(-1);
  for (const each of commands) {
    const what = statusMatters(each);
    if (!what || each.tested) continue;
    if (each.after === "|") return exitMaskReason(what, "a pipe", person);
    if (keepsSequence || each === last) continue;
    if (each.after === ";") return exitMaskReason(what, "the `;` after it", person);
    if (printsStatus(last) && each.after !== "&&") return exitMaskReason(what, "the closing `echo $?`", person);
  }
  return undefined;
}
