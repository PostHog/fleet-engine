import type { ExecResult, Machine } from "../../../src/setup/commands.ts";
import type { RuntimeOnboarding } from "../../../src/sdk/runtime.ts";
import { hcNotFound, hcProblem } from "./hc.ts";

const hcOnPath = 'b="$HOME/.local/bin/herdr-core"; [ -x "$b" ] || b=hc; exec "$b" "$@"';

const hc = async (machine: Machine, args: string[]) => problemOf(await machine.exec(["sh", "-c", hcOnPath, "hc", ...args]));

const problemOf = (result: ExecResult) => ({ ...result, problem: () => hcProblem({ code: result.code, stdout: result.stdout, stderr: result.output.slice(result.stdout.length) }) });

type Listed = { name?: string; id?: string };

async function knows(machine: Machine, host: string) {
  const listed = await hc(machine, ["machine", "ls", "--json"]);
  if (listed.code !== 0) return false;
  try {
    const parsed = JSON.parse(listed.stdout) as { machines?: Listed[] } | Listed[];
    const machines = Array.isArray(parsed) ? parsed : (parsed.machines ?? []);
    return machines.some((machine) => machine.name === host || machine.id === host);
  } catch {
    return false;
  }
}

async function addMachine(machine: Machine, host: string): Promise<string | undefined> {
  if (await knows(machine, host)) return undefined;
  const added = await hc(machine, ["machine", "add", host, "--name", host]);
  return added.code === 0 ? undefined : added.problem();
}

export function herdrOnboarding(): RuntimeOnboarding {
  return {
    async link(host, { here, rerun }) {
      const problem = await addMachine(here, host);
      if (problem) throw new Error(`herdr-core here could not add ${host}: ${problem}. Fix that, then run ${rerun} again.`);
    },
    async linkFromHub(host, hub, { here, on, print, hubIsHere }) {
      const problem = await addMachine(hubIsHere ? here : on(hub), host);
      print(problem ? `· The hub, ${hub}, could not add ${host} in herdr-core: ${problem}. To add it, run hc machine add ${host} --name ${host} on ${hub}.` : `✓ The hub, ${hub}, reaches ${host} in herdr-core.`);
    },
    async unlink(host, { here, rerun }) {
      const removed = await hc(here, ["machine", "rm", host]);
      if (removed.code === hcNotFound) return { unlinked: false, hint: `herdr-core here has no machine named ${host}.` };
      if (removed.code !== 0) throw new Error(`herdr-core here could not remove ${host}: ${removed.problem()}. Fix that, then run ${rerun} again.`);
      return { unlinked: true };
    },
  };
}
