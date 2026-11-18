import { readFileSync } from "node:fs";
import { join } from "node:path";

const heading = "## Model selection";

export function modelSelection(home: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(home, ".agents/AGENTS.md"), "utf8");
  } catch {
    return undefined;
  }
  const start = text.search(/^## Model selection[ \t]*$/m);
  if (start < 0) return undefined;
  const next = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, next < 0 ? undefined : next).trim();
}

export function tableRows(section: string, work: RegExp): string | undefined {
  const lines = section.split("\n").filter((line) => line.trimStart().startsWith("|"));
  const [header, rule, ...rows] = lines;
  const matching = rows.filter((row) => work.test(row.split("|")[1] ?? ""));
  return header && rule && matching.length ? [header, rule, ...matching].join("\n") : undefined;
}
