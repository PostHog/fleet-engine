import { join } from "node:path";
import { quote } from "../adapters/jobs/launcher.ts";

/** A command line with its leading fleet, the name from before the rename, read as hedge. */
export const asHedge = (command: string[]): string[] => (command[0] === "fleet" ? ["hedge", ...command.slice(1)] : command);

/** The same for a shell command line, such as a human step's command. */
export const asHedgeLine = (command: string): string => command.replace(/^fleet(?=\s|$)/, "hedge");

/** A leading hedge runs the launcher of the engine at engineRoot, because get.sh puts no hedge on PATH. Other commands stay as they are. */
export function engineCommand(command: string[], engineRoot: string | undefined): string[] {
  return engineRoot && (command[0] === "hedge" || command[0] === "fleet") ? ["/bin/sh", join(engineRoot, "hedge"), ...command.slice(1)] : command;
}

/** The same for a shell command line, such as a human step's command. */
export function engineShellCommand(command: string, engineRoot: string | undefined): string {
  return engineRoot ? command.replace(/^(?:hedge|fleet)(?=\s|$)/, () => `/bin/sh ${quote(join(engineRoot, "hedge"))}`) : command;
}
