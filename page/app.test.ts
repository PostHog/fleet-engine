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

type Visit = { from?: Window; files?: SiteFiles; url?: string; motion?: "reduce" | "no-preference" };

type Entry = { target: unknown; isIntersecting: boolean; intersectionRatio: number };
type Watched = { callback: (entries: Entry[]) => void; thresholds: number[]; states: Map<unknown, string>; observed: unknown[] };
type View = { shown: number; watched: Watched[] };
const views = new WeakMap<Window, View>();
const stateOf = (watch: Watched, shown: number) => `${shown > 0}:${watch.thresholds.filter((threshold) => shown > 0 && shown >= threshold).length}`;
const deliver = (watch: Watched, targets: unknown[], shown: number) => {
  if (targets.length) watch.callback(targets.map((target) => ({ target, isIntersecting: shown > 0, intersectionRatio: shown })));
};

function visit(path: string, { from, files = site, url = `https://hedge.test/hedge-engine/${path.replace(/index\.html$/, "")}`, motion = "no-preference" }: Visit = {}) {
  const window = new Window({ url, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, device: { prefersReducedMotion: motion } } });
  open.push(window);
  const view: View = { shown: 0, watched: [] };
  views.set(window, view);
  Object.assign(window, {
    IntersectionObserver: class {
      watch: Watched;
      constructor(callback: Watched["callback"], options: { threshold?: number | number[] } = {}) {
        this.watch = { callback, thresholds: [options.threshold ?? 0].flat(), states: new Map(), observed: [] };
        view.watched.push(this.watch);
      }
      observe(target: unknown) {
        this.watch.observed.push(target);
        this.watch.states.set(target, stateOf(this.watch, view.shown));
        deliver(this.watch, [target], view.shown);
      }
      unobserve(target: unknown) {
        this.watch.states.delete(target);
      }
      disconnect() {
        this.watch.states.clear();
      }
    },
  });
  if (from) carryStorage(from, window);
  window.document.addEventListener("click", (event) => {
    if ((event.target as unknown as Element).closest("a")) event.preventDefault();
  });
  window.document.write(files[path] as string);
  return window;
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
const plays = (clip: HTMLVideoElement, seconds: number) => {
  clip.play();
  clip.currentTime += seconds;
};
const pathOf = (window: Window, url: string) => new URL(url, window.location.href).pathname;
const queuedEarlier = (window: Window, shown: number) => {
  for (const watch of views.get(window)!.watched) deliver(watch, watch.observed, shown);
};
const scrollTo = (window: Window, shown: number) => {
  const view = views.get(window)!;
  view.shown = shown;
  for (const watch of view.watched) {
    const changed = [...watch.states].filter(([, state]) => state !== stateOf(watch, shown)).map(([target]) => target);
    for (const target of changed) watch.states.set(target, stateOf(watch, shown));
    deliver(watch, changed, shown);
  }
};

describe("the pack videos in a browser", () => {
  test("each Watch button is named for its length and pack, and opens one large player with that pack's name, line, video and poster", () => {
    const window = visit("packs/index.html");
    const player = video(window, "dialog video");
    const textOf = (attribute: string) => window.document.getElementById(dialog(window).getAttribute(attribute)!)!.textContent;
    const opened = watchButtons(window).map((button) => {
      const card = button.closest(".pack-card")!;
      const title = card.querySelector(".pack-name")!.textContent;
      button.click();
      const shown = [accessibleName(button), dialog(window).open, textOf("aria-labelledby") === title, textOf("aria-describedby") === card.querySelector(".pack-line")!.textContent, pathOf(window, player.src), pathOf(window, player.poster), player.paused];
      (window.document.querySelector("dialog button") as unknown as HTMLButtonElement).click();
      return shown;
    });
    const row = (pack: string, name: string) => [name, true, true, true, `/hedge-engine/assets/video/${pack}.mp4`, `/hedge-engine/assets/video/${pack}.jpg`, false];
    expect(opened).toEqual([
      row("hub", "Watch · 29 s, the Hub video"),
      row("pull-requests", "Watch · 29 s, the Quality gates video"),
      row("orchestration", "Watch · 30 s, the Orchestration video"),
      row("memory", "Watch · 29 s, the Memory video"),
      row("slack", "Watch · 20 s, the Slack video"),
    ]);
    expect([dialog(window).open, player.paused, selected(window)]).toEqual([false, true, []]);
  });

  test("closing the player in any way, such as with Escape, stops the video", () => {
    const window = visit("packs/index.html");
    watchButton(window, "Memory").click();
    expect(video(window, "dialog video").paused).toBe(false);
    dialog(window).close();
    expect(video(window, "dialog video").paused).toBe(true);
  });

  test("a visitor who asks for reduced motion gets the player and the pack page's video without autoplay", () => {
    const packs = visit("packs/index.html", { motion: "reduce" });
    watchButton(packs, "Orchestration").click();
    expect([dialog(packs).open, video(packs, "dialog video").paused]).toEqual([true, true]);
    const page = visit("packs/orchestration/index.html", { motion: "reduce" });
    scrollTo(page, 1);
    expect(video(page, "video.clip").paused).toBe(true);
  });

  test("a pack page's video starts once at least half of it is in view, and then only the visitor plays or pauses it", () => {
    const window = visit("packs/hub/index.html");
    const clip = video(window, "video.clip");
    expect(clip.paused).toBe(true);
    scrollTo(window, 0.1);
    expect(clip.paused).toBe(true);
    scrollTo(window, 0.6);
    expect(clip.paused).toBe(false);
    scrollTo(window, 0);
    expect(clip.paused).toBe(false);
    clip.pause();
    scrollTo(window, 1);
    expect(clip.paused).toBe(true);
  });

  test("a pack page's video that the visitor paused at once, before it moved, stays paused when they scroll away and back", () => {
    const window = visit("packs/hub/index.html");
    const clip = video(window, "video.clip");
    scrollTo(window, 1);
    clip.pause();
    scrollTo(window, 0);
    scrollTo(window, 1);
    expect([clip.paused, clip.currentTime]).toEqual([true, 0]);
  });

  test("a pack page's video that the visitor played and paused before it started on its own stays paused when they scroll to it", () => {
    const window = visit("packs/hub/index.html");
    const clip = video(window, "video.clip");
    scrollTo(window, 0.4);
    plays(clip, 1);
    clip.pause();
    scrollTo(window, 0.6);
    expect(clip.paused).toBe(true);
  });

  test("a pack page's video that the visitor played and paused before its first frame, while less than half showed, stays paused when they scroll to it", () => {
    const window = visit("packs/hub/index.html");
    const clip = video(window, "video.clip");
    scrollTo(window, 0.4);
    clip.play();
    clip.pause();
    scrollTo(window, 0.6);
    expect([clip.paused, clip.currentTime]).toEqual([true, 0]);
  });

  test("a pack page's video that the visitor played and paused stays paused when a visibility entry that the browser queued earlier arrives", () => {
    const window = visit("packs/hub/index.html");
    const clip = video(window, "video.clip");
    scrollTo(window, 0.4);
    clip.play();
    clip.pause();
    queuedEarlier(window, 0.6);
    expect(clip.paused).toBe(true);
  });
});
