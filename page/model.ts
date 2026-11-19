import type { Need, PackSetting } from "../src/pack/types.ts";

export type PageWorkflow = { id: string; name: string; sentence: string; needs: Need[]; default: boolean; risk?: string };

export type PromptPack = { name: string; title: string; requires: string[]; always: boolean; setupNote?: string };

export type PagePack = PromptPack & { summary: string; cost?: string; risk?: string; workflows: PageWorkflow[]; settings: PackSetting[] };

export type PromptData<Pack extends PromptPack = PromptPack> = {
  engineRepo: string;
  packs: Pack[];
  teamPacks: string[];
  startPacks: string[];
  hubStartPacks: string[];
  needsHubPacks: string[];
};

export type PageData = PromptData<PagePack> & { needLabels: Partial<Record<Need, string>> };

export type Start = { off: string[] };

export const firstStart: Start = { off: [] };

export const promptLabels = {
  intro: "My picks from the Hedge page:",
  firstPacks: "Packs on the first setup",
  laterPacks: "Packs once the hub runs",
};

export const noPack = "none";

export const listed = (words: string[]) => (words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`);

export function promptData(data: PromptData): PromptData {
  const { engineRepo, teamPacks, startPacks, hubStartPacks, needsHubPacks } = data;
  const packs = data.packs.map(({ name, title, requires, always, setupNote }) => ({ name, title, requires, always, ...(setupNote ? { setupNote } : {}) }));
  return { engineRepo, packs, teamPacks, startPacks, hubStartPacks, needsHubPacks };
}

function inPageOrder(data: PromptData, names: Iterable<string>) {
  const wanted = new Set(names);
  return data.packs.map((pack) => pack.name).filter((name) => wanted.has(name));
}

export function toggleSelected(data: PromptData, selected: string[], name: string): string[] {
  const packs = new Set(selected);
  const drop = (target: string) => {
    packs.delete(target);
    for (const pack of data.packs) if (packs.has(pack.name) && pack.requires.includes(target)) drop(pack.name);
  };
  const add = (target: string) => {
    const pack = data.packs.find((item) => item.name === target);
    if (!pack || pack.always || packs.has(target)) return;
    packs.add(target);
    pack.requires.forEach(add);
  };
  if (packs.has(name)) drop(name);
  else add(name);
  return inPageOrder(data, packs);
}

export const startPacksOn = (data: PromptData, start: Start) => data.startPacks.filter((name) => !start.off.includes(name));

export function toggleStart(data: PromptData, start: Start, name: string): Start {
  if (!data.startPacks.includes(name)) return start;
  const on = toggleSelected(data, startPacksOn(data, start), name);
  return { ...start, off: data.startPacks.filter((pack) => !on.includes(pack)) };
}

export function setupSplit(data: PromptData, start: Start) {
  return { first: inPageOrder(data, [...startPacksOn(data, start), ...data.teamPacks]), later: inPageOrder(data, data.hubStartPacks) };
}

export function startPrompt(data: PromptData, start: Start) {
  const { first, later } = setupSplit(data, start);
  return [
    `Set up Hedge with me. Read https://raw.githubusercontent.com/${data.engineRepo}/main/SETUP.md and follow it step by step.`,
    "",
    promptLabels.intro,
    `- ${promptLabels.firstPacks}: ${first.join(", ") || noPack}`,
    `- ${promptLabels.laterPacks}: ${later.join(", ") || noPack}`,
  ].join("\n");
}

export const startStatus = (data: PromptData, start: Start) => {
  const { first } = setupSplit(data, start);
  return `The prompt now sets up ${first.length ? listed(first) : "no pack"} first.`;
};

export const installCommand = (selected: string[]) => `hedge packs ${selected.map((name) => `--add ${name}`).join(" ")}`;

function findHub(guide: string, notes: boolean) {
  return `Find my hub. List my cloud boxes as step 1 of ${guide} does, and run \`hedge hub status\` over SSH on each one that runs, until one names the hub. Do not ask a \`hedge\` on this Mac: an earlier setup can leave one here. The name after "The hub:" is the SSH name of the hub. ${notes ? "Use it as `<hub>` in each SSH command of a note. " : ""}When every box prints "The hub: not named", or no box runs Hedge, I have no hub yet. Tell me, and offer to set one up first with steps 5, 7, and 9 of ${guide}. To make a box that already runs Hedge the hub, skip step 5 for it.`;
}

function noteStep(notes: PromptPack[]) {
  const source = notes.some((pack) => pack.setupNote!.includes("<source>")) ? ["   `<source>` is the folder in `~/.local/share/hedge/sources` that holds the pack."] : [];
  return [
    'Read the setup note of each pack. Ask me what it asks, and collect the flags that it names. Where a note names "the setup command" or "the command in item 2 of step 9", use the `hedge packs` command of this prompt. Do not run a step that a note puts after that command yet.',
    ...notes.map((pack) => `   - ${pack.title}: ${pack.setupNote}`),
    ...source,
  ].join("\n");
}

export function installPrompt(data: PromptData, selected: string[]) {
  const packs = data.packs.filter((pack) => selected.includes(pack.name));
  if (!packs.length) return "";
  const guide = `https://raw.githubusercontent.com/${data.engineRepo}/main/SETUP.md`;
  const notes = packs.filter((pack) => pack.setupNote);
  const steps = [
    findHub(guide, notes.length > 0),
    "Run `hedge update` on the hub, so it has the newest engine and packs. Then run `hedge packs` there, and leave out each pack that is already on.",
    ...(notes.length ? [noteStep(notes)] : []),
    `Turn the packs on with one command on the hub${notes.length ? ", and add the flags that the notes name" : ""}:\n   ${installCommand(packs.map((pack) => pack.name))}`,
    ...(notes.length ? ["Do the steps that each note puts after the command."] : []),
    "Run `hedge doctor` on the hub, and explain each line. Do each `To do:` line with me, and say what a sign-in is for before it opens.",
    "My nodes take the change at their next `hedge update`. To give it to one now, run `hedge update` there.",
  ];
  return [
    `Add ${packs.length === 1 ? "this Hedge pack" : "these Hedge packs"} to my setup with me: ${listed(packs.map((pack) => pack.title))}.`,
    "",
    `Hedge runs on my hub and my nodes in the cloud, not on my Mac. Run each command of this prompt on the hub, over SSH with the \`PATH\` line of ${guide} when you run elsewhere. Install nothing from Hedge here. Ask me each choice with your question tool, and run every command yourself.`,
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ].join("\n");
}
