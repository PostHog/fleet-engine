import { lazyThreads } from "../../src/runtime/load.ts";
import type { AgentRuntime } from "../../src/sdk/runtime.ts";
import { t3Adapter } from "./lib/adapter/adapter.ts";
import { t3Onboarding } from "./lib/onboarding/onboarding.ts";

export const t3ThreadVariable = "T3CODE_THREAD_ID";

export default {
  name: "t3",
  title: "T3 Code",
  capabilities: { machines: true, prLinks: true, transcript: true },
  threads: ({ home, models }) => lazyThreads(async () => (await import("./lib/runtime-threads.ts")).t3RuntimeThreads(models, { home })),
  threadVariable: t3ThreadVariable,
  adapter: () => t3Adapter(),
  onboarding: t3Onboarding,
} satisfies AgentRuntime;
