import { blocking, type Hook, runHook } from "../lib/hook.ts";
import { modelSelection } from "../lib/model-selection.ts";

export const reminder = "Name a model on this Agent call: an omitted model inherits the parent model. Agent takes haiku, sonnet, opus, or fable; a row with a GPT model runs on Codex, through T3's `delegate_task`.";
export const pointer = "Cast it with the model table in ~/.agents/AGENTS.md.";

type ToolEvent = { tool_name?: string; tool_input?: { model?: unknown } | null };

export function check(provider: string, event: ToolEvent, table?: string): string | undefined {
  if (provider !== "claude" || !/^(Agent|Task)$/.test(event.tool_name ?? "")) return undefined;
  if (event.tool_input?.model) return undefined;
  return table ? `${reminder}\n\n${table}` : `${reminder} ${pointer}`;
}

export const hook: Hook = async (provider, readInput, home) => {
  let event: ToolEvent;
  try {
    event = JSON.parse(await readInput()) as ToolEvent;
  } catch {
    return blocking(undefined);
  }
  return blocking(check(provider, event, provider === "claude" ? modelSelection(home) : undefined));
};

if (import.meta.main) await runHook(hook);
