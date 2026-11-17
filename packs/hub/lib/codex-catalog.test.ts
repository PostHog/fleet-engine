import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { refreshCodexCatalog } from "./codex-catalog.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const offline = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
const priority = { id: "priority", name: "Fast", description: "" };

test("a failed or empty upstream catalog keeps the last file, and a good one gains the ultrafast tier on the models that serve it", async () => {
  const path = join(temp.make("codex-catalog-"), "codex-catalog.json");
  writeFileSync(path, "last good\n");
  const refresh = { path, now: () => 1_800_000_000_000, log: () => {}, force: true };
  for (const fetch of [answer({ models: [] }), answer({}), answer({ error: "down" }, 503), offline]) {
    expect(await refreshCodexCatalog({ ...refresh, fetch })).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("last good\n");
  }
  const upstream = { models: [{ slug: "gpt-6.1-sol", service_tiers: [priority] }, { slug: "gpt-6-luna", service_tiers: [priority] }] };
  expect(await refreshCodexCatalog({ ...refresh, fetch: answer(upstream) })).toBe(true);
  const served = JSON.parse(readFileSync(path, "utf8")).models as Array<{ slug: string; service_tiers: Array<{ id: string }> }>;
  const [sol, luna] = ["gpt-6.1-sol", "gpt-6-luna"].map((slug) => served.find((model) => model.slug === slug)!);
  expect(sol!.service_tiers.map((tier) => tier.id)).toEqual(["priority", "ultrafast"]);
  expect(luna!.service_tiers).toEqual([priority]);
});

test("a model upstream does not list yet is served as a copy of the model it succeeds, until upstream lists it", async () => {
  const path = join(temp.make("codex-catalog-"), "codex-catalog.json");
  const refresh = { path, now: () => 1_800_000_000_000, log: () => {}, force: true };
  const sol61 = { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", context_window: 500000, service_tiers: [priority] };
  await refreshCodexCatalog({ ...refresh, fetch: answer({ models: [sol61, { slug: "gpt-6-luna", service_tiers: [priority] }] }) });
  const served = JSON.parse(readFileSync(path, "utf8")).models;
  expect(served.map((model: { slug: string }) => model.slug)).toEqual(["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-luna"]);
  expect(served[0]).toMatchObject({ display_name: "GPT-6.2-Sol", context_window: 500000 });
  expect(served[0].service_tiers.map((tier: { id: string }) => tier.id)).toEqual(["priority", "ultrafast"]);

  const upstream62 = { slug: "gpt-6.2-sol", display_name: "GPT-6.2 Sol", context_window: 600000, service_tiers: [priority] };
  await refreshCodexCatalog({ ...refresh, fetch: answer({ models: [upstream62, sol61] }) });
  const later = JSON.parse(readFileSync(path, "utf8")).models;
  expect(later.map((model: { slug: string }) => model.slug)).toEqual(["gpt-6.2-sol", "gpt-6.1-sol"]);
  expect(later[0]).toMatchObject({ display_name: "GPT-6.2 Sol", context_window: 600000 });
});

test("the routing registry gets the early models in the Pro plan only, so the proxy never sends them to a seat that refuses them", async () => {
  const dir = temp.make("codex-catalog-");
  const [path, registryPath] = [join(dir, "catalog.json"), join(dir, "registry.json")];
  const sol61 = { id: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", context_length: 272000 };
  const registry = { "codex-pro": [{ id: "gpt-6-astra" }, sol61], "codex-team": [sol61], claude: [{ id: "claude-opus-5-5" }] };
  const byUrl = (body: unknown) => (async (url: string) => new Response(JSON.stringify(url.endsWith("/models.json") ? body : { models: [{ slug: "gpt-6.1-sol" }] }))) as unknown as typeof fetch;
  const refresh = { path, registryPath, now: () => 1_800_000_000_000, log: () => {}, force: true };
  expect(await refreshCodexCatalog({ ...refresh, fetch: byUrl(registry) })).toBe(true);
  const served = JSON.parse(readFileSync(registryPath, "utf8"));
  expect(served["codex-pro"].map((model: { id: string }) => model.id)).toEqual(["gpt-6.2-astra", "gpt-6-astra", "gpt-6.2-sol", "gpt-6.1-sol"]);
  expect(served["codex-pro"][2]).toEqual({ id: "gpt-6.2-sol", display_name: "GPT 6.2 Sol", context_length: 272000 });
  expect(served["codex-team"]).toEqual([sol61]);
  expect(served.claude).toEqual(registry.claude);

  const kept = readFileSync(registryPath, "utf8");
  await refreshCodexCatalog({ ...refresh, fetch: byUrl({ claude: [] }) });
  expect(readFileSync(registryPath, "utf8")).toBe(kept);
});

test("a catalog younger than 3 hours is not fetched again unless forced", async () => {
  const path = join(temp.make("codex-catalog-"), "codex-catalog.json");
  writeFileSync(path, "fresh\n");
  let fetched = 0;
  const counted = (async () => (fetched++, new Response("{}"))) as unknown as typeof fetch;
  expect(await refreshCodexCatalog({ path, fetch: counted, now: Date.now, log: () => {} })).toBe(false);
  expect(fetched).toBe(0);
});
