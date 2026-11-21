import { homedir } from "node:os";
import { activeRuntime } from "../../../src/runtime/active.ts";
import { runCommand } from "../lib/command.ts";
import { threadsCommand } from "../lib/threads-cli.ts";

await runCommand(() => threadsCommand(Bun.argv.slice(2), {
  runtime: () => activeRuntime(Bun.env, Bun.env.HOME ?? homedir()),
  print: (line) => console.log(line),
  readStdin: () => Bun.stdin.text(),
}), "hedge threads");
