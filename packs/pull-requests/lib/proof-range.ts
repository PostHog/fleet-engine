import { reviewedDiff } from "./proof-review.ts";

type Result = { code: number; stdout: string; stderr: string };
export type Run = (command: string[]) => Result;

export type ReviewRange = { files: string[]; leftOut: string[]; diff: string };

export function reviewRange(run: Run, from: string, head: string, branched: string): ReviewRange {
  const changed = changedFiles(run, from, head);
  if (from === branched) return { files: changed.map(last), leftOut: [], diff: changed.length ? diffOf(run, from, head) : "" };
  const merged = cleanMerge(run, from, branched);
  return merged === undefined ? ownedRange(run, from, head, branched, changed) : rangeFromMerge(run, merged, head, changed);
}

export const leftOutNote = (leftOut: string[]) =>
  leftOut.length ? `This diff holds only the files the PR changes against its base. It leaves out ${leftOut.length} file(s) that a merge of the base brought in.` : "";

function rangeFromMerge(run: Run, merged: string, head: string, changed: string[][]): ReviewRange {
  const authored = changedFiles(run, merged, head);
  const paths = new Set(authored.flat());
  const leftOut = changed.filter((entry) => !entry.some((path) => paths.has(path))).map(last);
  return { files: authored.map(last), leftOut, diff: authored.length ? diffOf(run, merged, head) : "" };
}

function ownedRange(run: Run, from: string, head: string, branched: string, changed: string[][]): ReviewRange {
  const own = new Set([...changedFiles(run, branched, head), ...changedFiles(run, forkOf(run, from, branched), from)].flat());
  const kept = changed.filter((paths) => paths.some((path) => own.has(path)));
  const files = kept.map(last);
  const leftOut = changed.filter((paths) => !kept.includes(paths)).map(last);
  return { files, leftOut, diff: files.length ? diffOf(run, from, head, leftOut.length ? kept.flat() : undefined) : "" };
}

function cleanMerge(run: Run, from: string, branched: string) {
  const result = run(["git", "merge-tree", "--write-tree", "--no-messages", from, branched]);
  if (result.code === 1) return undefined;
  if (result.code !== 0) throw new Error(`Cannot merge ${short(branched)} into ${short(from)} here (${firstLine(result.stderr)})`);
  return result.stdout.trim().split("\n")[0]!;
}

function forkOf(run: Run, from: string, branched: string) {
  const result = run(["git", "merge-base", from, branched]);
  if (result.code !== 0) throw new Error(`Cannot find where ${short(from)} branched from the base here (${firstLine(result.stderr)})`);
  return result.stdout.trim();
}

// Each entry holds a file's paths: one, or the old and new path of a rename or copy. -z keeps names unquoted.
function changedFiles(run: Run, from: string, to: string) {
  const result = run(["git", "diff", "--name-status", "-z", "--find-renames", "--no-relative", from, to]);
  if (result.code !== 0) throw new Error(`Cannot list the files of ${short(from)}..${short(to)} here (${firstLine(result.stderr)})`);
  const fields = result.stdout.split("\0");
  const entries: string[][] = [];
  for (let index = 0; index < fields.length && fields[index]; ) {
    const count = /^[RC]/.test(fields[index]!) ? 2 : 1;
    entries.push(fields.slice(index + 1, index + 1 + count));
    index += 1 + count;
  }
  return entries;
}

function diffOf(run: Run, from: string, to: string, files?: string[]) {
  const paths = files ? ["--", ...files.map((file) => `:(top,literal)${file}`)] : [];
  const result = run(["git", "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--no-relative", from, to, ...paths]);
  if (result.code !== 0) throw new Error(`Cannot diff ${short(from)}..${short(to)} here (${firstLine(result.stderr)})`);
  return reviewedDiff(result.stdout);
}

const last = (paths: string[]) => paths[paths.length - 1]!;
const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
