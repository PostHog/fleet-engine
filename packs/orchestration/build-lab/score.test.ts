import { describe, expect, test } from "bun:test";
import { parseVerdict, summarizeJudge, summarizeTrigger, type Sample } from "./score.ts";

const sample = (fields: Partial<Sample>): Sample => ({ id: "x", text: "x", size: "one-off", ...fields });

describe("the build lab", () => {
  test("reads a verdict line with its first steps, in any case and with backticks", () => {
    expect(parseVerdict("Build: `issue` + research + Prototype. Two decisions.")).toEqual({ size: "issue", steps: ["research", "prototype"] });
    expect(parseVerdict("Some thinking.\nBuild: none. A status question.")).toEqual({ size: "none", steps: [] });
    expect(parseVerdict("I would start a map.")).toBeUndefined();
  });

  test("counts a question the judge built, a build it called none, and a judge-again hit", () => {
    const summary = summarizeJudge([
      { sample: sample({ size: "none" }), verdicts: [{ size: "one-off", steps: [] }, { size: "none", steps: [] }], inputTokens: 10 },
      { sample: sample({ size: "issue", steps: ["research"] }), verdicts: [{ size: "none", steps: [] }, { size: "issue", steps: ["research"] }], inputTokens: 30 },
      { sample: sample({ size: "map", before: "issue", then: "more scope" }), verdicts: [{ size: "map", steps: [] }, undefined], inputTokens: 20 },
    ]);
    expect(summary).toMatchObject({ verdicts: 6, sizeHits: 3, stepHits: 3, noneFalseBuilds: 1, noneSamples: 2, buildsJudgedNone: 1, buildSamples: 2, regradeHits: 1, regradeVerdicts: 2, stable: 0, meanInputTokens: 20 });
  });

  test("counts which builds loaded the entry skill and which loaded another one first", () => {
    const summary = summarizeTrigger(
      [
        { sample: sample({ size: "issue" }), skill: "build", costUsd: 0.01 },
        { sample: sample({ size: "map" }), skill: "prototype", costUsd: 0.01 },
        { sample: sample({ size: "none" }), skill: "build", costUsd: 0.01 },
      ],
      "build",
    );
    expect(summary).toMatchObject({ buildFires: 1, buildSamples: 2, noneFires: 1, noneSamples: 1, otherSkills: { prototype: 1 } });
  });
});
