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
  const [sol, luna] = JSON.parse(readFileSync(path, "utf8")).models;
  expect(sol.service_tiers.map((tier: { id: string }) => tier.id)).toEqual(["priority", "ultrafast"]);
  expect(luna.service_tiers).toEqual([priority]);
});

test("a catalog younger than 3 hours is not fetched again unless forced", async () => {
  const path = join(temp.make("codex-catalog-"), "codex-catalog.json");
  writeFileSync(path, "fresh\n");
  let fetched = 0;
  const counted = (async () => (fetched++, new Response("{}"))) as unknown as typeof fetch;
  expect(await refreshCodexCatalog({ path, fetch: counted, now: Date.now, log: () => {} })).toBe(false);
  expect(fetched).toBe(0);
});
