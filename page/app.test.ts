import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { LoadedPack } from "../src/pack/types.ts";
import { buildSite, type SiteFiles } from "../scripts/build-page.ts";

const teamPack: LoadedPack = { dir: "/team/packs/acme", manifest: { schema: 1, name: "acme", summary: "A team pack." } };

let site: SiteFiles;
let teamSite: SiteFiles;
beforeAll(async () => {
  site = await buildSite({ audience: "public" });
  teamSite = await buildSite({ audience: "posthog", team: [teamPack] });
});

const open: Window[] = [];
afterEach(async () => {
  for (const window of open.splice(0)) await window.happyDOM.close();
});

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
      const shown = [accessibleName(button), dialog(window).open, textOf("aria-labelledby") === title, textOf("aria-describedby") === card.querySelector(".pack-line")!.textContent, pathOf(window, player.src), pathOf(window, player.poster), player.paused, link.textContent === `Read how ${title} works`, pathOf(window, link.href) === pathOf(window, (card.querySelector("a.more") as unknown as HTMLAnchorElement).href)];
      (window.document.querySelector("dialog button") as unknown as HTMLButtonElement).click();
      return shown;
    });
    const row = (pack: string, name: string) => [name, true, true, true, `/hedge-engine/assets/video/${pack}.mp4`, `/hedge-engine/assets/video/${pack}.jpg`, false, true, true];
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

  test("a click on the dark area around the player closes it and stops the video, and a click inside it does not", () => {
    const window = visit("packs/index.html");
    watchButton(window, "Slack").click();
    video(window, "dialog video").click();
    expect([dialog(window).open, video(window, "dialog video").paused]).toEqual([true, false]);
    (dialog(window) as unknown as HTMLElement).click();
    expect([dialog(window).open, video(window, "dialog video").paused]).toEqual([false, true]);
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
