type Run = (command: string[]) => { code: number; stdout: string; stderr: string };

const testFiles = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go)$/,
  /(^|\/)__snapshots__\/[^/]+\.snap$/,
];
export const isTestFile = (path: string) => testFiles.some((pattern) => pattern.test(path));

export type ReviewedHead = { commit: string; baseSha?: string };
export type Merged = { reviewed: string; base: string; conflicts: string[] };
export type NetDelta = { tree: string; files: string[]; merged: Merged; unrecordedBase?: true } | { unread: string };

const short = (commit: string) => commit.slice(0, 7);
export const fullRead = "Read the whole PR again with hedge proof review --scope full and --agent '<your reason>'";

export function mergedTree(run: Run, reviewed: string, base: string) {
  const merged = run(["git", "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", reviewed, base]);
  const [tree = "", ...conflicts] = merged.code <= 1 ? merged.stdout.split("\0") : [];
  return /^[0-9a-f]{40,64}$/.test(tree) ? { tree, conflicts: [...new Set(conflicts.filter(Boolean))] } : undefined;
}

export function commitsIn(run: Run, remotes: () => string[]) {
  const present = (commit: string) => run(["git", "cat-file", "-e", `${commit}^{commit}`]).code === 0;
  const fetched = new Map<string, boolean>();
  return {
    present,
    fetched: (commit: string) => {
      if (!fetched.has(commit)) {
        if (!present(commit)) for (const remote of remotes()) if (run(["git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, commit]).code === 0) break;
        fetched.set(commit, present(commit));
      }
      return fetched.get(commit)!;
    },
  };
}

export function netDeltaIn(run: Run, remotes: () => string[]) {
  const { present, fetched } = commitsIn(run, remotes);
  const holds = (ancestor: string, commit: string) => run(["git", "merge-base", "--is-ancestor", ancestor, commit]).code === 0;
  const fetch = (commit: string) => `Fetch it with git fetch ${remotes()[0] ?? "origin"} ${commit}`;
  return (reviewed: ReviewedHead, head: string, base: string | undefined): NetDelta => {
    const missing = [reviewed.commit, head].find((commit) => !present(commit));
    if (missing) return { unread: `the checkout lacks ${short(missing)}, so nothing carries. ${fetch(missing)}` };
    if (!base) return { unread: "GitHub names no base commit of the PR, so nothing carries. Run the command again once GitHub answers" };
    if (!fetched(base)) return { unread: `the checkout lacks the PR's base ${short(base)} and cannot fetch it, so nothing carries. ${fetch(base)}` };
    if (reviewed.baseSha && (!present(reviewed.baseSha) || !holds(reviewed.baseSha, base))) return { unread: `the PR's base on GitHub no longer holds ${short(reviewed.baseSha)}, the base that review stood on, so nothing carries. ${fullRead}` };
    const contained = run(["git", "merge-base", head, base]);
    if (contained.code !== 0) return { unread: `HEAD shares no history with the PR's base ${short(base)}, so nothing carries. ${fullRead}` };
    const merged = mergedTree(run, reviewed.commit, contained.stdout.trim());
    if (!merged) return { unread: `git cannot merge ${short(reviewed.commit)} with the base here, so nothing carries. ${fullRead}` };
    const changed = run(["git", "diff", "--name-only", "-z", "--no-renames", "--no-relative", "--no-ext-diff", "--ignore-submodules=none", merged.tree, head]);
    if (changed.code !== 0) return { unread: `git cannot diff the merged tree of ${short(reviewed.commit)} against HEAD here, so nothing carries. ${fullRead}` };
    const files = [...new Set([...merged.conflicts, ...changed.stdout.split("\0")].filter(Boolean))].sort();
    return { tree: merged.tree, files, merged: { reviewed: reviewed.commit, base: contained.stdout.trim(), conflicts: merged.conflicts }, ...reviewed.baseSha ? {} : { unrecordedBase: true as const } };
  };
}
