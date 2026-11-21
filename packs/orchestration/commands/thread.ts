import { hostname } from "node:os";
import { activeRuntime } from "../../../src/runtime/active.ts";
import { runCommand } from "../../base/lib/command.ts";
import { runThread } from "../lib/thread.ts";

await runCommand(() => runThread(Bun.argv.slice(2), { host: hostname(), threads: async () => (await activeRuntime()).threads, print: (line) => console.log(line), readStdin: () => Bun.stdin.text() }));
