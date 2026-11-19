import type { Provider } from "../../pack/types.ts";
import { get, samePath, type Document } from "./fields.ts";

export const proxyUrl = "http://127.0.0.1:8317";
export const keyHelper = 'cat "$HOME/.config/hedge/cli-proxy.key"';
export const codexProvider = "hedge-proxy";
export const codexProviderTable = { name: "Hedge CLI proxy", base_url: `${proxyUrl}/v1`, wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", keyHelper] } };

type Route = { agent: string; fields: Array<{ path: string[]; value: unknown }>; beside(document: Document, leaving: string[][]): string[][] };

const baseUrl = ["env", "ANTHROPIC_BASE_URL"];
const codexTable = ["model_providers", codexProvider];
const claudeCredentials = [["apiKeyHelper"], ["env", "ANTHROPIC_AUTH_TOKEN"], ["env", "ANTHROPIC_API_KEY"]];
const leaves = (leaving: string[][], path: string[]) => leaving.some((item) => samePath(item, path));

export const proxyRoute: Partial<Record<Provider, Route>> = {
  claude: {
    agent: "Claude Code",
    fields: [{ path: baseUrl, value: proxyUrl }, { path: ["apiKeyHelper"], value: keyHelper }],
    beside: (document, leaving) => (leaves(leaving, baseUrl) ? claudeCredentials.filter((path) => get(document, path) !== undefined) : []),
  },
  codex: {
    agent: "Codex",
    fields: [{ path: ["model_provider"], value: codexProvider }, { path: codexTable, value: codexProviderTable }],
    beside: (document, leaving) => (leaves(leaving, codexTable) && get(document, ["model_provider"]) === codexProvider ? [["model_provider"]] : []),
  },
};
