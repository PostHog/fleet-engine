import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HcResult = { code: number; stdout: string; stderr: string };
export type Hc = (args: string[]) => Promise<HcResult>;

export const hcNotFound = 3;
export const hcFinished = 11;

export function hcBinary(home = homedir(), exists: (path: string) => boolean = existsSync) {
  return [join(home, ".local/bin/herdr-core"), join(home, ".local/bin/hc")].find(exists) ?? "hc";
}

export function spawnHc(binary = hcBinary()): Hc {
  return async (args) => {
    try {
      const child = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stdout, stderr };
    } catch (error) {
      return { code: 127, stdout: "", stderr: `${binary}: ${(error as Error).message}` };
    }
  };
}

export function hcProblem(result: HcResult) {
  try {
    const { error } = JSON.parse(result.stderr) as { error?: { message?: string; hint?: string } };
    if (error?.message) return [error.message, error.hint].filter(Boolean).join(" ");
  } catch {}
  return result.stderr.trim().split("\n").at(-1) || `exit ${result.code}`;
}
