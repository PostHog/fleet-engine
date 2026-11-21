import type { ModelRow } from "../../../src/pack/types.ts";

export const templatesDir = ".config/herdr-core/templates";
export const templatePrefix = "hedge-";

export const templateName = (role: string) => `${templatePrefix}${role}`;
export const templateTarget = (role: string) => `${templatesDir}/${templateName(role)}.md`;

const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

export function agentCommand(row: ModelRow): string {
  if (row.provider === "claude") return ["claude", "--model", row.model, "--effort", row.effort].map(quoted).join(" ");
  const tier = row.serviceTier ? ["-c", `service_tier="${row.serviceTier}"`] : [];
  return ["codex", "--no-daemon", "-m", row.model, "-c", `model_reasoning_effort="${row.effort}"`, ...tier].map(quoted).join(" ");
}

export function renderTemplate(row: ModelRow): string {
  return [
    "---",
    `description: Hedge ${row.role}: ${row.work.replaceAll("\n", " ")}`,
    `command: ${agentCommand(row)}`,
    "---",
    `Hedge started this ${row.role} thread on ${row.model}. Your task follows.`,
    "",
  ].join("\n");
}

export function wantedTemplates(models: ModelRow[]): Map<string, string> {
  return new Map(models.map((row) => [templateTarget(row.role), renderTemplate(row)]));
}
