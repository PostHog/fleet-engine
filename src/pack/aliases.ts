import type { PackManifest, Preset } from "./types.ts";

export type PackAliases = Map<string, { pack: string; workflows: string[] }>;

export function packAliases(manifests: Array<Pick<PackManifest, "name" | "aliases">>): PackAliases {
  const names = new Set(manifests.map((manifest) => manifest.name));
  const aliases: PackAliases = new Map();
  for (const manifest of manifests) {
    for (const alias of manifest.aliases ?? []) {
      if (names.has(alias.name)) throw new Error(`pack ${manifest.name} takes the old name ${alias.name}, which another pack still has`);
      const other = aliases.get(alias.name);
      if (other) throw new Error(`packs ${other.pack} and ${manifest.name} both take the old name ${alias.name}`);
      aliases.set(alias.name, { pack: manifest.name, workflows: alias.workflows });
    }
  }
  return aliases;
}

export const packNamed = (aliases: PackAliases, name: string) => aliases.get(name)?.pack ?? name;

export const packsNamed = (aliases: PackAliases, names: string[]) => [...new Set(names.map((name) => packNamed(aliases, name)))];

export function oldNameOnly(aliases: PackAliases, listed: string[]): Map<string, Set<string>> {
  const own = new Set(listed.filter((name) => !aliases.has(name)));
  const only = new Map<string, Set<string>>();
  for (const name of listed) {
    const alias = aliases.get(name);
    if (!alias || own.has(alias.pack)) continue;
    only.set(alias.pack, new Set([...(only.get(alias.pack) ?? []), ...alias.workflows]));
  }
  return only;
}

export function namedPresets(presets: Preset[], manifests: Array<Pick<PackManifest, "name" | "aliases">>): Preset[] {
  const aliases = packAliases(manifests);
  return presets.map((preset) => ({ ...preset, packs: packsNamed(aliases, preset.packs), ...(preset.hubPacks ? { hubPacks: packsNamed(aliases, preset.hubPacks) } : {}) }));
}
