import { readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { runCommand } from "../../base/lib/command.ts";
import { modelFor } from "../../base/lib/models.ts";
import { redactSecrets } from "../../base/hooks/secret-guard.ts";
import { capture, captureAgent, type Agent } from "../lib/capture.ts";
import { hubSources, type Sources } from "../lib/source.ts";
import { cacheFile, docUrl, librarySettings, writePointer } from "../lib/config.ts";
import { runGit, type Git } from "../lib/git.ts";
import { catalogName, parseDoc, readLibrary, related, renderCatalog, search, topicReport } from "../lib/library.ts";
import { routerAgent, share, t3ShareDeps, type ShareDeps, type Shared, type SharedNote } from "../lib/share.ts";
import { syncLibrary } from "../lib/sync.ts";
import { upstreamCommand } from "../lib/upstream.ts";

type Env = Record<string, string | undefined>;
export type ContextDeps = { env: Env; home: string; print: (line: string) => void; git: Git; agent: () => Agent; sources: Sources; today: () => string; share: (owner: string) => ShareDeps };

export const usage = `usage:
  hedge context search <word>... [--all]   Rank the library's documents; --all adds superseded ones
  hedge context add <url> [--share] [--note <why>]
                                            Save a Slack thread, canvas, Google Doc, meeting, or page as a note;
                                            --share also sends its context to the open threads that need it
  hedge context share <note> [--dry-run]    Send a saved note's context to the open threads that need it
  hedge context related <prompt>            Show what the prompt hook would show for this prompt
  hedge context catalog                     Rewrite CATALOG.md in the library checkout
  hedge context topics                      List topics with three or more documents and whether their hub is stale
  hedge context sync                        Clone the library, or fast-forward it; fails while local changes block that
  hedge context upstream install|doctor|remove  Declare the library's search to the hub's MCP gateway`;

export async function contextCommand(args: string[], deps: ContextDeps): Promise<number> {
  const [mode, ...rest] = args;
  const library = librarySettings(deps.env, deps.home);
  writePointer(deps.home, library);
  const root = library.path;
  const docs = () => readLibrary(root, cacheFile(deps.home));
  if (mode === "sync" && !rest.length) return syncLibrary(library, deps.git, deps.print);
  if (mode === "upstream" && rest.length === 1) {
    const code = upstreamCommand(rest[0], library, deps.home, deps.print);
    if (code !== 2) return code;
  }
  if (mode === "search" && rest.length) {
    const all = rest.includes("--all");
    const hits = search(docs(), rest.filter((word) => word !== "--all").join(" "), (path) => redactSecrets(readFileSync(join(root, path), "utf8")), { all });
    for (const hit of hits) {
      const facts = [hit.doc.type, hit.doc.date, hit.doc.status === "superseded" ? "superseded" : ""].filter(Boolean).join(", ");
      deps.print(`${join(root, hit.doc.path)}\n  ${hit.doc.title} (${facts})${hit.line ? `\n  ${hit.line}` : ""}`);
    }
    if (!hits.length) deps.print("No document matches every word. Try fewer words, or --all for superseded documents.");
    return 0;
  }
  if (mode === "add" && rest.length) {
    const sharing = rest[1] === "--share";
    const words = sharing ? [rest[0]!, ...rest.slice(2)] : rest;
    const noteAt = words.indexOf("--note");
    const source = words[0]!;
    if (!/^https:\/\//.test(source) || (noteAt >= 0 && noteAt !== 1) || (noteAt < 0 && words.length !== 1) || words.length === 2) return deps.print(usage), 2;
    const saved = await capture({ source, via: "cli", note: noteAt >= 0 ? words.slice(noteAt + 1).join(" ") : undefined }, { home: deps.home, library, agent: deps.agent(), sources: deps.sources, git: deps.git, today: deps.today });
    deps.print(`${saved.updated ? "Updated" : "Saved"} ${saved.title}: ${join(root, saved.path)}\n${saved.url}`);
    if (!sharing) return 0;
    return printShared(await share({ title: saved.title, url: saved.url, text: saved.text }, deps.share(library.owner)), false, deps.print);
  }
  if (mode === "share" && (rest.length === 1 || (rest.length === 2 && rest[1] === "--dry-run"))) {
    const dryRun = rest.length === 2;
    const path = isAbsolute(rest[0]!) ? rest[0]! : join(root, rest[0]!);
    const doc = relative(root, path);
    if (doc.startsWith("..") || isAbsolute(doc)) return deps.print(`${path} is not in the context library at ${root}.`), 2;
    const text = readFileSync(path, "utf8");
    const note: SharedNote = { title: parseDoc(doc, text).title, url: docUrl(library, doc), text };
    return printShared(await share(note, deps.share(library.owner), [], dryRun), dryRun, deps.print);
  }
  if (mode === "related" && rest.length) {
    for (const doc of related(docs(), rest.join(" "))) deps.print(`${join(root, doc.path)}: ${doc.title}`);
    return 0;
  }
  if (mode === "catalog" && !rest.length) {
    writeFileSync(join(root, catalogName), renderCatalog(docs()));
    deps.print(`Wrote ${join(root, catalogName)}.`);
    return 0;
  }
  if (mode === "topics" && !rest.length) {
    for (const topic of topicReport(docs())) {
      deps.print(`${topic.topic}: ${topic.docs.length} documents, hub ${topic.hub ? `${topic.hub.path}${topic.stale ? " (stale)" : ""}` : "missing"}`);
      for (const doc of topic.docs) deps.print(`  ${doc.path}${doc.date ? ` (${doc.date})` : ""}`);
    }
    return 0;
  }
  deps.print(usage);
  return 2;
}

function printShared(shared: Shared, dryRun: boolean, print: (line: string) => void): number {
  if (!shared.sent.length && !shared.failed.length) print("No open thread needs this note.");
  for (const route of shared.sent) print(`${dryRun ? "Would send to" : "Sent to"} ${route.title} (${route.host} ${route.id})${route.link ? `\n  ${route.link}` : ""}\n  ${route.message.replaceAll("\n", "\n  ")}`);
  for (const { route, error } of shared.failed) print(`Failed to send to ${route.title} (${route.host} ${route.id}): ${error}`);
  return shared.failed.length ? 1 : 0;
}

if (import.meta.main) {
  await runCommand(
    () => contextCommand(process.argv.slice(2), {
      env: Bun.env,
      home: Bun.env.HOME ?? homedir(),
      print: (line) => console.log(line),
      git: runGit,
      agent: () => captureAgent(modelFor("survey"), Bun.env.HOME ?? homedir()),
      sources: hubSources(Bun.env.HOME ?? homedir()),
      today: () => new Date().toISOString().slice(0, 10),
      share: (owner) => t3ShareDeps({ owner, host: hostname(), route: routerAgent(modelFor("survey")), skip: Bun.env.T3CODE_THREAD_ID ? [Bun.env.T3CODE_THREAD_ID] : [] }),
    }),
    "hedge context",
  );
}
