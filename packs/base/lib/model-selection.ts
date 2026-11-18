import { readFileSync } from "node:fs";
import { join } from "node:path";

const heading = "## Model selection";

export function modelSelection(home: string): string | undefined {
  let lines: string[];
  try {
    lines = readFileSync(join(home, ".agents/AGENTS.md"), "utf8").split("\n");
  } catch {
    return undefined;
  }
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const first = rest.findIndex((line) => line.trim() !== "");
  if (first < 0 || !rest[first]!.trimStart().startsWith("|")) return undefined;
  const after = rest.slice(first);
  const end = after.findIndex((line) => !line.trimStart().startsWith("|"));
  const table = after.slice(0, end < 0 ? undefined : end);
  return table.length >= 3 ? [heading, "", ...table].join("\n") : undefined;
}
