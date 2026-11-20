import { optionalStringSetting } from "../../base/lib/settings.ts";
import { agentRefusal, riskCalloutOf, tierOf, type AskClass, type Env, type Tier } from "./decision-ledger.ts";

export type Autonomy = "ask" | "end";
export type Grade = { tier: Tier; oneWay: boolean };

export const endTableNote = "the user reads it in the end table of hedge decision report";

export const gradeOf = (body: string | undefined): Grade =>
  body === undefined ? { tier: "ungraded", oneWay: false } : { tier: tierOf(body), oneWay: /\bone-way door\b/i.test(riskCalloutOf(body) ?? "") };

export const autonomyOf = (env: Env, { tier, oneWay }: Grade, decisionClass: AskClass, kinds?: string[]): Autonomy =>
  optionalStringSetting("pull-requests.autonomy", env) === "end" && !oneWay && !agentRefusal(tier, decisionClass, kinds) ? "end" : "ask";
