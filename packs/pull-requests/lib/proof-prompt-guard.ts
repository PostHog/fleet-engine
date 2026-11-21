import { cookieKind, cookieNamedAt, redactForModel } from "../../base/hooks/secret-guard.ts";

export type GuardedPrompt = { ok: true; prompt: string; redacted?: string } | { ok: false; cause: string };

export const placeholderRule = "Text such as [redacted GitHub token] in this prompt can be a placeholder for a secret-shaped value Hedge removed before the model call. On an added diff line, a placeholder means the change adds a secret-shaped literal: report it. Elsewhere, a placeholder is no finding by itself.";

const fixtureRule = "A repository file must hold no secret-shaped literal: build the test fixture at run time from parts, as packs/base/hooks/hooks.test.ts in Hedge does.";
const shownPlaces = 5;

export function guardedPrompt(prompt: string): GuardedPrompt {
  const { text, values, left } = redactForModel(prompt);
  if (left.length) return { ok: false, cause: `Hedge did not send the prompt to the model: Hedge's secret guard blocks a prompt that holds a ${[...new Set(left)].join(", ")}, and Hedge could not redact it.${cookieRule(promptLines(prompt, "all"), left)} ${fixtureRule}` };
  if (!values.length) return { ok: true, prompt: text.includes("[redacted ") ? withRule(text) : text };
  const lines = promptLines(prompt, values);
  const places = [...new Set(values.map(({ kind, at }) => `a ${kind} (at ${placeOf(lines, at)})`))];
  const more = places.length > shownPlaces ? `, and ${places.length - shownPlaces} more` : "";
  const redacted = `Hedge redacted ${values.length} secret-shaped value${values.length === 1 ? "" : "s"} from the prompt before the model call: ${places.slice(0, shownPlaces).join(", ")}${more}.${cookieRule(lines, values.map(({ kind }) => kind))} ${fixtureRule}`;
  return { ok: true, prompt: withRule(text), redacted };
}

const withRule = (text: string) => text.includes(placeholderRule) ? text : `${text}\n\n${placeholderRule}\n`;

function cookieRule(lines: PromptLines, kinds: string[]) {
  const named = cookieNamedAt(lines.prompt);
  return kinds.includes(cookieKind) && named >= 0 ? ` When a prompt names the Metabase session cookie, the guard reads each long token with a digit in it as the cookie's value; this prompt names it at ${placeOf(lines, named)}.` : "";
}

type Region = { at: number; end: number };
type PromptLines = { prompt: string; lines: string[]; starts: number[]; hidden: (row: number) => boolean };

function promptLines(prompt: string, regions: Region[] | "all"): PromptLines {
  const lines = prompt.split("\n");
  let offset = 0;
  const starts = lines.map((line) => (offset += line.length + 1) - line.length - 1);
  const overlaps = (row: number) => Array.isArray(regions) && regions.some(({ at, end }) => at <= starts[row]! + lines[row]!.length && end > starts[row]!);
  return { prompt, lines, starts, hidden: (row) => regions === "all" || overlaps(row) };
}

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const sectionStart = /^(?:<untrusted source="([^"]*)">|<([a-z-]+)>|#{2,3} (.+))$/;

function placeOf(lines: PromptLines, at: number) {
  const row = lines.prompt.slice(0, at).split("\n").length - 1;
  return diffPlace(lines, row) ?? `line ${row + 1} of the prompt${sectionOf(lines, row)}`;
}

function diffPlace({ lines, hidden }: PromptLines, row: number) {
  const line = lines[row]!;
  if (!/^[ +-]/.test(line)) return undefined;
  let [added, removed] = [0, 0];
  for (let index = row - 1; index >= 0; index--) {
    const header = hunkHeader.exec(lines[index]!);
    if (header) return fileAt(lines, hidden, index, line.startsWith("-") ? "--- a/" : "+++ b/", Number(line.startsWith("-") ? header[1] : header[2]) + (line.startsWith("-") ? removed : added));
    const sign = lines[index]![0];
    if (sign === "+") added++;
    else if (sign === "-") removed++;
    else if (sign === " ") { added++; removed++; }
    else if (sign !== "\\") return undefined;
  }
  return undefined;
}

function fileAt(lines: string[], hidden: PromptLines["hidden"], hunk: number, prefix: string, number: number) {
  for (let index = hunk - 1; index > 0; index--) {
    if (lines[index]!.startsWith("+++ ") && lines[index - 1]!.startsWith("--- ")) {
      const row = prefix === "+++ b/" ? index : index - 1;
      return lines[row]!.startsWith(prefix) && !hidden(row) ? `${lines[row]!.slice(prefix.length)}:${number}` : undefined;
    }
  }
  return undefined;
}

function sectionOf({ lines, hidden }: PromptLines, row: number) {
  for (let index = row; index >= 0; index--) {
    const match = sectionStart.exec(lines[index]!);
    if (!match) continue;
    if (hidden(index)) return "";
    return match[1] !== undefined ? `, in "${match[1]}"` : match[2] ? `, in <${match[2]}>` : `, under "${match[3]}"`;
  }
  return "";
}
