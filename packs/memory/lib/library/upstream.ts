import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { cannotTell } from "../../../base/lib/command.ts";
import { parseUpstream, type LocalUpstream, type Upstream } from "../../../mcp-gateway/lib/apps.ts";
import { upstreamsDir } from "../../../mcp-gateway/lib/declared.ts";
import type { Library } from "./config.ts";

export const upstreamFile = (home: string) => join(upstreamsDir(home), "context.json");
export const serverScript = join(import.meta.dir, "../../mcp/main.ts");
const target = "/hedge-context";

export function contextUpstream(library: Pick<Library, "path" | "url">): LocalUpstream {
  return {
    kind: "local", name: "context", title: "Context library", script: serverScript,
    mounts: [{ source: library.path, target }],
    env: { HEDGE_CONTEXT_LIBRARY: target, ...(library.url ? { HEDGE_CONTEXT_URL: library.url } : {}) },
  };
}

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../pack.json"), "utf8")) as { name: string; aliases?: Array<{ name: string }> };
const packNames = [manifest.name, ...(manifest.aliases ?? []).map((alias) => alias.name)];
const declaresLibrary = (script: string) => packNames.some((name) => script.endsWith(join(sep, "packs", name, "mcp", "main.ts")));

const probed = (value: unknown) => {
  let upstream: Upstream;
  try { upstream = parseUpstream(value); } catch { return cannotTell; }
  if (upstream.name !== "context") return 1;
  return upstream.kind === "local" && declaresLibrary(upstream.script) ? 0 : cannotTell;
};

export function undoUpstream(action: string | undefined, home: string, print: (line: string) => void): number | undefined {
  if (action === "remove") {
    if (existsSync(upstreamFile(home))) rmSync(upstreamFile(home)), print(`Context library: removed ${upstreamFile(home)}.`);
    return 0;
  }
  if (action !== "doctor") return undefined;
  try {
    return probed(JSON.parse(readFileSync(upstreamFile(home), "utf8")));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? 1 : cannotTell;
  }
}

const declared = (home: string) => {
  try { return JSON.parse(readFileSync(upstreamFile(home), "utf8")) as unknown; } catch { return undefined; }
};

export function upstreamCommand(action: string | undefined, library: Library, home: string, print: (line: string) => void): number {
  const want = contextUpstream(library);
  if (action === "install") {
    mkdirSync(dirname(upstreamFile(home)), { recursive: true });
    writeFileSync(upstreamFile(home), `${JSON.stringify(want, null, 2)}\n`);
    print(`Context library: the MCP gateway serves context_search from ${library.path} once it applies ${upstreamFile(home)}.`);
    return 0;
  }
  if (action === "doctor") {
    if (Bun.deepEquals(declared(home), want)) return 0;
    print(`Context library: ${upstreamFile(home)} does not declare the context search for ${library.path}. Run: hedge context upstream install`);
    return 1;
  }
  return 2;
}
