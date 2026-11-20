import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Run } from "./pr-ci.ts";
import { measureGrowth, oneLine } from "./proof-end-table.ts";
import { guardField } from "./proof-receipt.ts";
import { pullRequestDirectory, readJson, writeJson, type ProofIdentity } from "./proof.ts";

export const sanityVerdicts = ["cut", "justified"] as const;
export type SanityPass = { commit: string; verdict: (typeof sanityVerdicts)[number]; reason: string; production: number; recordedAt: string };

const sanityDirectory = (home: string, identity: ProofIdentity) => join(pullRequestDirectory(home, identity), "sanity");

export async function readSanity(home: string, identity: ProofIdentity): Promise<SanityPass[]> {
  const directory = sanityDirectory(home, identity);
  const names = await readdir(directory).catch(() => [] as string[]);
  const passes = await Promise.all(names.filter((name) => /^[0-9a-f]{40}\.json$/.test(name)).map((name) => readJson<SanityPass | undefined>(join(directory, name), undefined)));
  return passes.filter((pass): pass is SanityPass => pass !== undefined).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}


export async function recordSanity(home: string, head: ProofIdentity, run: Run, verdict: string, reason: string, now: Date) {
  if (!(sanityVerdicts as readonly string[]).includes(verdict)) throw new Error(`--verdict must be ${sanityVerdicts.join(" or ")}`);
  if (!reason.trim()) throw new Error("--reason needs why the PR was cut or why its growth is needed");
  guardField("sanity reason", oneLine(reason));
  const production = (await measureGrowth(home, head, run))?.final?.production;
  if (production === undefined) throw new Error("Hedge cannot count the production lines at HEAD here. Run it in the PR's checkout after its first finished review round");
  const pass: SanityPass = { commit: head.commit, verdict: verdict as SanityPass["verdict"], reason, production, recordedAt: now.toISOString() };
  await mkdir(sanityDirectory(home, head), { recursive: true, mode: 0o700 });
  await writeJson(join(sanityDirectory(home, head), `${head.commit}.json`), pass);
  return pass;
}

export async function requireSanity(home: string, head: ProofIdentity, run: Run) {
  const growth = await measureGrowth(home, head, run);
  const [first, final] = [growth?.first?.production, growth?.final?.production];
  if (!first || final === undefined || final <= 2 * first) return;
  if (((await readSanity(home, head)).at(-1)?.production ?? -1) >= final) return;
  throw new Error(`Production lines grew from ${first} at round 1 to ${final} at HEAD, past twice the first. Before another round, cut the PR back to base behaviour, or justify the growth: hedge proof sanity --verdict cut|justified --reason '<why>'`);
}
