import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { LoadedPack, PackManifest } from "../src/pack/types.ts";
import { tempDirs } from "../src/testing/git.ts";
import { spawnAsync } from "../src/testing/spawn.ts";
import { logoMark } from "../page/logo.ts";
import { firstStart, installPrompt, promptData, startPrompt, toggleSelected, type PageData, type PromptData } from "../page/model.ts";
import { t3Link } from "../page/prompt.ts";
import { buildSite, pageData, type SiteFiles } from "./build-page.ts";

const root = join(import.meta.dir, "..");
const temp = tempDirs();
afterEach(() => temp.cleanup());

const teamPack = (manifest: Partial<PackManifest> = {}): LoadedPack => ({
  dir: "/team/packs/acme",
  manifest: {
    schema: 1,
    name: "posthog",
    summary: "A team pack.",
    audience: "posthog",
    workflows: [
      { id: "team-devbox", name: "Team devbox", sentence: "Setup makes a team devbox.", needs: ["posthog-org"], default: true, settings: ["posthog.region"] },
    ],
    settings: [{ key: "posthog.region", question: "Which region?", type: "choice", default: "us", ask: "setup", choices: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }] }],
    ...manifest,
  },
});

let data: PageData;
let files: SiteFiles;
beforeAll(async () => {
  data = await pageData({ audience: "public" });
  files = await buildSite({ audience: "public" });
});

