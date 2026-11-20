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

type Visit = { from?: Window; files?: SiteFiles; url?: string };

function visit(path: string, { from, files = site, url = `https://hedge.test/hedge-engine/${path.replace(/index\.html$/, "")}` }: Visit = {}) {
  const window = new Window({ url, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  open.push(window);
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

  test("ticking a team pack adds to the command each pack its card says it adds, also a pack with no card, and unticking it takes them back", async () => {
    const needy: LoadedPack = { dir: "/team/packs/acme", manifest: { schema: 1, name: "acme", summary: "A team pack.", requires: ["integrations", "context-library", "gone"] } };
    const team = visit("packs/index.html", { files: await buildSite({ audience: "posthog", team: [needy] }) });
    input(team, "#pick-acme").click();
    expect(selected(team)).toEqual(["memory", "acme"]);
    expect([text(team, "install-count"), command(team)]).toEqual(["4 packs selected", "hedge packs --add integrations --add gone --add memory --add acme"]);
    input(team, "#pick-acme").click();
    input(team, "#pick-memory").click();
    expect([shown(team, "install-empty"), shown(team, "install-full")]).toEqual([true, false]);
  });

  test("ticking a team pack that requires a hidden helper adds the helper and each pack the helper requires to the command", async () => {
    const acme: LoadedPack = { dir: "/team/packs/acme", manifest: { schema: 1, name: "acme", summary: "A team pack.", requires: ["helper"] } };
    const helper: LoadedPack = { dir: "/team/packs/helper", manifest: { schema: 1, name: "helper", summary: "A hidden helper.", onSite: false, requires: ["context-library"] } };
    const team = visit("packs/index.html", { files: await buildSite({ audience: "posthog", team: [acme, helper] }) });
    input(team, "#pick-acme").click();
    expect(selected(team)).toEqual(["memory", "acme"]);
    expect(command(team)).toBe("hedge packs --add helper --add memory --add acme");
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
