export type Tone = "blue" | "red" | "yellow" | "sky" | "peach" | "lilac" | "mint" | "cream";

export type Art = { file: string; alt: string };

export type Role = { art: Art; tone: Tone; line: string };

const hog = (name: string, alt = ""): Art => ({ file: `${name}.png`, alt });

export const packCast: Record<string, Role> = {
  base: { art: hog("list-hog"), tone: "cream", line: "Every box gets safety rules, the model table, and nightly updates." },
  "pull-requests": { art: hog("builder-hog-03"), tone: "yellow", line: "Every change passes proof, a second-model review and a QA swarm before it merges. Turn on a nightly loop, and it improves one area." },
  orchestration: { art: hog("professor-hog"), tone: "sky", line: "Big work becomes a map of tickets, one thread each." },
  communication: { art: hog("microphone-hog"), tone: "peach", line: "Agents write short, outcome-first updates in a voice you can make yours." },
  memory: { art: hog("reading-hog"), tone: "mint", line: "Every box reads what your agents learn and what you save. Turn on Dream, and it tidies the notes each night." },
  guards: { art: hog("police-hog"), tone: "lilac", line: "Hooks refuse risky shell commands and too-new packages." },
  slack: { art: hog("phone-pair-hogs"), tone: "cream", line: "Your own Slack message or reaction starts a thread." },
  "incident-io": { art: hog("warning-hog"), tone: "red", line: "An agent that watches a risky change rings your phone." },
  hub: { art: hog("space-hog"), tone: "sky", line: "The hub links your boxes and keeps your pack secrets. Turn on recovery, and it continues threads after a usage limit." },
  "mcp-gateway": { art: hog("hog-welder"), tone: "mint", line: "Sign in once on the hub. Every box reaches Slack, Gmail, and your MCP servers." },
  security: { art: hog("x-ray-hog"), tone: "blue", line: "Agents read your Wiz findings, and change nothing." },
};

export type Video = { file: string; poster: string; seconds: number };

const clip = (pack: string, seconds: number): Video => ({ file: `${pack}.mp4`, poster: `${pack}.jpg`, seconds });

export const packVideos: Record<string, Video> = {
  "pull-requests": clip("pull-requests", 28.5),
  orchestration: clip("orchestration", 30),
  memory: clip("memory", 29),
  hub: clip("hub", 28.5),
  slack: clip("slack", 20),
};

export const videoFiles = () => Object.values(packVideos).flatMap((video) => [video.file, video.poster]);

export const packGroups: Array<{ title: string; packs: string[] }> = [
  { title: "How your agents work", packs: ["pull-requests", "orchestration", "communication", "guards"] },
  { title: "What your agents know", packs: ["memory"] },
  { title: "What your agents reach", packs: ["slack", "incident-io", "mcp-gateway", "security"] },
];

export const teamRole = (line: string): Role => ({ art: hog("heart-hog"), tone: "yellow", line });

export const crew: Array<{ pack: string; says: string }> = [
  { pack: "orchestration", says: "4 threads running" },
  { pack: "pull-requests", says: "Draft PR is up" },
  { pack: "communication", says: "Update posted" },
];

export const scenes = {
  crew: "Three hedgehogs at work: a professor, a builder, and a reporter.",
  problems: [
    { art: hog("burning-money-hog"), tone: "peach" as Tone, title: "Every machine needs its own setup", line: "You add rules, skills, hooks, and sign-ins by hand." },
    { art: hog("surprised-hog"), tone: "sky" as Tone, title: "Your machines stop matching", line: "Your laptop knows a rule that your devbox does not." },
    { art: hog("sleeping-hog"), tone: "lilac" as Tone, title: "Agents stop when your Mac sleeps", line: "Work overnight needs a machine that stays on." },
  ],
  hedge: hog("robot-hog"),
  hub: hog("space-hog"),
  packs: hog("explorer-hog"),
  empty: hog("detective-hog"),
  lessons: hog("laptop-hog-02"),
};

export const logos = { light: "posthog-logo-light.svg", dark: "posthog-logo-dark.svg" };

export const artFiles = () => [
  ...new Set([
    ...Object.values(packCast).map((role) => role.art.file),
    teamRole("").art.file,
    ...scenes.problems.map((problem) => problem.art.file),
    ...[scenes.hedge, scenes.hub, scenes.packs, scenes.empty, scenes.lessons].map((art) => art.file),
    logos.light,
    logos.dark,
  ]),
];
