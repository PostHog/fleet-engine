export const sizes = ["none", "one-off", "issue", "map"] as const;
export const firstSteps = ["research", "prototype", "architecture"] as const;

export type Size = (typeof sizes)[number];
export type FirstStep = (typeof firstSteps)[number];

export type Sample = {
  id: string;
  text: string;
  size: Size;
  steps?: FirstStep[];
  before?: Size;
  then?: string;
};

export type Verdict = { size: Size; steps: FirstStep[] } | undefined;

export type Run = { sample: Sample; verdicts: Verdict[]; inputTokens: number };

const verdictLine = new RegExp(`Build:\\s*\`?(${sizes.join("|")})\`?((?:\\s*\\+\\s*\`?(?:${firstSteps.join("|")})\`?)*)`, "i");

export function parseVerdict(reply: string): Verdict {
  const match = reply.match(verdictLine);
  if (!match) return undefined;
  const size = match[1]!.toLowerCase() as Size;
  const steps = firstSteps.filter((step) => new RegExp(`\\b${step}\\b`, "i").test(match[2] ?? ""));
  return { size, steps };
}

const sameSteps = (verdict: Verdict, sample: Sample) => {
  const want = [...(sample.steps ?? [])].sort().join(",");
  return verdict !== undefined && [...verdict.steps].sort().join(",") === want;
};

export const sizeHit = (verdict: Verdict, sample: Sample) => verdict?.size === sample.size;

export const isRegrade = (sample: Sample) => sample.then !== undefined;

export type JudgeSummary = {
  verdicts: number;
  sizeHits: number;
  stepHits: number;
  noneFalseBuilds: number;
  noneSamples: number;
  buildsJudgedNone: number;
  buildSamples: number;
  regradeHits: number;
  regradeVerdicts: number;
  stable: number;
  samples: number;
  meanInputTokens: number;
};

const ratio = (part: number, whole: number) => (whole === 0 ? "n/a" : `${part}/${whole} (${Math.round((100 * part) / whole)}%)`);

export function summarizeJudge(runs: Run[]): JudgeSummary {
  const all = runs.flatMap((run) => run.verdicts.map((verdict) => ({ sample: run.sample, verdict })));
  const none = all.filter(({ sample }) => sample.size === "none");
  const builds = all.filter(({ sample }) => sample.size !== "none" && !isRegrade(sample));
  const regrades = all.filter(({ sample }) => isRegrade(sample));
  const stable = runs.filter((run) => new Set(run.verdicts.map((verdict) => verdict?.size ?? "?")).size === 1).length;
  return {
    verdicts: all.length,
    sizeHits: all.filter(({ sample, verdict }) => sizeHit(verdict, sample)).length,
    stepHits: all.filter(({ sample, verdict }) => sizeHit(verdict, sample) && sameSteps(verdict, sample)).length,
    noneFalseBuilds: none.filter(({ verdict }) => verdict?.size !== "none").length,
    noneSamples: none.length,
    buildsJudgedNone: builds.filter(({ verdict }) => verdict?.size === "none").length,
    buildSamples: builds.length,
    regradeHits: regrades.filter(({ sample, verdict }) => sizeHit(verdict, sample)).length,
    regradeVerdicts: regrades.length,
    stable,
    samples: runs.length,
    meanInputTokens: Math.round(runs.reduce((sum, run) => sum + run.inputTokens, 0) / Math.max(1, runs.length)),
  };
}

export function renderJudgeSummary(name: string, summary: JudgeSummary) {
  return [
    `== ${name}`,
    `size right            ${ratio(summary.sizeHits, summary.verdicts)}`,
    `size and first steps  ${ratio(summary.stepHits, summary.verdicts)}`,
    `questions built       ${ratio(summary.noneFalseBuilds, summary.noneSamples)}`,
    `builds judged none    ${ratio(summary.buildsJudgedNone, summary.buildSamples)}`,
    `judge again right     ${ratio(summary.regradeHits, summary.regradeVerdicts)}`,
    `same size every rep   ${ratio(summary.stable, summary.samples)}`,
    `input tokens per call ${summary.meanInputTokens}`,
  ].join("\n");
}

export const showVerdict = (verdict: Verdict) => (verdict ? [verdict.size, ...verdict.steps].join("+") : "?");

export const showExpected = (sample: Sample) => [sample.size, ...(sample.steps ?? [])].join("+");

export type TriggerRun = { sample: Sample; skill: string | undefined; costUsd: number };

export type TriggerSummary = { buildFires: number; buildSamples: number; noneFires: number; noneSamples: number; otherSkills: Record<string, number>; costUsd: number };

export function summarizeTrigger(runs: TriggerRun[], entry: string): TriggerSummary {
  const builds = runs.filter((run) => run.sample.size !== "none" && !isRegrade(run.sample));
  const none = runs.filter((run) => run.sample.size === "none");
  const otherSkills: Record<string, number> = {};
  for (const run of builds) if (run.skill && run.skill !== entry) otherSkills[run.skill] = (otherSkills[run.skill] ?? 0) + 1;
  return {
    buildFires: builds.filter((run) => run.skill === entry).length,
    buildSamples: builds.length,
    noneFires: none.filter((run) => run.skill === entry).length,
    noneSamples: none.length,
    otherSkills,
    costUsd: runs.reduce((sum, run) => sum + run.costUsd, 0),
  };
}

export function renderTriggerSummary(name: string, entry: string, summary: TriggerSummary) {
  const others = Object.entries(summary.otherSkills).sort((a, b) => b[1] - a[1]).map(([skill, count]) => `${skill} ${count}`).join(", ");
  return [
    `== ${name}`,
    `builds that loaded ${entry.padEnd(24)} ${ratio(summary.buildFires, summary.buildSamples)}`,
    `questions that loaded ${entry.padEnd(21)} ${ratio(summary.noneFires, summary.noneSamples)}`,
    `builds that loaded another skill first      ${others || "none"}`,
    `cost                                        $${summary.costUsd.toFixed(3)}`,
  ].join("\n");
}

export const ratioText = ratio;
