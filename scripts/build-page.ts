import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { artFiles, packGroups } from "../page/cast.ts";
import type { PageData, PagePack } from "../page/model.ts";
import { site, type ArtSizes } from "../page/views.ts";
import { engineSettings, loadPacks } from "../src/pack/manifest.ts";
import type { Audience, LoadedPack, Need, PackManifest, Preset } from "../src/pack/types.ts";
import { engineRepo, needsHubPacks } from "../src/setup/defaults.ts";
import { packsNamed } from "../src/pack/aliases.ts";
import { catalogAliases, choosablePacks, defaultPreset, packTitle, type Catalog } from "../src/setup/questions.ts";

const engineRoot = join(import.meta.dir, "..");
const artDir = join(engineRoot, "page/art");

export const needPacks: Partial<Record<Need, string>> = { hub: "hub", coder: "posthog", "posthog-org": "posthog" };

const needLabels: Record<Need, string> = {
  gh: "GitHub",
  devbox: "a devbox",
  "always-on devbox": "an always-on devbox",
  hub: "the Hub pack",
  coder: "Coder",
  "posthog-org": "your team's GitHub org",
};

export type PageOptions = { audience: Audience; team?: LoadedPack[] };

export type SiteFiles = Record<string, string | Uint8Array>;

const visible = (audience: Audience) => (item: { audience?: Audience }) => !item.audience || item.audience === "public" || item.audience === audience;

export async function pageData({ audience, team = [] }: PageOptions): Promise<PageData> {
  if (audience === "public" && team.length) throw new Error("the public build lists no pack from a private source");
  const engine = await loadPacks(engineRoot);
  const presets = (await Bun.file(join(engineRoot, "presets.json")).json()) as Preset[];
  const shown = visible(audience);
  const base = engine.filter((pack) => pack.manifest.name === "base").map((pack) => pack.manifest);
  const teamManifests = team.map((pack) => pack.manifest).filter(shown);
  const manifests = [...base, ...choosablePacks({ presets, packs: engine } as Catalog), ...teamManifests].filter(shown).filter((manifest) => manifest.onSite !== false);
  const inEveryHedge = new Set(["base", ...presets.map((preset) => preset.hubPacks ?? []).reduce((left, right) => left.filter((name) => right.includes(name)))]);
  const names = new Set(manifests.map((manifest) => manifest.name));
  const aliases = catalogAliases({ packs: [...engine, ...team] });
  const loaded = new Map([...engine, ...team].map((pack) => [pack.manifest.name, pack.manifest]));
  const needed = (names: string[], found = new Set<string>()): Set<string> => {
    for (const name of packsNamed(aliases, names)) if (!found.has(name)) needed(loaded.get(name)?.requires ?? [], found.add(name));
    return found;
  };
  const holds = (need: Need) => !needPacks[need] || names.has(needPacks[need]!);
  const noteOn = (loaded: LoadedPack[], folder: string) => loaded.filter((pack) => existsSync(join(pack.dir, "SETUP.md"))).map((pack) => [pack.manifest.name, `${folder}/packs/${pack.manifest.name}/SETUP.md`]);
  const setupNotes: Record<string, string> = Object.fromEntries([...noteOn(engine, "~/.local/share/hedge/engine"), ...noteOn(team, "~/.local/share/hedge/sources/<source>")]);
  const grouped = packGroups.flatMap((group) => group.packs);
  const rank = (name: string) => (inEveryHedge.has(name) ? -1 : grouped.includes(name) ? grouped.indexOf(name) : grouped.length);
  const packs = manifests.toSorted((left, right) => rank(left.name) - rank(right.name)).map((manifest) => pagePack(manifest, holds, [...needed(manifest.requires ?? [])].filter((name) => name !== manifest.name), inEveryHedge.has(manifest.name), setupNotes[manifest.name]));
  const used = new Set(packs.flatMap((pack) => pack.workflows.flatMap((workflow) => workflow.needs)));
  const start = presets.find((preset) => preset.id === defaultPreset)!;
  const shownNames = (list: string[]) => list.filter((name) => names.has(name));
  return {
    engineRepo,
    packs,
    teamPacks: shownNames(teamManifests.map((manifest) => manifest.name)),
    startPacks: shownNames(start.packs),
    hubStartPacks: shownNames(start.hubPacks ?? []),
    needsHubPacks: shownNames(needsHubPacks),
    needLabels: Object.fromEntries(Object.entries(needLabels).filter(([need]) => used.has(need as Need))),
  };
}

