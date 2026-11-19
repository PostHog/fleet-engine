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
const pageByteLimit = 5 << 20;
const wisprWindowHours = 1;

export function gatewayRead(source: string): GatewayRead | undefined {
  const url = new URL(source);
  const host = url.hostname.replace(/\.$/, "");
  if (host === "slack.com" || host.endsWith(".slack.com")) {
    const thread = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(url.pathname);
    const replyOf = url.searchParams.get("thread_ts");
    if (thread) return { route: "slack", tool: "slack_read_thread", args: { channel_id: thread[1], message_ts: replyOf && /^\d{10}\.\d{6}$/.test(replyOf) ? replyOf : `${thread[2]}.${thread[3]}`, limit: 1000 } };
    const canvas = /^\/docs\/[A-Z0-9]+\/(F[A-Z0-9]+)\/?$/.exec(url.pathname);
    if (canvas && canvasId.test(canvas[1]!)) return { route: "slack", tool: "slack_read_canvas", args: { canvas_id: canvas[1] } };
    throw new Error(`${source} is neither a Slack thread nor a Slack canvas link`);
  }
  if (host === "docs.google.com" && /^\/\w+\/d\/(?:e\/|[^/]+\/pub(?:html)?\/?$)/.test(url.pathname)) return undefined;
  if (host === "docs.google.com" && url.pathname.startsWith("/document/d/")) return { route: "google-drive", tool: "get_document_text", args: { document_url: source } };
  if (host === "docs.google.com" && url.pathname.startsWith("/presentation/d/")) return { route: "google-drive", tool: "get_presentation_text", args: { presentation_url: source } };
  if (host === "docs.google.com" || host === "drive.google.com") return { route: "google-drive", tool: "fetch", args: { url: source } };
  if (host === "notes.wisprflow.ai") return { route: "wispr-flow", tool: "resolve_share_link", args: { url: source, view_transcript: {} } };
  return undefined;
}

const capped = (text: string) => (text.length > partLimit ? `${text.slice(0, partLimit)}\n[… the rest is cut …]` : text);

export async function readMaterial(input: SourceInput, sources: Sources): Promise<Material> {
  const read = input.material === undefined ? gatewayRead(input.source) : undefined;
  const text = input.material ?? (read ? await sources.call(read.route, read.tool, read.args) : await sources.page(input.source));
  const parts = [{ label: input.source, text: capped(text) }];
  for (const id of input.canvases ?? []) {
    if (!canvasId.test(id)) throw new Error(`${JSON.stringify(id)} is not a Slack canvas id`);
    const read = await sources.call("slack", "slack_read_canvas", { canvas_id: id }).catch(() => "This canvas could not be read.");
    parts.push({ label: `Slack canvas ${id}`, text: capped(read) });
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
    const meetings = read.flatMap((meeting) => (meeting.status === "fulfilled" ? [meeting.value] : []));
    return listed.length && !meetings.length ? undefined : meetings;
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
const attributes = `(?:[^<>"']|"[^"<]*"|'[^'<]*')*`;
const blockTags = new RegExp(`<\\/?(?:p|div|br|li|tr|h[1-6]|title|section|article|header|footer|pre|blockquote)\\b${attributes}>`, "gi");
const anyTag = new RegExp(`<${attributes}>`, "g");
const links = new RegExp(`<a\\b(${attributes})>((?:(?!<a\\b|<\\/a\\s*>)[\\s\\S])*)<\\/a\\s*>`, "gi");
const hidden = new RegExp(`<!--|<(script|style|noscript|template|svg)(?=[\\s/>])${attributes}>`, "gi");

function withoutHidden(html: string): string {
  let kept = "";
  let at = 0;
  hidden.lastIndex = 0;
  for (let open = hidden.exec(html); open; open = hidden.exec(html)) {
    kept += `${html.slice(at, open.index)} `;
    if (open[1]?.toLowerCase() === "svg" && open[0].endsWith("/>")) {
      at = hidden.lastIndex;
      continue;
    }
    const closing = open[1] ? new RegExp(`<\\/${open[1]}\\s*>`, "gi") : /--!?>/g;
    closing.lastIndex = hidden.lastIndex;
    if (!closing.exec(html)) return kept;
    at = hidden.lastIndex = closing.lastIndex;
  }
  return kept + html.slice(at);
}

const attribute = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function hrefOf(tag: string): string | undefined {
  const href = [...tag.matchAll(attribute)].find((match) => match[1]!.toLowerCase() === "href");
  return href && decoded(href[2] ?? href[3] ?? href[4] ?? "");
}

function resolved(href: string, base: string): URL | undefined {
  try {
    return new URL(href, base);
  } catch {
    return undefined;
  }
}

export function pageText(html: string, base: string): string {
  let work = 10 * partLimit;
  let room = partLimit;
  return decoded(withoutHidden(html)
    .replace(links, (_whole, tag: string, text: string) => {
      const href = work > 0 ? hrefOf(tag) : undefined;
      if (href === undefined) return text;
      work -= href.length + base.length;
      const target = resolved(href, base);
      if (!target || !/^https?:$/.test(target.protocol) || target.href.length > room) return text;
      room -= target.href.length;
      return `${text} (${target.href})`;
    })
    .replace(blockTags, "\n")
    .replace(anyTag, " "))
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n[\n ]*/g, "\n")
    .trim();
}

function namedPublicSite(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const top = host.split(".").at(-1) ?? "";
  return url.protocol === "https:" && host.includes(".") && /^[a-z][a-z0-9-]*$/.test(top) && !["localhost", "local", "internal", "home", "lan", "corp", "intranet", "private"].includes(top);
}

const discard = (response: Response) => response.body?.cancel().catch(() => {});

async function limitedText(response: Response, url: string): Promise<string> {
  const tooLarge = () => new Error(`${url} is larger than ${pageByteLimit >> 20} MB`);
  if (Number(response.headers.get("content-length") ?? 0) > pageByteLimit) {
    await discard(response);
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > pageByteLimit) throw tooLarge();
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function readPage(source: string, fetcher: Fetch = fetch): Promise<string> {
  let url = source;
  for (let hop = 0; ; hop++) {
    if (!namedPublicSite(new URL(url))) throw new Error(`${url} is not allowed: hedge context add reads only https pages on a named public site`);
    const response = await fetcher(url, { redirect: "manual", headers: { accept: "text/html, text/plain, text/markdown" }, signal: AbortSignal.timeout(60_000) });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await discard(response);
      if (hop === redirectLimit) throw new Error(`${source} redirected more than ${redirectLimit} times`);
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) {
      await discard(response);
      throw new Error(`${url} answered HTTP ${response.status}`);
    }
    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (type.includes("html")) return pageText(await limitedText(response, url), url);
    if (/^text\/|json|xml/.test(type)) return limitedText(response, url);
    await discard(response);
    throw new Error(`${url} sent ${type || "no content type"}, which hedge context add cannot read as text`);
  }
}

export function hubSources(home: string, fetcher: Fetch = fetch): Sources {
  return {
    page: (url) => readPage(url, fetcher),
    async call(route, tool, args) {
      const client = await readGatewayClient(home, {}).catch(() => undefined);
      if (!client) throw new Error(`This source is read through the hub's MCP gateway, and this machine has no gateway key. ${grantHint}`);
      const opened = await openRoute({ gateway: { url: client.baseUrl.replace(/\/mcphub$/, ""), credential: client.token }, fetch: fetcher }, route, "hedge-context-add");
      try {
        return (await opened.call(tool, args)).text;
      } finally {
        await opened.close();
      }
    },
  };
}
