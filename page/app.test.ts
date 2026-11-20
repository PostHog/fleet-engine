import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { main } from "../src/cli.ts";
import type { LoadedPack } from "../src/pack/types.ts";
import { profilePath } from "../src/setup/profile.ts";
import { engineRoot, fakeMachine, githubRepo, hedgeSetup, pushedAnswers, scripted } from "../src/setup/testing.ts";
import { cachedCheckout, isolateGit, spawnGit, tempDirs } from "../src/testing/git.ts";
import { buildSite, type SiteFiles } from "../scripts/build-page.ts";
import { withLessons } from "../src/testing/lessons.ts";

isolateGit();
const temp = tempDirs();

const teamPack: LoadedPack = { dir: "/team/packs/acme", manifest: { schema: 1, name: "acme", summary: "A team pack." } };

let site: SiteFiles;
let teamSite: SiteFiles;
beforeAll(async () => {
  site = await buildSite({ ...withLessons(), audience: "public" });
  teamSite = await buildSite({ ...withLessons(), audience: "posthog", team: [teamPack] });
});

const open: Window[] = [];
afterEach(async () => {
  for (const window of open.splice(0)) await window.happyDOM.close();
  temp.cleanup();
});

async function namedHubWithTeam(packs: LoadedPack[]) {
  const home = temp.make("home-");
  expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home))).code).toBe(0);
  const io = scripted([]);
  const hedge = (args: string[]) => main(args, { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: fakeMachine(home).machine } });
  expect(await hedge(["hub", "here", "coder.hedge-hub"])).toBe(0);
  const source = join(home, ".local/share/hedge/sources/team");
  await cachedCheckout(source, { name: "team", repo: "team/packs", ref: "main" });
  for (const { manifest } of packs) {
    mkdirSync(join(source, "packs", manifest.name), { recursive: true });
    writeFileSync(join(source, "packs", manifest.name, "pack.json"), JSON.stringify(manifest));
  }
  const dir = profilePath(home);
  const file = JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8"));
  writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...file, sources: [...file.sources, { name: "team", repo: "team/packs", ref: "main" }] }, null, 2) + "\n");
  await spawnGit(dir, "commit", "-q", "-am", "Team");
  await spawnGit(dir, "push", "-q");
  return { home, hedge, output: io.output };
}

const run = (hedge: (args: string[]) => Promise<number>, command: string) => hedge(command.split(" ").slice(1));

type Visit = { from?: Window; files?: SiteFiles; url?: string; motion?: "reduce" | "no-preference"; inView?: boolean };

function visit(path: string, { from, files = site, url = `https://hedge.test/hedge-engine/${path.replace(/index\.html$/, "")}`, motion = "no-preference", inView = false }: Visit = {}) {
  const window = new Window({ url, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, device: { prefersReducedMotion: motion } } });
  open.push(window);
  if (inView) showEverything(window);
  if (from) carryStorage(from, window);
  window.document.addEventListener("click", (event) => {
    if ((event.target as unknown as Element).closest("a")) event.preventDefault();
  });
  window.document.write(files[path] as string);
  return window;
}

