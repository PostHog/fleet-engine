import type { SourceRef } from "../pack/types.ts";

export const engineRepo = "PostHog/hedge";

export const ownDevboxPacks = ["posthog"];

export const needsHubPacks = ["hub", "mcp-gateway", "security"];

export const makesOwnDevbox = (packs: string[]) => packs.some((pack) => ownDevboxPacks.includes(pack));

export const defaultSources: SourceRef[] = [
  { name: "agent-skills", repo: "Silthus/agent-skills", ref: "c9bf56ec28ef3f3b5aae9ff30b161e2dab7d4c48" },
  { name: "mattpocock-skills", repo: "mattpocock/skills", ref: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" },
];

const retiredDefaultRefs: Record<string, string[]> = {
  "agent-skills": ["997eb88e03cb322941f387ab577207335d77c414"],
};

export const followCurrentDefaults = (sources: SourceRef[]) =>
  sources.map((source) => {
    const current = defaultSources.find((item) => item.name === source.name && item.repo === source.repo);
    return current && retiredDefaultRefs[source.name]?.includes(source.ref) ? { ...source, ref: current.ref } : source;
  });
