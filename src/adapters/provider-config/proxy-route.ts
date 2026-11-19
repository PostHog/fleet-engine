import type { Provider } from "../../pack/types.ts";
import { get, type Document } from "./fields.ts";

export const proxyUrl = "http://127.0.0.1:8317";
export const keyHelper = 'cat "$HOME/.config/hedge/cli-proxy.key"';
export const codexProvider = "hedge-proxy";
export const codexProviderTable = { name: "Hedge CLI proxy", base_url: `${proxyUrl}/v1`, wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", keyHelper] } };

type Stranded = { path: string; harm: string };
type Route = { paths: string[][]; strands(document: Document): Stranded | undefined };

const claudeCredentials = [["apiKeyHelper"], ["env", "ANTHROPIC_AUTH_TOKEN"], ["env", "ANTHROPIC_API_KEY"]];

export const proxyRoute: Partial<Record<Provider, Route>> = {
  claude: {
    paths: [["env", "ANTHROPIC_BASE_URL"], ["apiKeyHelper"]],
    strands(document) {
      if (get(document, ["env", "ANTHROPIC_BASE_URL"]) !== undefined) return undefined;
      const path = claudeCredentials.find((item) => get(document, item) !== undefined)?.join(".");
      return path ? { path, harm: `Claude Code would send ${path === "apiKeyHelper" ? "the key your apiKeyHelper prints" : `your ${path}`} to Anthropic` } : undefined;
    },
  },
  codex: {
    paths: [["model_provider"], ["model_providers", codexProvider]],
    strands: (document) => (get(document, ["model_provider"]) === codexProvider && get(document, ["model_providers", codexProvider]) === undefined ? { path: "model_provider", harm: `Codex would select a ${codexProvider} provider table that is gone` } : undefined),
  },
};
