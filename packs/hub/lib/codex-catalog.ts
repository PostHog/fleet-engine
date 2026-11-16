import { existsSync, statSync, utimesSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writePrivateFile, type Fetch } from "../../mcp-gateway/lib/client.ts";

export const upstreamCatalogs = [
  "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/codex_client_models.json",
  "https://models.router-for.me/codex_client_models.json",
];
export const ultrafastModels = ["gpt-6.1-sol", "gpt-6-astra"];
const ultrafast = { id: "ultrafast", name: "Ultrafast", description: "Even faster, more expensive" };
const refreshEvery = 3 * 3_600_000;

type Model = Record<string, unknown>;
type Catalog = Record<string, unknown> & { models: Model[] };
export type CatalogRefresh = { path: string; fetch: Fetch; now(): number; log(line: string): void; force?: boolean };

export function withUltrafast(raw: unknown): Catalog {
  const catalog = raw as Partial<Catalog> | null;
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) throw new Error("the catalog lists no models");
  const models = catalog.models.map((model) => {
    if (!ultrafastModels.includes(String(model.slug))) return model;
    const tiers = Array.isArray(model.service_tiers) ? (model.service_tiers as Array<{ id?: unknown }>) : [];
    return tiers.some((tier) => tier.id === ultrafast.id) ? model : { ...model, service_tiers: [...tiers, ultrafast] };
  });
  return { ...catalog, models };
}

export async function refreshCodexCatalog(refresh: CatalogRefresh): Promise<boolean> {
  const { path, now, log } = refresh;
  if (!refresh.force && existsSync(path) && now() - statSync(path).mtimeMs < refreshEvery) return false;
  for (const url of upstreamCatalogs) {
    let text: string;
    try {
      const response = await refresh.fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = `${JSON.stringify(withUltrafast(await response.json()), null, 2)}\n`;
    } catch (error) {
      log(`Codex catalog: ${url}: ${(error as Error).message ?? error}`);
      continue;
    }
    const before = await readFile(path, "utf8").catch(() => undefined);
    if (before === text) {
      utimesSync(path, new Date(now()), new Date(now()));
      return false;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writePrivateFile(path, text);
    log(`Codex catalog: wrote ${path} from ${url}`);
    return true;
  }
  log(`Codex catalog: every source failed, so ${existsSync(path) ? "the proxy keeps the last catalog" : "the proxy serves its built-in catalog"}`);
  return false;
}
