import { join } from "node:path";
import { quote } from "../adapters/jobs/launcher.ts";

/** A leading hedge runs the launcher of the engine at engineRoot, because get.sh puts no hedge on PATH. Other commands stay as they are. */
export function engineCommand(command: string[], engineRoot: string | undefined): string[] {
  return engineRoot && command[0] === "hedge" ? ["/bin/sh", join(engineRoot, "hedge"), ...command.slice(1)] : command;
}

/** The same for a shell command line, such as a human step's command. */
export function engineShellCommand(command: string, engineRoot: string | undefined): string {
  return engineRoot ? command.replace(/^hedge(?=\s|$)/, () => `/bin/sh ${quote(join(engineRoot, "hedge"))}`) : command;
}
