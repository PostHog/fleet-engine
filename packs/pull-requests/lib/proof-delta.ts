type Run = (command: string[]) => { code: number; stdout: string; stderr: string };

const testFiles = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go)$/,
  /(^|\/)__snapshots__\/[^/]+\.snap$/,
];
export const isTestFile = (path: string) => testFiles.some((pattern) => pattern.test(path));

export type NetDelta = { tree: string; files: string[] };

export function netDeltaIn(run: Run, baseRefs: () => string[]) {
  let bases: string[] | undefined;
  return (reviewed: string, head: string): NetDelta | undefined => {
    if ([reviewed, head].some((commit) => run(["git", "cat-file", "-e", `${commit}^{commit}`]).code !== 0)) return undefined;
    bases ??= (() => { try { return baseRefs(); } catch { return []; } })();
    const base = bases.map((ref) => run(["git", "merge-base", head, ref])).find((result) => result.code === 0)?.stdout.trim();
    if (!base) return undefined;
    const merged = run(["git", "merge-tree", "--write-tree", "--no-messages", reviewed, base]);
    const tree = merged.code <= 1 ? /^[0-9a-f]{40,64}$/.exec(merged.stdout.split("\n")[0] ?? "")?.[0] : undefined;
    if (!tree) return undefined;
    const changed = run(["git", "diff", "--name-only", "-z", "--no-renames", "--no-relative", "--no-ext-diff", "--ignore-submodules=none", tree, head]);
    return changed.code === 0 ? { tree, files: changed.stdout.split("\0").filter(Boolean) } : undefined;
  };
}
