import type { Provider } from "../../pack/types.ts";

export const proxyUrl = "http://127.0.0.1:8317";
export const keyHelper = 'cat "$HOME/.config/hedge/cli-proxy.key"';
export const codexProvider = "hedge-proxy";
export const codexProviderTable = { name: "Hedge CLI proxy", base_url: `${proxyUrl}/v1`, wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", keyHelper] } };

export const proxyRoute: Partial<Record<Provider, Array<{ path: string[]; value: unknown }>>> = {
  claude: [
    { path: ["env", "ANTHROPIC_BASE_URL"], value: proxyUrl },
    { path: ["apiKeyHelper"], value: keyHelper },
  ],
  codex: [
    { path: ["model_provider"], value: codexProvider },
    { path: ["model_providers", codexProvider], value: codexProviderTable },
  ],
};
