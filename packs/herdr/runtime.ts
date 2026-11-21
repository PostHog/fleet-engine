import type { AgentRuntime } from "../../src/sdk/runtime.ts";
import { herdrAdapter } from "./lib/adapter.ts";
import { herdrOnboarding } from "./lib/onboarding.ts";
import { herdrThreads } from "./lib/threads.ts";

export const herdrThreadVariable = "HC_TERMINAL_ID";

export default {
  name: "herdr",
  title: "Herdr",
  capabilities: { machines: true, prLinks: false, transcript: false },
  threads: ({ home, models }) => herdrThreads(models, { home }),
  threadVariable: herdrThreadVariable,
  adapter: () => herdrAdapter(),
  onboarding: herdrOnboarding,
} satisfies AgentRuntime;
