import { existsSync, statSync, utimesSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writePrivateFile, type Fetch } from "../../mcp-gateway/lib/client.ts";

export const upstreamCatalogs = [
  "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/codex_client_models.json",
  "https://models.router-for.me/codex_client_models.json",
];
export const upstreamRegistries = [
  "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json",
  "https://models.router-for.me/models.json",
];
export const ultrafastModels = ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6-astra"];
export const earlyModels: Record<string, { from: string; name: string; plans: string[] }> = {
  "gpt-6.2-sol": { from: "gpt-6.1-sol", name: "GPT-6.2-Sol", plans: ["codex-pro"] },
  "gpt-6.2-astra": { from: "gpt-6-astra", name: "GPT-6.2-Astra", plans: ["codex-pro"] },
};
const ultrafast = { id: "ultrafast", name: "Ultrafast", description: "Even faster, more expensive" };
const refreshEvery = 3 * 3_600_000;

type Model = Record<string, unknown>;
type Catalog = Record<string, unknown> & { models: Model[] };
type Registry = Record<string, unknown>;
type Early = [string, { from: string; name: string }][];
export type CatalogRefresh = { path: string; registryPath?: string; fetch: Fetch; now(): number; log(line: string): void; force?: boolean };

const withEarly = (models: Model[], key: string, early: Early, displayName: (name: string) => string) =>
  models.flatMap((model): Model[] => [...early.filter(([, { from }]) => from === model[key]).map(([id, { name }]) => ({ ...model, [key]: id, display_name: displayName(name) })), model]);

export function servedCatalog(raw: unknown): Catalog {
  const catalog = raw as Partial<Catalog> | null;
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) throw new Error("the catalog lists no models");
  const listed = new Set(catalog.models.map((model) => String(model.slug)));
  const early = Object.entries(earlyModels).filter(([slug, { from }]) => !listed.has(slug) && listed.has(from));
  const models = withEarly(catalog.models, "slug", early, (name) => name).map((model) => {
    if (!ultrafastModels.includes(String(model.slug))) return model;
    const tiers = Array.isArray(model.service_tiers) ? (model.service_tiers as Array<{ id?: unknown }>) : [];
    return tiers.some((tier) => tier.id === ultrafast.id) ? model : { ...model, service_tiers: [...tiers, ultrafast] };
  });
  return { ...catalog, models };
}

export function servedRegistry(raw: unknown): Registry {
  const registry = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Registry) : undefined;
  const plans = registry ? Object.keys(registry).filter((key) => key.startsWith("codex-") && Array.isArray(registry[key])) : [];
  if (!registry || plans.length === 0) throw new Error("the registry lists no Codex plans");
  const served: Registry = { ...registry };
  for (const plan of plans) {
    const models = registry[plan] as Model[];
    const listed = new Set(models.map((model) => String(model.id)));
    const early = Object.entries(earlyModels).filter(([id, model]) => model.plans.includes(plan) && !listed.has(id) && listed.has(model.from));
    served[plan] = withEarly(models, "id", early, (name) => name.replace(/-/g, " "));
  }
  return served;
}

export async function refreshCodexCatalog(refresh: CatalogRefresh): Promise<boolean> {
  const catalog = await refreshFile(refresh, refresh.path, upstreamCatalogs, servedCatalog, "Codex catalog");
  const registry = refresh.registryPath ? await refreshFile(refresh, refresh.registryPath, upstreamRegistries, servedRegistry, "Model registry") : false;
  return catalog || registry;
}

async function refreshFile(refresh: CatalogRefresh, path: string, urls: string[], serve: (raw: unknown) => unknown, label: string): Promise<boolean> {
  const { now, log } = refresh;
  if (!refresh.force && existsSync(path) && now() - statSync(path).mtimeMs < refreshEvery) return false;
  for (const url of urls) {
    let text: string;
    try {
      const response = await refresh.fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = `${JSON.stringify(serve(await response.json()), null, 2)}\n`;
    } catch (error) {
      log(`${label}: ${url}: ${(error as Error).message ?? error}`);
      continue;
    }
    const before = await readFile(path, "utf8").catch(() => undefined);
    if (before === text) {
      utimesSync(path, new Date(now()), new Date(now()));
      return false;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writePrivateFile(path, text);
    log(`${label}: wrote ${path} from ${url}`);
    return true;
  }
  log(`${label}: every source failed, so ${existsSync(path) ? "the proxy keeps the last catalog" : "the proxy serves its built-in catalog"}`);
  return false;
}
