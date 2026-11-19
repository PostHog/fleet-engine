import { readGatewayClient, grantHint, type Fetch } from "../../mcp-gateway/lib/client.ts";
import { openRoute } from "../../mcp-gateway/lib/route.ts";

export type Sources = {
  page(url: string): Promise<string>;
  call(route: string, tool: string, args: Record<string, unknown>): Promise<string>;
};
export type Part = { label: string; text: string };
export type Meeting = { id: string; link?: string; text: string };
export type Material = { parts: Part[]; meetings?: Meeting[] };
export type SourceInput = { source: string; material?: string; canvases?: string[]; startedAt?: string };

type GatewayRead = { route: string; tool: string; args: Record<string, unknown> };

export const canvasId = /^F[A-Z0-9]{2,20}$/;
const partLimit = 100_000;
const meetingLimit = 5;
const redirectLimit = 5;
const wisprWindowHours = 1;

export function gatewayRead(source: string): GatewayRead | undefined {
  const url = new URL(source);
  if (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) {
    const thread = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(url.pathname);
    const replyOf = url.searchParams.get("thread_ts");
    if (thread) return { route: "slack", tool: "slack_read_thread", args: { channel_id: thread[1], message_ts: replyOf && /^\d{10}\.\d{6}$/.test(replyOf) ? replyOf : `${thread[2]}.${thread[3]}`, limit: 1000 } };
    const canvas = /^\/docs\/[A-Z0-9]+\/(F[A-Z0-9]+)\/?$/.exec(url.pathname);
    if (canvas && canvasId.test(canvas[1]!)) return { route: "slack", tool: "slack_read_canvas", args: { canvas_id: canvas[1] } };
    throw new Error(`${source} is neither a Slack thread nor a Slack canvas link`);
  }
  if (url.hostname === "docs.google.com" && /^\/\w+\/d\/e\//.test(url.pathname)) return undefined;
  if (url.hostname === "docs.google.com" && url.pathname.startsWith("/document/d/")) return { route: "google-drive", tool: "get_document_text", args: { document_url: source } };
  if (url.hostname === "docs.google.com" && url.pathname.startsWith("/presentation/d/")) return { route: "google-drive", tool: "get_presentation_text", args: { presentation_url: source } };
  if (url.hostname === "docs.google.com" || url.hostname === "drive.google.com") return { route: "google-drive", tool: "fetch", args: { url: source } };
  if (url.hostname === "notes.wisprflow.ai") return { route: "wispr-flow", tool: "resolve_share_link", args: { url: source, view_transcript: {} } };
  return undefined;
}

const capped = (text: string) => (text.length > partLimit ? `${text.slice(0, partLimit)}\n[… the rest is cut …]` : text);

export async function readMaterial(input: SourceInput, sources: Sources): Promise<Material> {
  const read = input.material === undefined ? gatewayRead(input.source) : undefined;
  const text = input.material ?? (read ? await sources.call(read.route, read.tool, read.args) : await sources.page(input.source));
  const parts = [{ label: input.source, text: capped(text) }];
  for (const id of input.canvases ?? []) {
    if (!canvasId.test(id)) throw new Error(`${JSON.stringify(id)} is not a Slack canvas id`);
    parts.push({ label: `Slack canvas ${id}`, text: capped(await sources.call("slack", "slack_read_canvas", { canvas_id: id })) });
  }
  return input.startedAt ? { parts, meetings: await meetingsAround(input.startedAt, sources) } : { parts };
}

async function meetingsAround(startedAt: string, sources: Sources): Promise<Meeting[] | undefined> {
  const start = new Date(startedAt).getTime();
  const at = (hours: number) => new Date(start + hours * 3_600_000).toISOString();
  try {
    const found = JSON.parse(await sources.call("wispr-flow", "search_meetings", { since: at(-wisprWindowHours), until: at(wisprWindowHours), limit: meetingLimit })) as { meetings?: { id?: unknown; share_link?: unknown }[] };
    const listed = (found.meetings ?? []).filter((meeting): meeting is { id: string; share_link?: unknown } => typeof meeting.id === "string" && /^[\w-]{1,80}$/.test(meeting.id));
    const read = await Promise.allSettled(listed.slice(0, meetingLimit).map(async (meeting) => ({
      id: meeting.id,
      ...(typeof meeting.share_link === "string" && /^https:\/\/notes\.wisprflow\.ai\/shared\/[\w-]+$/.test(meeting.share_link) && { link: meeting.share_link }),
      text: capped(await sources.call("wispr-flow", "get_meeting", { meeting_id: meeting.id, view_transcript: {} })),
    })));
    return read.flatMap((meeting) => (meeting.status === "fulfilled" ? [meeting.value] : []));
  } catch {
    return undefined;
  }
}

const entities: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", middot: "·", bull: "•",
};

