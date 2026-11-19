/// <reference lib="dom" />
import { installPrompt, startPrompt, startStatus, toggleSelected, toggleStart, type PromptData, type Start } from "./model.ts";
import { promptHtml, t3Link } from "./prompt.ts";

const selectionKey = "hedge-packs";
const dataNode = document.getElementById("hedge-data");
const data: PromptData | undefined = dataNode ? JSON.parse(dataNode.textContent!) : undefined;

function storedSelection(): string[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(selectionKey) ?? "[]");
    return Array.isArray(stored) ? stored.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function storeSelection(selected: string[]) {
  try {
    sessionStorage.setItem(selectionKey, JSON.stringify(selected));
  } catch {}
}

function showPrompt(id: string, text: string, status: string) {
  const pre = document.getElementById(`${id}-text`)!;
  pre.innerHTML = promptHtml(text, pre.textContent!.split("\n"));
  (document.getElementById(`${id}-t3`) as HTMLAnchorElement).href = t3Link(text);
  document.getElementById(`${id}-status`)!.textContent = status;
}

function chooser(form: HTMLFormElement, data: PromptData) {
  const switchOf = (pack: string) => form.elements.namedItem(`start:${pack}`) as HTMLInputElement | null;
  let start: Start = { off: data.startPacks.filter((pack) => switchOf(pack)?.checked === false) };

  const show = () => {
    for (const pack of data.startPacks) {
      const box = switchOf(pack);
      if (box) box.checked = !start.off.includes(pack);
    }
    showPrompt("start", startPrompt(data, start), startStatus(data, start));
  };

  form.addEventListener("change", (event) => {
    start = toggleStart(data, start, (event.target as HTMLInputElement).name.slice("start:".length));
    show();
  });
  show();
}

function picker(form: HTMLFormElement, data: PromptData) {
  const boxes = [...form.querySelectorAll<HTMLInputElement>('input[name="pack"]')];
  const stored = () => storedSelection().reduce((picked, name) => (picked.includes(name) ? picked : toggleSelected(data, picked, name)), [] as string[]);
  let selected = stored();

  const show = () => {
    for (const box of boxes) box.checked = selected.includes(box.value);
    storeSelection(selected);
    document.getElementById("install-empty")!.hidden = selected.length > 0;
    document.getElementById("install-full")!.hidden = selected.length === 0;
    const count = selected.length === 1 ? "1 pack selected" : `${selected.length} packs selected`;
    document.getElementById("install-count")!.textContent = count;
    const jump = document.getElementById("install-jump")!;
    jump.hidden = selected.length === 0;
    jump.textContent = `${count}. See the prompt`;
    showPrompt("install", installPrompt(data, selected), count);
  };

  form.addEventListener("change", (event) => {
    selected = toggleSelected(data, selected, (event.target as HTMLInputElement).value);
    show();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    selected = stored();
    show();
  });
  show();
}

function copyButtons() {
  document.addEventListener("click", async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-copy]");
    if (!button) return;
    const label = button.textContent!;
    try {
      await navigator.clipboard.writeText(document.getElementById(button.dataset.copy!)!.textContent!);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select the text and copy it";
    }
    setTimeout(() => (button.textContent = label), 1600);
  });
}

function selectLinks() {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-select]"))
    link.addEventListener("click", () => storeSelection([...new Set([...storedSelection(), link.dataset.select!])]));
}

function linksFromDisk() {
  if (location.protocol !== "file:") return;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="."], a[href$="/"]:not([href*=":"])'))
    link.setAttribute("href", link.getAttribute("href")!.replace(/\/(#.*)?$/, "/index.html$1"));
}

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const start = (video: HTMLVideoElement) => {
  if (!calm()) video.play().catch(() => {});
};

function player(dialog: HTMLDialogElement) {
  const video = dialog.querySelector("video")!;
  document.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-video]");
    if (!button) return;
    video.poster = button.dataset.poster!;
    video.src = button.dataset.video!;
    document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent = button.dataset.title!;
    document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent = button.dataset.line!;
    dialog.showModal();
    start(video);
  });
  dialog.querySelector(".player-close")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => video.pause());
}

function clips() {
  const videos = document.querySelectorAll<HTMLVideoElement>("video.clip");
  if (!videos.length || calm() || !("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target as HTMLVideoElement;
      if (entry.intersectionRatio >= 0.5) start(video);
      else video.pause();
    }
  }, { threshold: 0.5 });
  for (const video of videos) observer.observe(video);
}

const chooserForm = document.getElementById("chooser") as HTMLFormElement | null;
const pickerForm = document.getElementById("picker") as HTMLFormElement | null;
if (chooserForm && data) chooser(chooserForm, data);
if (pickerForm && data) picker(pickerForm, data);
const playerDialog = document.querySelector<HTMLDialogElement>("dialog.player");
if (playerDialog) player(playerDialog);
clips();
copyButtons();
selectLinks();
linksFromDisk();
