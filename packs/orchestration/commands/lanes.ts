import { hostname } from "node:os";
import { activeRuntime } from "../../../src/runtime/active.ts";
import { runCommand } from "../../base/lib/command.ts";
import { runLanes } from "../lib/lanes.ts";

await runCommand(() => runLanes(Bun.argv.slice(2), { host: hostname(), threads: async () => (await activeRuntime()).threads, now: new Date(), print: (line) => console.log(line) }));
