type Run = (command: string[]) => { code: number; stdout: string; stderr: string };

const testFiles = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go)$/,
  /(^|\/)__snapshots__\/[^/]+\.snap$/,
];
export const isTestFile = (path: string) => testFiles.some((pattern) => pattern.test(path));

export type NetDelta = { files: string[] } | { unread: string; recover?: string };

const short = (commit: string) => commit.slice(0, 7);

export function netDeltaIn(run: Run, remotes: () => string[]) {
  const present = (commit: string) => run(["git", "cat-file", "-e", `${commit}^{commit}`]).code === 0;
  const fetched = new Map<string, boolean>();
  const fetchedBase = (commit: string) => {
    if (!fetched.has(commit)) {
      if (!present(commit)) for (const remote of remotes()) if (run(["git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, commit]).code === 0) break;
      fetched.set(commit, present(commit));
    }
    return fetched.get(commit)!;
  };
  const fetch = (commit: string) => `Fetch it with git fetch ${remotes()[0] ?? "origin"} ${commit}`;
  return (reviewed: string, head: string, base: string | undefined): NetDelta => {
    const missing = [reviewed, head].find((commit) => !present(commit));
    if (missing) return { unread: `the checkout lacks ${short(missing)}, so nothing carries`, recover: fetch(missing) };
    if (!base) return { unread: "GitHub names no base commit of the PR, so nothing carries" };
    if (!fetchedBase(base)) return { unread: `the checkout lacks the PR's base ${short(base)} and cannot fetch it, so nothing carries`, recover: fetch(base) };
    const contained = run(["git", "merge-base", head, base]);
    if (contained.code !== 0) return { unread: `HEAD shares no history with the PR's base ${short(base)}, so nothing carries` };
    const merged = run(["git", "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", reviewed, contained.stdout.trim()]);
    const [tree = "", ...conflicts] = merged.code <= 1 ? merged.stdout.split("\0") : [];
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return { unread: `git merge-tree cannot merge ${short(reviewed)} with the base here (it needs Git 2.38 or later), so nothing carries` };
    const changed = run(["git", "diff", "--name-only", "-z", "--no-renames", "--no-relative", "--no-ext-diff", "--ignore-submodules=none", tree, head]);
    if (changed.code !== 0) return { unread: `git cannot diff the merged tree of ${short(reviewed)} against HEAD here, so nothing carries` };
    return { files: [...new Set([...conflicts, ...changed.stdout.split("\0")].filter(Boolean))].sort() };
  };
}
