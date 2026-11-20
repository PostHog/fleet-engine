import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { claudeWrapperCommand } from "../lib/recovery/bind.ts";

await runCommand(() => claudeWrapperCommand(Bun.argv.slice(2), { home: homedir(), print: (line) => console.log(line) }), "hedge claude-wrapper");