const pagesOf = (site: SiteFiles) => Object.entries(site).flatMap(([path, content]) => (path.endsWith(".html") ? [[path, content as string] as const] : []));
const page = (path: string, site = files) => site[path] as string;
const unescaped = (html: string) => html.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
const visibleText = (html: string) => unescaped(html.replace(/<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>|<head>[\s\S]*?<\/head>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const promptOn = (html: string, id: string) => unescaped(html.match(new RegExp(`<pre id="${id}-text"[^>]*>([\\s\\S]*?)</pre>`))![1]!.replace(/<[^>]+>/g, ""));
const t3LinkOn = (html: string, id: string) => unescaped(html.match(new RegExp(`<a class="btn btn-ghost" id="${id}-t3" href="([^"]*)"`))![1]!);
const carried = (html: string) => JSON.parse(html.match(/<script id="hedge-data" type="application\/json">([\s\S]*?)<\/script>/)![1]!) as PromptData;
const boxOf = (html: string) => html.match(/<section class="box">[\s\S]*?<\/section>/)![0];

function localTargets(path: string, html: string) {
  const links = [...html.matchAll(/\s(?:href|src|srcset)="([^"]*)"/g)].map((match) => unescaped(match[1]!));
  return links
    .filter((link) => !/^(https?:|data:|#)/.test(link))
    .map((link) => {
      const target = posix.join(posix.dirname(path), link.replace(/#.*$/, ""));
      return target === "." || target === "./" ? "index.html" : target.endsWith("/") ? `${target}index.html` : target;
    });
}

describe("the site build", () => {
  test("writes one page for the landing, one for the packs, and one for every pack", () => {
    expect(pagesOf(files).map(([path]) => path)).toEqual(["index.html", "packs/index.html", ...data.packs.map((pack) => `packs/${pack.name}/index.html`)]);
    expect(data.packs.map((pack) => pack.name)).toEqual(["base", "hub", "pull-requests", "orchestration", "communication", "guards", "memory", "slack", "incident-io", "mcp-gateway"]);
  });

  test("every link and asset on every page leads to a file of the site, from any folder the site is served under", () => {
    for (const [path, html] of pagesOf(files)) {
      const targets = localTargets(path, html);
      expect([path, targets.filter((target) => !(target in files))]).toEqual([path, []]);
      expect([path, targets.length > 5]).toEqual([path, true]);
      expect([path, html.match(/\s(?:href|src|srcset)="\/[^"]*"/g)]).toEqual([path, null]);
    }
  });

  test("no page asks the site for a script or stylesheet file", () => {
    expect(Object.keys(files).filter((path) => /\.(js|css)$/.test(path))).toEqual([]);
    for (const [path, html] of pagesOf(files)) {
      expect([path, localTargets(path, html).filter((target) => /\.(js|css)$/.test(target))]).toEqual([path, []]);
      expect([path, html.match(/<script\b[^>]*\bsrc=|<link rel="stylesheet" href="(?!https:)/g)]).toEqual([path, null]);
    }
  });

  test("the landing page's first screen says that Hedge runs agents in the cloud, not on the Mac, and why", () => {
    const hero = visibleText(page("index.html").match(/<section class="hero">[\s\S]*?<\/section>/)![0]).replaceAll(" ,", ",");
    expect(hero).toContain(
      "Hedge runs your agents in the cloud, not on your Mac. Always on. Agents keep working when you close your Mac or go to sleep. Secure. Agents run on isolated cloud boxes. The sign-ins and tokens of your packs stay on your hub. Your Mac stays clean. With you everywhere. Read and steer every thread from your Mac or your phone. Grows with your work. Add a node when you need more agents at once.",
    );
  });

  test("the landing page says the first setup runs from T3 Code on the Mac, and that the phone reads and steers once the boxes are linked", () => {
    const lead = visibleText(page("index.html").match(/<header class="band-head"><p class="eyebrow">Get started<\/p>[\s\S]*?<\/header>/)![0]);
    expect(lead).toContain("Paste it into T3 Code on your Mac. The first setup runs from there, because it creates the cloud boxes and reaches them over SSH. The agent sets up the cloud boxes, and installs nothing from Hedge on your Mac. Once the boxes are linked, read and steer them from your phone too.");
  });

  test("the landing page offers one setup, a hub and a node, with a switch for every default pack, all on, and the Hub pack always on", () => {
    const html = page("index.html");
    expect(html.match(/<section class="box">/g)).toHaveLength(1);
    const switches = [...boxOf(html).matchAll(/<input type="checkbox" role="switch" class="switch" name="([^"]+)"[^>]*?( checked)?>/g)].map((match) => [match[1], Boolean(match[2])]);
    expect(switches).toEqual(["pull-requests", "orchestration", "communication", "memory"].map((pack) => [`start:${pack}`, true]));
    expect(visibleText(boxOf(html))).toContain("Hub The hub links your boxes and keeps your pack secrets. Turn on recovery, and it continues threads after a usage limit. Always on");
  });

  test("the landing page shows the Getting Started prompt after the box, with a link that opens it in T3 Code", () => {
    const html = page("index.html");
    const prompt = startPrompt(data, firstStart);
    expect(promptOn(html, "start")).toBe(prompt);
    expect(t3LinkOn(html, "start")).toBe(`https://app.t3.codes/new?prompt=${encodeURIComponent(prompt)}`);
    expect(html.indexOf('id="start-text"')).toBeGreaterThan(html.lastIndexOf('class="box"'));
    expect(html).toContain('<button type="button" class="btn btn-yellow" data-copy="start-text">Copy prompt</button>');
    for (const text of ["Download T3 Code", "Sign in with T3 Connect", "Paste this prompt", "https://t3.codes"]) expect(html).toContain(text);
    expect(startPrompt(carried(html), { off: ["communication"] })).toBe(startPrompt(data, { off: ["communication"] }));
  });

  test("the landing page lists no pack beyond the packs of the box, and links the packs page", () => {
    const html = page("index.html");
    const boxed = [...data.startPacks, ...data.hubStartPacks];
    const others = data.packs.filter((pack) => !boxed.includes(pack.name));
    expect(others.map((pack) => pack.title)).toEqual(["Base", "Guards", "Slack", "Paging (incident.io)", "MCP gateway"]);
    const text = visibleText(html);
    expect(others.filter((pack) => new RegExp(`\\b${pack.title}\\b`).test(text)).map((pack) => pack.title)).toEqual([]);
    expect(localTargets("index.html", html).filter((target) => target.startsWith("packs/"))).toEqual(expect.arrayContaining(["packs/index.html"]));
    expect(localTargets("index.html", html).filter((target) => /^packs\/.+\//.test(target))).toEqual([]);
  });

  test("the packs page shows Base and Hub in every Hedge without a switch, then the picks in three groups, leaves Integrations off the site, and lets a visitor add Hub from its page", async () => {
    const groupsOf = (html: string) =>
      [...html.matchAll(/<section[^>]*aria-labelledby="(group-\d+)"[^>]*>([\s\S]*?)<\/section>/g)].map(([, id, body]) => [
        visibleText(body!.match(new RegExp(`<h2[^>]*id="${id}"[^>]*>([\\s\\S]*?)</h2>`))![1]!).trim(),
        [...body!.matchAll(/<li[\s\S]*?<\/li>/g)].map(([card]) => `${unescaped(card.match(/aria-label="([^"]+) details"/)![1]!)}${/type="checkbox"/.test(card) ? " (switch)" : ""}`),
      ]);
    expect(groupsOf(page("packs/index.html"))).toEqual([
      ["In every Hedge", ["Base", "Hub"]],
      ["How your agents work", ["Quality gates (switch)", "Orchestration (switch)", "Communication (switch)", "Guards (switch)"]],
      ["What your agents know", ["Memory (switch)"]],
      ["What your agents reach", ["Slack (switch)", "Paging (incident.io) (switch)", "MCP gateway (switch)"]],
    ]);
    const hub = page("packs/hub/index.html");
    expect([visibleText(hub).includes("You add nothing"), visibleText(hub).includes("Add to your Hedge")]).toEqual([false, true]);
    expect(promptOn(hub, "install")).toBe(installPrompt(data, ["hub"]));
    expect(promptOn(hub, "install")).toContain("\n   hedge packs --add hub\n");
    expect(Object.keys(files)).not.toContain("packs/integrations/index.html");
    const team = await buildSite({ audience: "posthog", team: [teamPack()] });
    expect(groupsOf(page("packs/index.html", team)).at(-1)).toEqual(["Your team's packs", ["Posthog (switch)"]]);
  });

  test("the packs page lets a visitor select every pack but Base, and links each pack's own page", () => {
    const html = page("packs/index.html");
    expect(html).toContain("<h1>Extend your <mark>Hedge</mark>.</h1>");
    expect([...html.matchAll(/<input class="sr" type="checkbox" name="pack" id="pick-[^"]+" value="([^"]+)">/g)].map((match) => match[1])).toEqual(data.packs.filter((pack) => !pack.always).map((pack) => pack.name));
    expect(localTargets("packs/index.html", html).filter((target) => /^packs\/.+\//.test(target))).toEqual(data.packs.map((pack) => `packs/${pack.name}/index.html`));
    const everyPack = data.packs.reduce((selected, pack) => (selected.includes(pack.name) ? selected : toggleSelected(data, selected, pack.name)), [] as string[]);
    expect(installPrompt(carried(html), everyPack)).toBe(installPrompt(data, everyPack));
    expect(html).toContain('<button type="button" class="btn btn-yellow" data-copy="install-text">Copy prompt</button>');
    expect(html).toContain('id="install-t3"');
  });

  test("each pack's page carries the prompt that adds that pack and the packs it requires", () => {
    for (const pack of data.packs.filter((item) => !item.always)) {
      const html = page(`packs/${pack.name}/index.html`);
      const prompt = installPrompt(data, toggleSelected(data, [], pack.name));
      expect([pack.name, promptOn(html, "install")]).toEqual([pack.name, prompt]);
      expect([pack.name, t3LinkOn(html, "install")]).toEqual([pack.name, t3Link(prompt)]);
      expect(html).toContain(`data-select="${pack.name}"`);
      expect(visibleText(html)).toContain(pack.summary);
    }
    expect(promptOn(page("packs/orchestration/index.html"), "install")).toContain("hedge packs --add pull-requests --add orchestration");
    const base = page("packs/base/index.html");
    expect(base).toContain("Every Hedge has this pack. You add nothing.");
    expect(base).not.toContain('id="install-text"');
  });

  test("each pack's page shows its workflows, its cost, its risk, and its settings", () => {
    for (const pack of data.packs) {
      const text = visibleText(page(`packs/${pack.name}/index.html`)).replaceAll("`", "");
      const shown = (words: string) => [pack.name, text.includes(words.replaceAll("`", "").replace(/\s+/g, " ")) ? "shown" : words];
      for (const workflow of pack.workflows) expect(shown(workflow.name)).toEqual([pack.name, "shown"]);
      for (const words of [pack.cost, pack.risk]) if (words) expect(shown(words)).toEqual([pack.name, "shown"]);
      for (const setting of pack.settings) expect(shown(setting.key)).toEqual([pack.name, "shown"]);
    }
  });

  test("the public build names no item of a private team pack, and credits PostHog for the hedgehogs and the logo", async () => {
    for (const [path, html] of pagesOf(files)) expect([path, html.match(/hogli|coder|stamphog|reviewhog/gi)]).toEqual([path, null]);
    expect(data.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).not.toContain("previews");
    expect(data.teamPacks).toEqual([]);
    for (const [path, html] of pagesOf(files)) {
      expect([path, html.includes('alt="PostHog"')]).toEqual([path, true]);
      expect([path, visibleText(html).includes("The hedgehogs and the PostHog logo belong to PostHog.")]).toEqual([path, true]);
    }
  });

  test("every pack shows its own icon and its own hedgehog, the same on its card and on its page, and a team pack gets the team's", async () => {
    const iconOf = (html: string) => html.match(/<span class="icon [^"]*">([\s\S]*?)<\/span>/)![1]!;
    const hogOf = (html: string) => html.match(/<div class="stage tone-\w+"><img src="[^"]*assets\/art\/([\w.-]+)"/)![1]!;
    const cardsOf = (html: string) => html.split('<li class="pack-card').slice(1);
    const cards = cardsOf(page("packs/index.html"));
    expect(cards).toHaveLength(data.packs.length);
    expect(new Set(cards.map(iconOf)).size).toBe(cards.length);
    expect(new Set(cards.map(hogOf)).size).toBe(cards.length);
    data.packs.forEach((pack, index) => {
      const own = page(`packs/${pack.name}/index.html`);
      expect([pack.name, iconOf(own.slice(own.indexOf("<h1"))), hogOf(own)]).toEqual([pack.name, iconOf(cards[index]!), hogOf(cards[index]!)]);
    });
    const team = await buildSite({ audience: "posthog", team: [teamPack({ name: "acme", audience: undefined, workflows: [], settings: [] })] });
    const teamCard = cardsOf(page("packs/index.html", team)).at(-1)!;
    expect(teamCard).toContain('value="acme"');
    expect(cards.map(iconOf)).not.toContain(iconOf(teamCard));
    expect(cards.map(hogOf)).not.toContain(hogOf(teamCard));
  });

  test("a build ships each picture its pages show, unchanged, and no other picture", async () => {
    const artDir = join(root, "page/art");
    const team = await buildSite({ audience: "posthog", team: [teamPack()] });
    for (const site of [files, team]) {
      const shipped = Object.keys(site).filter((path) => path.startsWith("assets/art/"));
      const shown = new Set(pagesOf(site).flatMap(([path, html]) => localTargets(path, html)));
      expect(shipped.filter((path) => !shown.has(path))).toEqual([]);
      for (const path of shipped) expect([path, Buffer.from(site[path]!).equals(readFileSync(join(artDir, posix.basename(path))))]).toEqual([path, true]);
    }
    expect(Object.keys(files)).not.toContain("assets/art/heart-hog.png");
    expect(Object.keys(team)).toContain("assets/art/heart-hog.png");
  });

  test("the credits name the source of every picture in the art folder, and the folder holds no picture that no build shows but the ones kept for a later page", async () => {
    const artDir = join(root, "page/art");
    const keptUnshown = ["desk-hog.png", "hospital-hog.png", "laptop-hog-02.png"];
    const held = readdirSync(artDir).filter((name) => !name.endsWith(".md") && name !== "LICENSE");
    const credits = readFileSync(join(artDir, "README.md"), "utf8");
    expect(held.filter((name) => !new RegExp(`^\\| \`${name}\` \\| \`[^\`]+/${name}\` \\| \`[0-9a-f]{40}\` \\|$`, "m").test(credits))).toEqual([]);
    expect(readFileSync(join(artDir, "LICENSE"), "utf8")).toStartWith("Copyright (c) 2020-2026 PostHog Inc.");
    const team = await buildSite({ audience: "posthog", team: [teamPack()] });
    expect(held.filter((name) => !(`assets/art/${name}` in team)).toSorted()).toEqual(keptUnshown);
    expect(held.length).toBeGreaterThan(15);
  });

  test("a pack's page shows how the pack works in three to five short steps", () => {
    const flows = data.packs.flatMap((pack) => {
      const flow = page(`packs/${pack.name}/index.html`).match(/<ol class="flow">([\s\S]*?)<\/ol>/)?.[1];
      return flow ? [[pack.name, [...flow.matchAll(/<span class="flow-step">([^<]+)<\/span>/g)].map((match) => unescaped(match[1]!))] as const] : [];
    });
    expect(flows.map(([name]) => name)).toEqual(expect.arrayContaining(["pull-requests", "orchestration", "memory"]));
    for (const [name, steps] of flows) {
      expect([name, steps.length >= 3 && steps.length <= 5]).toEqual([name, true]);
      expect([name, steps.filter((step) => step.split(" ").length > 7)]).toEqual([name, []]);
    }
  });

  test("every page, its tab icon, and the README carry the same Hedge logo", () => {
    for (const [path, html] of pagesOf(files)) {
      expect([path, html.includes(`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(logoMark)}">`)]).toEqual([path, true]);
      expect([path, html.split(logoMark).length]).toEqual([path, 3]);
    }
    expect(readFileSync(join(root, "docs", "hedge-logo.svg"), "utf8").trim()).toBe(logoMark);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain('src="docs/hedge-logo.svg"');
  });

  test("the public build refuses a private pack source", async () => {
    expect(pageData({ audience: "public", team: [teamPack()] })).rejects.toThrow("no pack from a private source");
    expect(buildSite({ audience: "public", team: [teamPack()] })).rejects.toThrow("no pack from a private source");
  });

  test("a team build puts the team pack in the box and in the first setup, and gives it a page", async () => {
    const team = [teamPack({ title: "PostHog" })];
    const teamData = await pageData({ audience: "posthog", team });
    const site = await buildSite({ audience: "posthog", team });
    expect(teamData.teamPacks).toEqual(["posthog"]);
    expect(startPrompt(teamData, firstStart)).toContain("- Packs on the first setup: pull-requests, orchestration, communication, memory, posthog\n");
    expect(startPrompt(teamData, { off: teamData.startPacks })).toContain("- Packs on the first setup: posthog\n");
    const landing = page("index.html", site);
    expect(promptOn(landing, "start")).toBe(startPrompt(teamData, firstStart));
    expect(visibleText(boxOf(landing))).toContain("PostHog A team pack. Your team's pack");
    expect(boxOf(landing)).not.toContain('name="start:posthog"');
    expect(visibleText(page("packs/posthog/index.html", site))).toContain("Team devbox");
    expect(promptOn(page("packs/posthog/index.html", site), "install")).toContain("hedge packs --add posthog");
    expect(teamData.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).toContain("previews");
    for (const [path, html] of pagesOf(site)) expect([path, localTargets(path, html).filter((target) => !(target in site))]).toEqual([path, []]);
  });

  test("a team pack that requires a hidden, an old or an unknown pack builds, and a hidden team pack stays off the site", async () => {
    const team = [teamPack({ title: "PostHog", requires: ["integrations", "context-library", "gone"] }), teamPack({ name: "quiet", onSite: false, workflows: [], settings: [] })];
    const teamData = await pageData({ audience: "posthog", team });
    const site = await buildSite({ audience: "posthog", team });
    expect(teamData.teamPacks).toEqual(["posthog"]);
    expect(visibleText(page("packs/index.html", site))).toContain("Adds integrations Adds Memory Adds gone");
    expect(promptOn(page("packs/posthog/index.html", site), "install")).toContain("hedge packs --add integrations --add gone --add memory --add posthog\n");
    expect(Object.keys(site)).not.toContain("packs/quiet/index.html");
  });

  test("a team build shows a pack by its title, and by its capitalised name without one", async () => {
    const teamData = await pageData({ audience: "posthog", team: [teamPack({ title: "PostHog" }), teamPack({ name: "acme", audience: undefined, workflows: [], settings: [] })] });
    expect(teamData.packs.filter((pack) => pack.name === "posthog" || pack.name === "acme").map((pack) => pack.title)).toEqual(["PostHog", "Acme"]);
  });

  test("a workflow that needs a team pack shows only when that pack is in the build, and so do the settings only it lists", async () => {
    const boxes = { id: "team-boxes", name: "Team boxes", sentence: "Heavy work runs on a box.", needs: ["hub" as const, "coder" as const], default: true, settings: ["acme.template"] };
    const acme = (name: string) => teamPack({ name, audience: undefined, workflows: [boxes], settings: [{ key: "acme.template", question: "Which template?", type: "string" }] });
    const ids = (shown: PageData) => shown.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id);
    const keys = (shown: PageData) => shown.packs.flatMap((pack) => pack.settings).map((setting) => setting.key);
    const withTeam = await pageData({ audience: "posthog", team: [acme("posthog")] });
    expect(ids(withTeam)).toContain("team-boxes");
    expect(keys(withTeam)).toContain("acme.template");
    const without = await pageData({ audience: "posthog", team: [acme("acme")] });
    expect(ids(without)).not.toContain("team-boxes");
    expect(keys(without)).not.toContain("acme.template");
  });

  test("the public build shows the Hub pack without its box workflow and box settings", () => {
    const hub = data.packs.find((pack) => pack.name === "hub")!;
    expect(hub.workflows.map((workflow) => workflow.id)).toEqual(["disk-watch", "linked-hub", "own-account-balancing", "proxy-panel", "provider-recovery"]);
    expect(hub.settings.map((setting) => setting.key).filter((key) => key.startsWith("hub.box"))).toEqual([]);
    expect(Object.keys(data.needLabels)).not.toContain("coder");
  });

  test("the README's overview picture says in its alt text what the picture's own description says", () => {
    const description = readFileSync(join(root, "docs", "hedge.svg"), "utf8").match(/<desc[^>]*>([^<]+)<\/desc>/)![1]!;
    expect(description.length).toBeGreaterThan(40);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`alt="${description}"`);
  });

  test("the command line writes the site for a pack source into the folder of --out, and refuses a single HTML file", async () => {
    const source = temp.make("source-");
    mkdirSync(join(source, "packs", "posthog"), { recursive: true });
    writeFileSync(join(source, "packs", "posthog", "pack.json"), JSON.stringify(teamPack().manifest));
    const out = join(temp.make("out-"), "site");
    const run = await spawnAsync(["bun", join(root, "scripts/build-page.ts"), "--audience", "posthog", "--source", source, "--out", out], { cwd: root });
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain('"teamPacks":["posthog"]');
    for (const path of ["packs/index.html", "packs/posthog/index.html", "assets/art/posthog-logo-light.svg", "assets/art/heart-hog.png"]) expect([path, existsSync(join(out, path))]).toEqual([path, true]);
    const single = await spawnAsync(["bun", join(root, "scripts/build-page.ts"), "--out", join(out, "index.html")], { cwd: root });
    expect([single.exitCode, single.stderr.trim()]).toEqual([2, "build-page: --out takes a directory. The site has one HTML file for each route"]);
  });

});
