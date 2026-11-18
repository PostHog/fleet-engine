import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { refuseLinks, writePrivateFile } from "../../mcp-gateway/lib/client.ts";
import type { Run } from "../../mcp-gateway/lib/hub.ts";
import { must } from "./run.ts";

export type Managed = { path: string; content: string };

export const readIfThere = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });

/** Whether Hedge wrote content: its first line, or the line after an XML declaration, is marker, or the marker from before the rename that said Fleet. */
export function ownedBy(content: string, marker: string): boolean {
  const [first, second] = content.split("\n", 2);
  const line = first?.startsWith("<?xml ") === true && first.endsWith("?>") ? second : first;
  return line === marker || line === marker.replace("Hedge", "Fleet");
}

export async function readOwned(home: string, path: string, marker: string, what: string): Promise<string | undefined> {
  await refuseLinks(home, path, `${what} path`);
  const existing = await readIfThere(path);
  if (existing !== undefined && !ownedBy(existing, marker)) throw new Error(`Keep unmanaged ${what} file: ${path}`);
  return existing;
}

export async function changedFiles(home: string, files: Managed[], marker: string, what: string): Promise<Managed[]> {
  const changed: Managed[] = [];
  for (const file of files) if ((await readOwned(home, file.path, marker, what)) !== file.content) changed.push(file);
  return changed;
}

export async function writeFiles(files: Managed[]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writePrivateFile(file.path, file.content);
  }
}

export async function requireInstalled(home: string, files: Managed[], marker: string, what: string, fix: string, stale: string[] = []): Promise<void> {
  const differing = [...(await changedFiles(home, files, marker, what)).map((file) => file.path), ...stale];
  if (differing.length) throw new Error(`These ${what} files differ from what install writes now: ${differing.join(", ")}. Run ${fix}.`);
}

/** The files at paths that Hedge wrote and that are still there. A file Hedge did not write stops it, so nothing removes it. */
export async function ownedFiles(home: string, paths: string[], marker: string, what: string): Promise<string[]> {
  const owned: string[] = [];
  for (const path of paths) if ((await readOwned(home, path, marker, what)) !== undefined) owned.push(path);
  return owned;
}

/** Stops, disables and deletes the user units that Hedge wrote at paths, then reloads systemd once. */
export async function removeUnits(home: string, paths: string[], marker: string, what: string, run: Run): Promise<void> {
  const owned = await ownedFiles(home, paths, marker, what);
  for (const path of owned) {
    await must(run, ["systemctl", "--user", "disable", "--now", basename(path)]);
    await rm(path);
  }
  if (owned.length) await must(run, ["systemctl", "--user", "daemon-reload"]);
}
