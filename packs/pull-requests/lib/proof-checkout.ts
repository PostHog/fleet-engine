import { readPullRequest, type Run } from "./pr-ci.ts";
import { reviewedDiff } from "./proof-review.ts";
import { isTestFile } from "./proof-delta.ts";
import { riskCalloutOf } from "./decision-ledger.ts";
import type { CleanBaseMerge, DevPr, DevPull, ProofIdentity } from "./proof.ts";

const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

export function topLevel(run: Run) {
  const result = run(["git", "rev-parse", "--show-toplevel"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * Where the PR branched from its base. A base branch this checkout has not fetched is fetched from the repository's
 * remote once; without such a remote, or without the commit, the error names the commands that fix it.
 */
const fetchBase = (run: Run, base: string, remotes: string[]) => {
  for (const remote of remotes) run(["git", "fetch", "--quiet", remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`]);
};

export function mergeBase(identity: ProofIdentity, run: Run) {
  const base = pullRequestDetails(identity, run).baseRefName;
  const remotes = remotesOf(identity.repository, run);
  const found = () => {
    for (const remote of remotes) {
      const result = run(["git", "merge-base", `refs/remotes/${remote}/${base}`, identity.commit]);
      if (result.code === 0) return result.stdout.trim();
    }
    return undefined;
  };
  const before = found();
  if (before) return before;
  fetchBase(run, base, remotes);
  const after = found();
  if (after) return after;
  const where = `Cannot find where ${identity.repository}#${identity.pr} branched from its base ${base} here`;
  if (!remotes.length) throw new Error(`${where}: no remote of this checkout points at ${identity.repository}. Run the command in a checkout of ${identity.repository}, or add one here: git remote add hedge-base https://github.com/${identity.repository}.git && git fetch hedge-base ${base} pull/${identity.pr}/head`);
  if (run(["git", "cat-file", "-e", `${identity.commit}^{commit}`]).code !== 0) throw new Error(`${where}: ${short(identity.commit)} is not in this checkout. Run git fetch ${remotes[0]} pull/${identity.pr}/head`);
  throw new Error(`${where}, after fetching ${base} from ${remotes.join(", ")}: ${short(identity.commit)} shares no history with it`);
}

export function baseTip(identity: ProofIdentity, run: Run) {
  for (const ref of baseRefs(identity, run)) {
    const result = run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (result.code === 0) return result.stdout.trim();
  }
  throw new Error(`Cannot find the base branch of ${identity.repository}#${identity.pr} here. Fetch it from a remote of ${identity.repository}`);
}

export function diffOf(from: string, to: string, run: Run) {
  const diff = run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-relative", from, to]);
  if (diff.code !== 0) throw new Error(`Cannot diff ${short(from)}..${short(to)} here (${firstLine(diff.stderr)})`);
  return reviewedDiff(diff.stdout);
}

const docsFile = /\.(md|mdx|markdown|rst)$/i;
const lockFile = /(^|\/)([^/]+\.lockb?|package-lock\.json|pnpm-lock\.yaml|go\.sum)$/;
const generatedFile = /(^|\/)(__generated__|generated)\/|\.(generated|gen|min)\.[a-z]+$|\.pb\.go$|_pb2\.pyi?$/;
const readLines = 50;
const authored = (path: string) => !isTestFile(path) && ![docsFile, lockFile, generatedFile].some((pattern) => pattern.test(path));
export const isProductionFile = authored;

export type TierName = "read" | "pair" | "panel";
export type ReviewTier = { name: TierName; why: string };

export const tierLenses: Record<TierName, string[]> = {
  read: ["correctness:other", "risk:other"],
  pair: ["correctness:other", "risk:other", "fresh-eyes:same"],
  panel: ["fresh-eyes", "correctness", "risk", "design", "anti-overengineering"],
};

export const tierCeiling = (tier: ReviewTier, ceiling: number) => tier.name === "read" ? Math.min(2, ceiling) : ceiling;

function gradeOf(body: string | undefined) {
  if (body === undefined) return "unreadable";
  const grade = /Merge risk:\**\s*(low|medium|high)(?![\w/-])(?!\s+[/-]\s*(?:low|medium|high)\b)/i.exec(riskCalloutOf(body) ?? body)?.[1]?.toLowerCase();
  return grade ?? (/merge[- ]risk/i.test(body) ? "unreadable" : "none");
}

function branchPoint(identity: ProofIdentity, run: Run, baseSha?: string) {
  if (!baseSha) return mergeBase(identity, run);
  const found = () => run(["git", "merge-base", baseSha, identity.commit]);
  let point = found();
  if (point.code !== 0) {
    fetchBase(run, pullRequestDetails(identity, run).baseRefName, remotesOf(identity.repository, run));
    point = found();
  }
  if (point.code !== 0) throw new Error(`Cannot find the base ${short(baseSha)} that GitHub reports for ${identity.repository}#${identity.pr} here`);
  return point.stdout.trim();
}

function changedLines(identity: ProofIdentity, run: Run, start: string, renames: boolean) {
  const stat = run(["git", "diff", "--numstat", "-z", renames ? "--find-renames" : "--no-renames", "--no-relative", start, identity.commit]);
  if (stat.code !== 0) return undefined;
  const fields = stat.stdout.split("\0");
  const changed: { lines: number; path: string }[] = [];
  for (let index = 0; index < fields.length; index++) {
    if (!fields[index]) continue;
    const [added = "", deleted = "", ...named] = fields[index]!.split("\t");
    let path = named.join("\t");
    if (!path) { path = fields[index + 2] ?? ""; index += 2; }
    const binary = added === "-" || deleted === "-";
    changed.push({ lines: binary ? Number.POSITIVE_INFINITY : (Number(added) || 0) + (Number(deleted) || 0), path });
  }
  return changed;
}

const linesOf = (changed: { lines: number; path: string }[], kept: (path: string) => boolean) =>
  changed.filter(({ path }) => kept(path)).reduce((sum, { lines }) => sum + lines, 0);

const productionLines = (identity: ProofIdentity, run: Run, baseSha: string | undefined) => {
  const changed = changedLines(identity, run, branchPoint(identity, run, baseSha), false);
  return changed && linesOf(changed, authored);
};

export type DiffSize = { production: number; tests: number; docs: number };

export function diffSize(identity: ProofIdentity, run: Run, { baseSha, from }: { baseSha?: string; from?: string }): DiffSize | undefined {
  try {
    const changed = changedLines(identity, run, from ?? branchPoint(identity, run, baseSha), true)?.filter(({ lines }) => Number.isFinite(lines));
    return changed && { production: linesOf(changed, authored), tests: linesOf(changed, isTestFile), docs: linesOf(changed, (path) => docsFile.test(path)) };
  } catch { return undefined; }
}

export function reviewTier(identity: ProofIdentity, run: Run, body: string | undefined, baseSha?: string): ReviewTier {
  const grade = gradeOf(body);
  if (grade === "high") return { name: "panel", why: "merge-risk grade high" };
  let lines: number | undefined;
  try { lines = productionLines(identity, run, baseSha); } catch { lines = undefined; }
  const size = lines === undefined || Number.isNaN(lines) ? "size unknown" : `${lines} authored production lines`;
  const read = ["low", "none"].includes(grade) && lines !== undefined && lines < readLines;
  return { name: read ? "read" : "pair", why: `merge-risk grade ${grade}, ${size}` };
}

export function pullRequestDetails(identity: ProofIdentity, run: Run) {
  try {
    const { title, body, base, baseSha } = readPullRequest(identity, run);
    return { title, body, baseRefName: base, baseSha };
  } catch (error) {
    throw new Error(`Cannot read ${identity.repository}#${identity.pr} over GitHub's REST API (${(error as Error).message})`);
  }
}

/** The dev PR's merge time and merge commit on GitHub, over REST. */
export const devPullOf = (run: Run) => (dev: DevPr): DevPull => {
  const pull = readPullRequest({ ...dev, commit: "" }, run);
  return pull.mergedAt ? { mergedAt: pull.mergedAt, ...pull.mergeCommit ? { mergeCommit: pull.mergeCommit } : {} } : {};
};

export function baseRefs(identity: ProofIdentity, run: Run) {
  const base = pullRequestDetails(identity, run).baseRefName;
  return remotesOf(identity.repository, run).map((remote) => `refs/remotes/${remote}/${base}`);
}

export function remotesOf(repository: string, run: Run) {
  const remotes = run(["git", "remote"]).stdout.split("\n").filter(Boolean);
  return remotes.filter((remote) => new RegExp(`github\\.com[:/]${repository.replace(/\./g, "\\.")}(\\.git)?/?$`, "i").test(run(["git", "remote", "get-url", remote]).stdout.trim()));
}

export function cleanBaseMerge(identity: ProofIdentity, run: Run): CleanBaseMerge {
  let bases: string[] | undefined;
  return (commit) => {
    const parents = run(["git", "rev-list", "--parents", "-n", "1", commit]);
    const [, reviewedSide, baseSide, ...more] = parents.code === 0 ? parents.stdout.trim().split(" ") : [];
    if (!reviewedSide || !baseSide || more.length) return undefined;
    bases ??= baseRefs(identity, run);
    if (!bases.some((ref) => run(["git", "merge-base", "--is-ancestor", baseSide, ref]).code === 0)) return undefined;
    const remerge = run(["git", "show", "--remerge-diff", "--format=", "--no-relative", "--no-ext-diff", "--no-textconv", commit]);
    return remerge.code === 0 && !remerge.stdout.trim() ? reviewedSide : undefined;
  };
}
