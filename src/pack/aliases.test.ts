import { describe, expect, test } from "bun:test";
import { namedPresets, oldNameOnly, packAliases, packsNamed } from "./aliases.ts";

const hub = { name: "hub", aliases: [{ name: "recovery", workflows: ["provider-recovery"] }] };
const memory = { name: "memory", aliases: [{ name: "context-library", workflows: ["context-library"] }] };

describe("old pack names", () => {
  test("map to the pack that took them, once each, and leave other names alone", () => {
    const aliases = packAliases([hub, memory, { name: "slack" }]);
    expect(packsNamed(aliases, ["recovery", "slack", "hub", "context-library", "nope"])).toEqual(["hub", "slack", "memory", "nope"]);
  });

  test("turn on only their own workflows while the profile names the pack only by its old name", () => {
    const aliases = packAliases([hub, memory]);
    expect(oldNameOnly(aliases, ["recovery", "context-library", "memory"])).toEqual(new Map([["hub", new Set(["provider-recovery"])]]));
  });

  test("reach presets too", () => {
    expect(namedPresets([{ id: "old", name: "Old", blurb: "", packs: ["context-library"], hubPacks: ["recovery"], workflows: {} }], [hub, memory])).toMatchObject([{ packs: ["memory"], hubPacks: ["hub"] }]);
  });

  test("refuse an old name that a pack still has, or that two packs take", () => {
    expect(() => packAliases([hub, { name: "recovery" }])).toThrow("pack hub takes the old name recovery, which another pack still has");
    expect(() => packAliases([hub, { name: "boxes", aliases: [{ name: "recovery", workflows: [] }] }])).toThrow("packs hub and boxes both take the old name recovery");
  });
});
