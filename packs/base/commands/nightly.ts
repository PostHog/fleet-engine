import { homedir } from "node:os";
import { runCommand } from "../lib/command.ts";
import { nightlyCommand } from "../lib/nightly.ts";

await runCommand(() => nightlyCommand(Bun.argv.slice(2), { home: homedir(), engineRoot: Bun.env.HEDGE_ENGINE_DIR, now: () => new Date() }), "hedge nightly");