function entity(whole: string, name: string) {
  const hex = /^#x([0-9a-f]+)$/i.exec(name)?.[1];
  const decimal = /^#(\d+)$/.exec(name)?.[1];
  const code = hex ? Number.parseInt(hex, 16) : decimal ? Number(decimal) : undefined;
  if (code !== undefined) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  return entities[name.toLowerCase()] ?? whole;
}

const decoded = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, entity);
const attributes = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const blockTags = new RegExp(`<\\/?(?:p|div|br|li|tr|h[1-6]|title|section|article|header|footer|pre|blockquote)\\b${attributes}>`, "gi");
const anyTag = new RegExp(`<${attributes}>`, "g");
const links = new RegExp(`<a\\b(${attributes})>([\\s\\S]*?)<\\/a\\s*>`, "gi");

function linkTarget(tag: string, base: string): string | undefined {
  const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
  try {
    const target = new URL(decoded(href?.[1] ?? href?.[2] ?? href?.[3] ?? ""), base);
    return href && /^https?:$/.test(target.protocol) ? target.href : undefined;
  } catch {
    return undefined;
  }
}

export function pageText(html: string, base: string): string {
  return decoded(html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(links, (_whole, tag: string, text: string) => {
      const target = linkTarget(tag, base);
      return target ? `${text} (${target})` : text;
    })
    .replace(blockTags, "\n")
    .replace(anyTag, " "))
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n[\n ]*/g, "\n")
    .trim();
}

function namedPublicSite(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const top = host.split(".").at(-1) ?? "";
  return url.protocol === "https:" && host.includes(".") && /^[a-z][a-z0-9-]*$/.test(top) && !["localhost", "local", "internal", "home", "lan", "corp", "intranet", "private"].includes(top);
}

export async function readPage(source: string, fetcher: Fetch = fetch): Promise<string> {
  let url = source;
  for (let hop = 0; ; hop++) {
    if (!namedPublicSite(new URL(url))) throw new Error(`${url} is not allowed: fleet context add reads only https pages on a named public site`);
    const response = await fetcher(url, { redirect: "manual", headers: { accept: "text/html, text/plain, text/markdown" }, signal: AbortSignal.timeout(60_000) });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === redirectLimit) throw new Error(`${source} redirected more than ${redirectLimit} times`);
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (type.includes("html")) return pageText(await response.text(), url);
    if (/^text\/|json|xml/.test(type)) return response.text();
    throw new Error(`${url} sent ${type || "no content type"}, which fleet context add cannot read as text`);
  }
}

export function hubSources(home: string, fetcher: Fetch = fetch): Sources {
  return {
    page: (url) => readPage(url, fetcher),
    async call(route, tool, args) {
      const client = await readGatewayClient(home, {}).catch(() => undefined);
      if (!client) throw new Error(`This source is read through the hub's MCP gateway, and this machine has no gateway key. ${grantHint}`);
      const opened = await openRoute({ gateway: { url: client.baseUrl.replace(/\/mcphub$/, ""), credential: client.token }, fetch: fetcher }, route, "fleet-context-add");
      try {
        return (await opened.call(tool, args)).text;
      } finally {
        await opened.close();
      }
    },
  };
}
