import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";

const root = join(import.meta.dir, "..");
const guidePath = join(root, "docs/getting-started.md");
const read = (path: string) => readFileSync(path, "utf8");

async function hedgeCommands() {
  let usage = "";
  await main(["help"], { home: "/nonexistent", engineRoot: root, platform: "linux", print: (line) => (usage += line) });
  return new Set([...usage.matchAll(/^ {2}hedge ([a-z]+)/gm)].map((match) => match[1]));
}

describe("the getting-started guide", () => {
  test("the README links it", () => {
    expect(existsSync(guidePath)).toBe(true);
    expect(read(join(root, "README.md"))).toContain("(docs/getting-started.md)");
  });

  test("walks from the install line to a linked devbox", () => {
    const guide = read(guidePath);
    expect(guide).toContain("curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh");
    expect(guide).toContain("hedge devbox add");
    expect(guide).toContain("t3 up --connect");
  });

  test("runs only hedge commands that exist", async () => {
    const known = await hedgeCommands();
    const used = [...read(guidePath).matchAll(/\bhedge ([a-z]+)\b/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((command) => !known.has(command))).toEqual([]);
  });

  test("installs the Coder CLI on the hub before the hub signs in, puts the installed commands on the shell's PATH after the install, and adds the Hub pack with the MCP gateway off", () => {
    const guide = read(guidePath);
    const blocks = [...guide.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((match) => match[1]!);
    const install = blocks.findIndex((block) => block.includes("get.sh | sh"));
    expect(blocks[install + 1]).toBe('export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"\n');
    const hub = blocks.find((block) => block.includes("hedge hub here"))!.split("\n");
    const at = (start: string) => hub.findIndex((line) => line.startsWith(start));
    expect(at("command -v coder")).toBeGreaterThanOrEqual(0);
    expect(at("command -v coder")).toBeLessThan(at("coder login"));
    expect(hub).toContain("hedge packs --add hub --workflows mcp-gateway=off");
  });
});
