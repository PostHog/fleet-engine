import type { SourceRef } from "../pack/types.ts";

export const engineRepo = "PostHog/hedge";

export const ownDevboxPacks = ["posthog"];

export const needsHubPacks = ["hub", "mcp-gateway", "security"];

export const makesOwnDevbox = (packs: string[]) => packs.some((pack) => ownDevboxPacks.includes(pack));

export const defaultSources: SourceRef[] = [
  { name: "agent-skills", repo: "Silthus/agent-skills", ref: "208baa42fce1e4edb97c3725e514e264a4575ad6" },
  { name: "mattpocock-skills", repo: "mattpocock/skills", ref: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" },
];