function pagePack(manifest: PackManifest, holds: (need: Need) => boolean, requires: string[], always: boolean, setupNote?: string): PagePack {
  const workflows = manifest.workflows ?? [];
  const shownWorkflows = workflows.filter((workflow) => (workflow.needs ?? []).every(holds));
  const listedOnlyByHidden = (key: string) => workflows.some((workflow) => workflow.settings?.includes(key)) && !shownWorkflows.some((workflow) => workflow.settings?.includes(key));
  return {
    name: manifest.name,
    title: packTitle(manifest),
    summary: manifest.summary,
    ...(manifest.cost ? { cost: manifest.cost } : {}),
    ...(manifest.risk ? { risk: manifest.risk } : {}),
    requires: requires.filter((name) => name !== "base"),
    always,
    ...(setupNote ? { setupNote } : {}),
    workflows: shownWorkflows.map(({ id, name, sentence, needs = [], risk, ...workflow }) => ({ id, name, sentence, needs: needs.filter((need) => needPacks[need] !== manifest.name), default: workflow.default, ...(risk ? { risk } : {}) })),
    settings: (manifest.settings ?? []).filter((setting) => !engineSettings.includes(setting.key) && !listedOnlyByHidden(setting.key)),
  };
}

function pngSize(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export async function buildSite(options: PageOptions): Promise<SiteFiles> {
  const data = await pageData(options);
  const bundle = await Bun.build({ entrypoints: [join(engineRoot, "page/app.ts")], root: engineRoot, target: "browser", minify: true });
  if (!bundle.success) throw new AggregateError(bundle.logs, "the page script did not build");
  const art = await Promise.all(artFiles().map(async (file) => [file, await Bun.file(join(artDir, file)).bytes()] as const));
  const sizes: ArtSizes = Object.fromEntries(art.filter(([file]) => file.endsWith(".png")).map(([file, bytes]) => [file, pngSize(bytes)]));
  const script = await bundle.outputs[0]!.text();
  const styles = await Bun.file(join(engineRoot, "page/style.css")).text();
  const routes = site(data, sizes, { script, styles });
  const shown = art.filter(([file]) => routes.some((route) => route.html.includes(`assets/art/${file}"`)));
  return {
    ...Object.fromEntries(routes.map((route) => [route.path, route.html])),
    ...Object.fromEntries(shown.map(([file, bytes]) => [`assets/art/${file}`, bytes])),
  };
}

export async function main(args: string[]) {
  let audience: Audience = "public";
  let out = "site";
  const team: LoadedPack[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = () => args[++index] ?? fail(`${arg} needs a value`);
    if (arg === "--audience") {
      const name = value();
      if (name !== "public" && name !== "posthog") fail("--audience takes public or posthog");
      audience = name as Audience;
    } else if (arg === "--source") team.push(...(await loadPacks(resolve(value()))));
    else if (arg === "--out") out = value();
    else fail(`unknown option ${arg}. Use --audience, --source <dir>, and --out <dir>`);
  }
  if (out.endsWith(".html")) fail("--out takes a directory. The site has one HTML file for each route");
  const files = await buildSite({ audience, team });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(out, path)), { recursive: true });
    await Bun.write(join(out, path), content);
  }
  console.log(`Wrote ${Object.keys(files).length} files to ${out}`);
}

function fail(message: string): never {
  console.error(`build-page: ${message}`);
  process.exit(2);
}

if (import.meta.main) await main(Bun.argv.slice(2));
