import { cookieKind, cookieNamedAt, redactForModel } from "../../base/hooks/secret-guard.ts";

export type GuardedPrompt = { ok: true; prompt: string; redacted?: string } | { ok: false; cause: string };

export const placeholderRule = "Hedge replaced each secret-shaped value in this prompt with a placeholder such as [redacted GitHub token]: a placeholder is no finding by itself, but one on an added diff line means the change adds a secret-shaped literal.";

const fixtureRule = "A repository file must hold no secret-shaped literal: build the test fixture at run time from parts, as packs/base/hooks/hooks.test.ts in Hedge does.";
const shownPlaces = 5;

export function guardedPrompt(prompt: string): GuardedPrompt {
  const { text, values, left } = redactForModel(prompt);
  if (left.length) return { ok: false, cause: `Hedge did not send the prompt to the model: Hedge's secret guard blocks a prompt that holds a ${[...new Set(left)].join(", ")}, and Hedge could not redact it.${cookieRule(prompt, left)} ${fixtureRule}` };
  if (!values.length) return { ok: true, prompt: text.includes("[redacted ") ? withRule(text) : text };
  const places = [...new Set(values.map(({ kind, at }) => `a ${kind} (at ${placeOf(prompt, at)})`))];
  const more = places.length > shownPlaces ? `, and ${places.length - shownPlaces} more` : "";
  const redacted = `Hedge redacted ${values.length} secret-shaped value${values.length === 1 ? "" : "s"} from the prompt before the model call: ${places.slice(0, shownPlaces).join(", ")}${more}.${cookieRule(prompt, values.map(({ kind }) => kind))} ${fixtureRule}`;
  return { ok: true, prompt: withRule(text), redacted };
}

const withRule = (text: string) => text.includes(placeholderRule) ? text : `${text}\n\n${placeholderRule}\n`;

function cookieRule(prompt: string, kinds: string[]) {
  const named = cookieNamedAt(prompt);
  return kinds.includes(cookieKind) && named >= 0 ? ` When a prompt names the Metabase session cookie, the guard reads each long token with a digit in it as the cookie's value; this prompt names it at ${placeOf(prompt, named)}.` : "";
}

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const sectionStart = /^(?:<untrusted source="([^"]*)">|<([a-z-]+)>|#{2,3} (.+))$/;

function placeOf(prompt: string, at: number) {
  const lines = prompt.slice(0, at).split("\n");
  const row = lines.length - 1;
  const line = prompt.slice(at - lines[row]!.length).split("\n", 1)[0]!;
  const all = prompt.split("\n");
  return diffPlace(all, row, line) ?? `line ${row + 1} of the prompt${sectionOf(all, row)}`;
}

function diffPlace(lines: string[], row: number, line: string) {
  if (!/^[ +-]/.test(line)) return undefined;
  let [added, removed] = [0, 0];
  for (let index = row - 1; index >= 0; index--) {
    const header = hunkHeader.exec(lines[index]!);
    if (header) return fileAt(lines, index, line.startsWith("-") ? "--- a/" : "+++ b/", Number(line.startsWith("-") ? header[1] : header[2]) + (line.startsWith("-") ? removed : added));
    const sign = lines[index]![0];
    if (sign === "+") added++;
    else if (sign === "-") removed++;
    else if (sign === " ") { added++; removed++; }
    else if (sign !== "\\") return undefined;
  }
  return undefined;
}

function fileAt(lines: string[], hunk: number, prefix: string, number: number) {
  for (let index = hunk - 1; index > 0; index--) {
    if (lines[index]!.startsWith("+++ ") && lines[index - 1]!.startsWith("--- ")) {
      const path = lines[prefix === "+++ b/" ? index : index - 1]!;
      return path.startsWith(prefix) ? `${path.slice(prefix.length)}:${number}` : undefined;
    }
  }
  return undefined;
}

function sectionOf(lines: string[], row: number) {
  for (let index = row; index >= 0; index--) {
    const match = sectionStart.exec(lines[index]!);
    if (match) return match[1] !== undefined ? `, in "${match[1]}"` : match[2] ? `, in <${match[2]}>` : `, under "${match[3]}"`;
  }
  return "";
}
