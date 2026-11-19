import type { Merged, RangeStart } from "./proof-delta.ts";
import { reviewedDiff } from "./proof-review.ts";

type Result = { code: number; stdout: string; stderr: string };
export type Run = (command: string[]) => Result;

export type ReviewRange = { files: string[]; diff: string };

export function reviewRange(run: Run, { from, merged }: RangeStart, head: string): ReviewRange {
  const conflicts = merged?.conflicts ?? [];
  const files = [...new Set([...changedFiles(run, from, head), ...conflicts])];
  return { files, diff: diffOf(run, from, head) + conflicts.map((path) => conflictDiff(run, merged!, head, path)).join("") };
}

const shellWord = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

function conflictDiff(run: Run, { reviewed, base }: Merged, head: string, path: string) {
  const lead = `# Conflict in ${path}: the merge of the reviewed head ${reviewed} with the base ${base} leaves it in conflict, and HEAD resolves it. Read both sides with git show ${shellWord(`${reviewed}:${path}`)} and git show ${shellWord(`${base}:${path}`)}.`;
  return [reviewedDiff(`\n${lead}`), `# HEAD against the reviewed head:`, diffOf(run, reviewed, head, [path]), `# HEAD against the base:`, diffOf(run, base, head, [path])].join("\n");
}

function changedFiles(run: Run, from: string, to: string) {
  const result = run(["git", "diff", "--name-status", "-z", "--find-renames", "--no-relative", from, to]);
  if (result.code !== 0) throw new Error(`Cannot list the files of ${short(from)}..${short(to)} here (${firstLine(result.stderr)})`);
  const fields = result.stdout.split("\0");
  const files: string[] = [];
  for (let index = 0; index < fields.length && fields[index]; ) {
    const count = /^[RC]/.test(fields[index]!) ? 2 : 1;
    files.push(fields[index + count]!);
    index += 1 + count;
  }
  return files;
}

function diffOf(run: Run, from: string, to: string, files?: string[]) {
  const paths = files ? ["--", ...files.map((file) => `:(top,literal)${file}`)] : [];
  const result = run(["git", "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--no-relative", from, to, ...paths]);
  if (result.code !== 0) throw new Error(`Cannot diff ${short(from)}..${short(to)} here (${firstLine(result.stderr)})`);
  return reviewedDiff(result.stdout);
}

const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