function showEverything(window: Window) {
  Object.assign(window, {
    IntersectionObserver: class {
      constructor(private readonly report: (entries: object[], observer: object) => void) {}
      observe(target: Element) {
        this.report([{ target, isIntersecting: true, intersectionRatio: 1 }], this);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  });
}

function carryStorage(from: Window, to: Window) {
  for (let index = 0; index < from.sessionStorage.length; index++) {
    const key = from.sessionStorage.key(index)!;
    to.sessionStorage.setItem(key, from.sessionStorage.getItem(key)!);
  }
}

const input = (window: Window, selector: string) => window.document.querySelector(selector) as unknown as HTMLInputElement;
const text = (window: Window, id: string) => window.document.getElementById(id)!.textContent;
const line = (window: Window, label: string) => text(window, "start-text").match(new RegExp(`^- ${label}: (.*)$`, "m"))?.[1];
const switchOf = (window: Window, pack: string) => input(window, `input[name="start:${pack}"]`);
const switches = (window: Window) => ["pull-requests", "orchestration", "communication", "memory"].filter((pack) => switchOf(window, pack).checked);
const selected = (window: Window) => [...window.document.querySelectorAll('input[name="pack"]')].flatMap((box) => ((box as unknown as HTMLInputElement).checked ? [(box as unknown as HTMLInputElement).value] : []));
const command = (window: Window) => text(window, "install-text").match(/^ {3}(hedge packs .*)$/m)?.[1];
const shown = (window: Window, id: string) => !(window.document.getElementById(id) as unknown as HTMLElement).hidden;
const copied = async (window: Window) => {
  (window.document.querySelector('[data-copy="install-text"]') as unknown as HTMLButtonElement).click();
  return window.navigator.clipboard.readText();
};
const t3Prompt = (window: Window, id: string) => new URL((window.document.getElementById(`${id}-t3`) as unknown as HTMLAnchorElement).href).searchParams.get("prompt");

describe("the landing page in a browser", () => {
  test("a switch rewrites the prompt under the box, its T3 Code link, and the status for a screen reader", () => {
    const window = visit("index.html");
    expect([line(window, "Packs on the first setup"), line(window, "Packs once the hub runs")]).toEqual(["pull-requests, orchestration, communication, memory", "hub"]);
    switchOf(window, "communication").click();
    expect([line(window, "Packs on the first setup"), line(window, "Packs once the hub runs")]).toEqual(["pull-requests, orchestration, memory", "hub"]);
    expect(t3Prompt(window, "start")).toBe(text(window, "start-text"));
    const shownName = (pack: string) => switchOf(window, pack).getAttribute("aria-label")!.replace(/ on the first setup$/, "");
    expect(text(window, "start-status")).toBe(`The prompt now sets up ${shownName("pull-requests")}, ${shownName("orchestration")}, and ${shownName("memory")} first.`);
    expect(shownName("pull-requests")).toBe("Quality gates");
    switchOf(window, "communication").click();
    expect(line(window, "Packs on the first setup")).toBe("pull-requests, orchestration, communication, memory");
  });

  test("switching Quality gates off switches Orchestration off, and switching Orchestration on brings Quality gates back", () => {
    const window = visit("index.html");
    switchOf(window, "pull-requests").click();
    expect(switches(window)).toEqual(["communication", "memory"]);
    expect(line(window, "Packs on the first setup")).toBe("communication, memory");
    switchOf(window, "communication").click();
    switchOf(window, "memory").click();
    expect(line(window, "Packs on the first setup")).toBe("none");
    expect(text(window, "start-status")).toBe("The prompt now sets up no pack first.");
    switchOf(window, "orchestration").click();
    expect(switches(window)).toEqual(["pull-requests", "orchestration"]);
    expect(line(window, "Packs on the first setup")).toBe("pull-requests, orchestration");
  });

  test("Copy prompt puts the prompt that shows on the clipboard and says so on the button", async () => {
    const window = visit("index.html");
    switchOf(window, "communication").click();
    const button = window.document.querySelector('[data-copy="start-text"]') as unknown as HTMLButtonElement;
    button.click();
    expect(await window.navigator.clipboard.readText()).toBe(text(window, "start-text"));
    expect(button.textContent).toBe("Copied");
  });

  test("an older page whose chooser lacks a switch that the newer script knows still updates its prompt and copies it", async () => {
    const older = { ...site, "index.html": (site["index.html"] as string).replace(/<input type="checkbox" role="switch" class="switch" name="start:communication"[^>]*>/, "") };
    const window = visit("index.html", { files: older });
    switchOf(window, "orchestration").click();
    expect(line(window, "Packs on the first setup")).toBe("pull-requests, communication, memory");
    const button = window.document.querySelector('[data-copy="start-text"]') as unknown as HTMLButtonElement;
    button.click();
    expect(await window.navigator.clipboard.readText()).toBe(text(window, "start-text"));
  });

  test("opened from a folder on disk, every link to a route names its index.html, since a folder link opens a file listing there", () => {
    for (const path of ["index.html", "packs/index.html", "packs/memory/index.html"]) {
      const window = visit(path, { url: `file:///tmp/site/${path}` });
      const local = [...window.document.querySelectorAll("a")].map((link) => link.getAttribute("href")!).filter((href) => !/^(https?:|#)/.test(href));
      expect([path, local.length > 3, local.filter((href) => !/\/index\.html(#.*)?$/.test(href))]).toEqual([path, true, []]);
    }
    const packs = visit("packs/index.html", { url: "file:///tmp/site/packs/index.html" });
    watchButton(packs, "Memory").click();
    expect(packs.document.querySelector("dialog a")!.getAttribute("href")).toBe("memory/index.html");
  });
});

describe("the Packs page in a browser", () => {
  test("shows a note until a pack is selected, then the count and one install prompt for the selected packs", () => {
    const window = visit("packs/index.html");
    expect([shown(window, "install-empty"), shown(window, "install-full")]).toEqual([true, false]);
    input(window, "#pick-memory").click();
    expect([shown(window, "install-empty"), shown(window, "install-full"), text(window, "install-count")]).toEqual([false, true, "1 pack selected"]);
    input(window, "#pick-guards").click();
    expect([text(window, "install-count"), command(window)]).toEqual(["2 packs selected", "hedge packs --add guards --add memory"]);
    expect(t3Prompt(window, "install")).toBe(text(window, "install-text"));
    input(window, "#pick-memory").click();
    input(window, "#pick-guards").click();
    expect([shown(window, "install-empty"), shown(window, "install-full")]).toEqual([true, false]);
  });

  test("selecting Orchestration ticks Pull requests too, and taking Pull requests back unticks Orchestration", () => {
    const window = visit("packs/index.html");
    input(window, "#pick-orchestration").click();
    expect(selected(window)).toEqual(["pull-requests", "orchestration"]);
    expect(command(window)).toBe("hedge packs --add pull-requests --add orchestration");
    input(window, "#pick-pull-requests").click();
    expect(selected(window)).toEqual([]);
  });

  test("keeps the selection through a visit to a pack's page, and Add more packs on that page adds its pack", () => {
    const packs = visit("packs/index.html");
    input(packs, "#pick-communication").click();
    const memory = visit("packs/memory/index.html", { from: packs });
    (memory.document.querySelector("a[data-select]") as unknown as HTMLAnchorElement).click();
    const back = visit("packs/index.html", { from: memory });
    expect(selected(back)).toEqual(["communication", "memory"]);
    expect(command(back)).toBe("hedge packs --add communication --add memory");
  });

  test("a page that the browser restores from its history reads the selection again, so a later tick does not drop a pack added elsewhere", () => {
    const packs = visit("packs/index.html");
    input(packs, "#pick-communication").click();
    const memory = visit("packs/memory/index.html", { from: packs });
    (memory.document.querySelector("a[data-select]") as unknown as HTMLAnchorElement).click();
    carryStorage(memory, packs);
    const restored = new packs.Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    packs.dispatchEvent(restored);
    expect(selected(packs)).toEqual(["communication", "memory"]);
    input(packs, "#pick-guards").click();
    expect(command(packs)).toBe("hedge packs --add communication --add guards --add memory");
  });

  test("ticking a team pack adds to the command each pack its card says it adds, also a pack with no card, and unticking it takes them back", async () => {
    const needy: LoadedPack = { dir: "/team/packs/acme", manifest: { schema: 1, name: "acme", summary: "A team pack.", requires: ["integrations", "context-library", "gone"] } };
    const team = visit("packs/index.html", { files: await buildSite({ ...withLessons(), audience: "posthog", team: [needy] }) });
    input(team, "#pick-acme").click();
    expect(selected(team)).toEqual(["acme"]);
    expect([text(team, "install-count"), command(team)]).toEqual(["4 packs selected", "hedge packs --add integrations --add context-library --add gone --add acme"]);
    input(team, "#pick-acme").click();
    expect([shown(team, "install-empty"), shown(team, "install-full")]).toEqual([true, false]);
  });

  test("a pack that requires Hub through a hidden helper adds hub to the command a visitor copies from the packs page and from its own page, and hedge packs on a named hub without Hub takes that command", async () => {
    const acme: LoadedPack = { dir: "/team/packs/acme", manifest: { schema: 1, name: "acme", summary: "A team pack.", requires: ["helper"] } };
    const helper: LoadedPack = { dir: "/team/packs/helper", manifest: { schema: 1, name: "helper", summary: "A hidden helper.", onSite: false, requires: ["hub"] } };
    const files = await buildSite({ ...withLessons(), audience: "posthog", team: [acme, helper] });
    const picker = visit("packs/index.html", { files });
    input(picker, "#pick-acme").click();
    const expected = "hedge packs --add helper --add hub --add acme";
    expect([selected(picker), text(picker, "install-count"), command(picker)]).toEqual([["acme"], "3 packs selected", expected]);
    const own = visit("packs/acme/index.html", { files });
    expect([command(own), (await copied(own)).match(/^ {3}(hedge packs .*)$/m)?.[1], t3Prompt(own, "install")]).toEqual([expected, expected, text(own, "install-text")]);
    const hub = await namedHubWithTeam([acme, helper]);
    expect((await pushedAnswers(hub.home)).packs).not.toContain("hub");
    expect(await run(hub.hedge, "hedge packs --add helper --add acme")).toBe(2);
    expect(await run(hub.hedge, expected)).toBe(0);
    expect((await pushedAnswers(hub.home)).packs).toEqual(expect.arrayContaining(["helper", "hub", "acme"]));
  });

  test("a hidden helper that requires context-library adds context-library by that name, so the command leaves shared memory off and makes no memory repo", async () => {
    const acme: LoadedPack = { dir: "/team/packs/acme", manifest: { schema: 1, name: "acme", summary: "A team pack.", requires: ["helper"] } };
    const helper: LoadedPack = { dir: "/team/packs/helper", manifest: { schema: 1, name: "helper", summary: "A hidden helper.", onSite: false, requires: ["context-library"] } };
    const files = await buildSite({ ...withLessons(), audience: "posthog", team: [acme, helper] });
    const picker = visit("packs/index.html", { files });
    input(picker, "#pick-acme").click();
    const expected = "hedge packs --add helper --add context-library --add acme";
    expect([selected(picker), command(picker)]).toEqual([["acme"], expected]);
    expect(command(visit("packs/acme/index.html", { files }))).toBe(expected);
    const hub = await namedHubWithTeam([acme, helper]);
    expect(await run(hub.hedge, expected)).toBe(0);
    const { packs } = await pushedAnswers(hub.home);
    expect([packs.includes("context-library"), packs.includes("memory"), existsSync(githubRepo(hub.home, "nora/hedge-memory"))]).toEqual([true, false, false]);
  });

  test("leaves out a remembered pack that this site does not have", () => {
    const team = visit("packs/index.html", { files: teamSite });
    input(team, "#pick-acme").click();
    input(team, "#pick-slack").click();
    expect(selected(team)).toEqual(["slack", "acme"]);
    const publicPacks = visit("packs/index.html", { from: team });
    expect(selected(publicPacks)).toEqual(["slack"]);
    expect(command(publicPacks)).toBe("hedge packs --add slack");
  });
});

const video = (window: Window, selector: string) => window.document.querySelector(selector) as unknown as HTMLVideoElement;
const dialog = (window: Window) => window.document.querySelector("dialog") as unknown as HTMLDialogElement;
const accessibleName = (element: Element) => {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) return labelledBy.split(" ").map((id) => element.ownerDocument.getElementById(id)!.textContent).join(" ");
  const label = element.getAttribute("aria-label");
  if (label) return label;
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent!.replace(/\s+/g, " ").trim();
};
const watchButtons = (window: Window) => [...window.document.querySelectorAll("button.watch")] as unknown as HTMLButtonElement[];
const watchButton = (window: Window, title: string) => watchButtons(window).find((button) => accessibleName(button).endsWith(`the ${title} video`))!;
const pathOf = (window: Window, url: string) => new URL(url, window.location.href).pathname;
describe("the pack videos in a browser", () => {
  test("each Watch button is named for its length and pack, and opens one large player with that pack's name, line, video, poster and a link to its page as text", () => {
    const window = visit("packs/index.html");
    const player = video(window, "dialog video");
    const textOf = (attribute: string) => window.document.getElementById(dialog(window).getAttribute(attribute)!)!.textContent;
    const opened = watchButtons(window).map((button) => {
      const card = button.closest(".pack-card")!;
      const title = card.querySelector(".pack-name")!.textContent;
      button.click();
      const link = window.document.querySelector("dialog a") as unknown as HTMLAnchorElement;
      const shown = [accessibleName(button), button.closest("[hidden], [aria-hidden='true'], [inert]") === null, dialog(window).open, textOf("aria-labelledby") === title, textOf("aria-describedby") === card.querySelector(".pack-line")!.textContent, pathOf(window, player.src), pathOf(window, player.poster), player.paused, link.textContent === `Read how ${title} works`, pathOf(window, link.href) === pathOf(window, (card.querySelector("a.more") as unknown as HTMLAnchorElement).href)];
      (window.document.querySelector("dialog button") as unknown as HTMLButtonElement).click();
      return shown;
    });
    const row = (pack: string, name: string) => [name, true, true, true, true, `/hedge-engine/assets/video/${pack}.mp4`, `/hedge-engine/assets/video/${pack}.jpg`, false, true, true];
    expect(opened).toEqual([
      row("hub", "Watch · 29 s, the Hub video"),
      row("pull-requests", "Watch · 29 s, the Quality gates video"),
      row("orchestration", "Watch · 30 s, the Orchestration video"),
      row("memory", "Watch · 29 s, the Memory video"),
      row("slack", "Watch · 20 s, the Slack video"),
    ]);
    expect([dialog(window).open, player.paused, selected(window)]).toEqual([false, true, []]);
  });

  test("the Close button closes the player and stops the video", () => {
    const window = visit("packs/index.html");
    watchButton(window, "Memory").click();
    expect(video(window, "dialog video").paused).toBe(false);
    (window.document.querySelector("dialog button") as unknown as HTMLButtonElement).click();
    expect(dialog(window).open).toBe(false);
    expect(video(window, "dialog video").paused).toBe(true);
  });

  test("a visitor who asks for reduced motion gets the player without autoplay, and presses play", async () => {
    const window = visit("packs/index.html", { motion: "reduce" });
    watchButton(window, "Orchestration").click();
    await window.happyDOM.waitUntilComplete();
    const player = video(window, "dialog video");
    expect([dialog(window).open, player.paused, player.controls]).toEqual([true, true, true]);
    await player.play();
    expect(player.paused).toBe(false);
  });

  test("a pack page's video waits for the visitor to press play, even when it shows in full", async () => {
    const window = visit("packs/hub/index.html", { inView: true });
    window.dispatchEvent(new window.Event("scroll"));
    window.dispatchEvent(new window.Event("load"));
    await window.happyDOM.waitUntilComplete();
    expect(video(window, "video.clip").paused).toBe(true);
  });
});
