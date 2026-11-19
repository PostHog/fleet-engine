import { readPullRequest, type Run } from "./pr-ci.ts";
import { reviewedDiff } from "./proof-review.ts";
import { commitsIn, isTestFile } from "./proof-delta.ts";
import { riskCalloutOf } from "./decision-ledger.ts";
import type { CleanBaseMerge, DevPr, DevPull, ProofIdentity } from "./proof.ts";

const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

export function topLevel(run: Run) {
  const result = run(["git", "rev-parse", "--show-toplevel"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export function mergeBase(identity: ProofIdentity, run: Run, baseSha = pullRequestDetails(identity, run).baseSha) {
  const where = `Cannot find where ${identity.repository}#${identity.pr} branched from its base`;
  if (!baseSha) throw new Error(`${where}: GitHub names no base commit of the PR. Run the command again once GitHub answers`);
  const remotes = remotesOf(identity.repository, run);
  const { present, fetched } = commitsIn(run, () => remotes);
  const fetch = remotes.length ? "Run git fetch" : `No remote of this checkout points at ${identity.repository}. Run the command in a checkout of ${identity.repository}, or add one here: git remote add hedge-base https://github.com/${identity.repository}.git && git fetch`;
  const remote = remotes[0] ?? "hedge-base";
  if (!present(identity.commit)) throw new Error(`${where}: ${short(identity.commit)} is not in this checkout. ${fetch} ${remote} pull/${identity.pr}/head`);
  if (!fetched(baseSha)) throw new Error(`${where}: the checkout lacks the PR's base ${short(baseSha)}. ${fetch} ${remote} ${baseSha}`);
  const result = run(["git", "merge-base", baseSha, identity.commit]);
  if (result.code === 0) return result.stdout.trim();
  throw new Error(`${where}: ${short(identity.commit)} shares no history with the PR's base ${short(baseSha)}`);
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

function productionLines(identity: ProofIdentity, run: Run) {
  const stat = run(["git", "diff", "--numstat", "-z", "--no-renames", "--no-relative", mergeBase(identity, run), identity.commit]);
  if (stat.code !== 0) return undefined;
  return stat.stdout.split("\0").filter(Boolean).map((entry) => {
    const [added = "", deleted = "", ...path] = entry.split("\t");
    // Git prints "-" for a binary file; its size is unknown, so it never counts as small.
    const binary = added === "-" || deleted === "-";
    return { lines: binary ? Number.POSITIVE_INFINITY : (Number(added) || 0) + (Number(deleted) || 0), path: path.join("\t") };
  }).filter(({ path }) => authored(path)).reduce((sum, { lines }) => sum + lines, 0);
}

export function reviewTier(identity: ProofIdentity, run: Run, body: string | undefined): ReviewTier {
  const grade = gradeOf(body);
  if (grade === "high") return { name: "panel", why: "merge-risk grade high" };
  let lines: number | undefined;
  try { lines = productionLines(identity, run); } catch { lines = undefined; }
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
