import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRoot, stateDir } from "./notes.ts";

export type Trigger = { note: string; terms: string[] };

export const minimumTerm = 4;

const tableFile = (home: string) => join(stateDir(home), "triggers.json");
const frontmatterOf = (text: string) => /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
function unquote(raw: string) {
  const value = raw.trim();
  if (/^"[\s\S]*"$/.test(value)) return value.slice(1, -1).replace(/\\(.)/g, "$1").trim();
  if (/^'[\s\S]*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'").trim();
  return value;
}

export function stripFrontmatter(text: string) {
  const match = frontmatterOf(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

export function triggersOf(text: string): string[] {
  const block = frontmatterOf(text)?.[1] ?? "";
  const inline = /^\s*triggers:[ \t]*\[(.*)\][ \t]*$/m.exec(block);
  if (inline) return [...inline[1]!.matchAll(/\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]*)\s*(?:,|$)/g)].map((item) => unquote(item[1]!)).filter(Boolean);
  const start = /^\s*triggers:[ \t]*$/m.exec(block);
  if (!start) return [];
  const items: string[] = [];
  for (const line of block.slice(start.index + start[0].length).split("\n").slice(1)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!item) break;
    items.push(unquote(item[1]!));
  }
  return items.filter(Boolean);
}

export function noteFiles(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name.startsWith(".")) return [];
    if (entry.isDirectory()) return noteFiles(root, path);
    return entry.name.endsWith(".md") && entry.name !== "MEMORY.md" && entry.name !== "INDEX.md" ? [path] : [];
  });
}

function scanTriggers(home: string): Trigger[] {
  const root = memoryRoot(home);
  return noteFiles(root).flatMap((note) => {
    let text: string;
    try {
      text = readFileSync(join(root, note), "utf8");
    } catch {
      return [];
    }
    const terms = triggersOf(text).filter((term) => term.length >= minimumTerm);
    return terms.length ? [{ note, terms }] : [];
  });
}

export function refreshTriggers(home: string): Trigger[] {
  const table = scanTriggers(home);
  mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  const draft = `${tableFile(home)}.${process.pid}.tmp`;
  writeFileSync(draft, JSON.stringify(table), { mode: 0o600 });
  renameSync(draft, tableFile(home));
  return table;
}

export function readTriggers(home: string): Trigger[] {
  try {
    const table = JSON.parse(readFileSync(tableFile(home), "utf8"));
    if (Array.isArray(table)) return table as Trigger[];
  } catch {}
  return scanTriggers(home);
}

const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const names = (term: string, text: string) => new RegExp(`(?<![\\w-])${escape(term)}(?![\\w-])`, "i").test(text);

/**
 * The names a tool goes by. A note names an MCP tool by its short name, but Claude calls `mcp__t3-code__t3_thread_send`,
 * and a proxy that merges servers adds its upstream's name: `mcp__proxy-grafana-us__grafana-us-query_prometheus`.
 * Whole-word matching misses both, so a term also matches the name without the `mcp__<server>__` prefix and without
 * the end of the server name put before it.
 */
export function toolNames(tool: string): string[] {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (!mcp) return [tool];
  const [, server, name] = mcp;
  const parts = server.split("-");
  const prefix = parts.map((_, index) => `${parts.slice(index).join("-")}-`).find((candidate) => name.startsWith(candidate));
  return [tool, name, ...(prefix && name.length > prefix.length ? [name.slice(prefix.length)] : [])];
}

export function textsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(textsOf);
  return [];
}
