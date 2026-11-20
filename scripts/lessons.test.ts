import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captions, parseLesson, type Lesson } from "../page/lessons.ts";
import { loadPacks } from "../src/pack/manifest.ts";
import { builtLesson, lessonMedia, tourSource } from "../src/testing/lessons.ts";
import { buildSite, type SiteFiles } from "./build-page.ts";
import { knownNames, lessonProblems, loadLessons, type Names } from "./lessons.ts";

const root = join(import.meta.dir, "..");
let names: Names;
let site: SiteFiles;
beforeAll(async () => {
  names = knownNames(await loadPacks(root), loadLessons(root));
  site = await buildSite({ audience: "public", lessons: [builtLesson("tour", tourSource.replace("for: Anyone who starts.", "for: Anyone who starts.\nnext: tour"))], lessonMedia });
});

const withText = (text: string) => parseLesson("probe", `---\ntitle: Probe\nshelf: build\nfor: Tests.\nafter: Nothing.\n---\n\n## One\n\n${text}\n`);
const page = (path: string) => site[path] as string;

describe("lessons", () => {
  test("every lesson in the repository names only commands, skills, packs, and lessons that exist, and its cut matches its narration", () => {
    const lessons = loadLessons(root);
    expect(lessons.map((lesson) => lesson.id)).toContain("what-hedge-is");
    expect(lessons.flatMap((lesson) => lessonProblems(lesson, names))).toEqual([]);
  });

  test("the check fails a lesson that names a hedge command, a skill, a pack, or a next lesson that does not exist", () => {
    const known = withText("Run `hedge doctor`, then `hedge prune`. Say `/qa-swarm`. Turn on the Slack pack and the Quality gates pack.");
    expect(lessonProblems(known, names)).toEqual([]);
    const unknown: Lesson = { ...withText("Run `hedge teleport`. Say `/fly`. Turn on the Rocket pack."), next: "gone" };
    expect(lessonProblems(unknown, names)).toEqual([
      "lessons/probe.md: names hedge teleport, which no command ships",
      "lessons/probe.md: names /fly, which no pack's skill ships",
      "lessons/probe.md: names the Rocket pack, which does not exist",
      "lessons/probe.md: next names lesson gone, which does not exist",
    ]);
  });

  test("the check fails a cut whose narration, chapters, or captions no longer match the lesson", () => {
    const built = builtLesson();
    expect(lessonProblems(built, names)).toEqual([]);
    const edited = { ...built, chapters: [...built.chapters.slice(0, 1), { headline: "The second stop", text: "Run `hedge doctor` now." }] };
    expect(lessonProblems(edited, names)).toEqual(["lessons/tour.md: the narration changed after its cut. Render the lesson again"]);
    const short = { ...built, cut: { ...built.cut, chapters: [0], captions: [[0, 1] as [number, number]] } };
    expect(lessonProblems(short, names)).toEqual(["lessons/tour.md: has 2 chapters, but its cut has 1", "lessons/tour.md: has 4 sentences, but its cut has 1 captions"]);
  });

  test("a lesson source needs its front matter, a known shelf, and chapters with narration", () => {
    expect(() => parseLesson("bad", "## One\n\nText.")).toThrow("lessons/bad.md: starts with front matter between --- lines");
    expect(() => parseLesson("bad", tourSource.replace("shelf: start", "shelf: attic"))).toThrow("lessons/bad.md: shelf is one of start, build, live");
    expect(() => parseLesson("bad", tourSource.replace("title: The tour", "colour: red"))).toThrow('lessons/bad.md: unknown front matter line "colour: red"');
    expect(() => parseLesson("bad", tourSource.split("## ")[0]!)).toThrow("lessons/bad.md: needs chapters, each a ## headline over its narration");
  });

  test("the captions give each sentence of the narration its own cue, at the times of the cut", () => {
    expect(captions(builtLesson()).split("\n\n")).toEqual([
      "WEBVTT",
      "00:00:00.000 --> 00:00:04.000\nYou open the inbox.",
      "00:00:05.000 --> 00:00:09.000\nA card waits:",
      "00:00:10.000 --> 00:00:14.000\nyou answer it.",
      "00:00:15.000 --> 00:00:19.000\nRun `hedge doctor` when something looks wrong.\n",
    ]);
  });
});

describe("the lessons on the site", () => {
  test("the landing page shows the lessons of Start here, links the library, and offers the first lesson beside the Getting started prompt", () => {
    const html = page("index.html");
    expect(html).toContain('<a href="./learn/">Learn</a>');
    const band = html.match(/<section class="band" aria-labelledby="learn-h">[\s\S]*?<\/section>/)![0];
    expect(band).toContain('href="./learn/tour/"');
    expect(band).toContain('src="./assets/lessons/tour.jpg"');
    expect(band).toContain('href="./learn/"');
    expect(html.indexOf("learn-h")).toBeLessThan(html.indexOf('id="start"'));
    expect(html.slice(html.indexOf('id="start"'))).toMatch(/<a class="link-arrow" href="learn\/tour\/">Watch while it runs: The tour · 3 min/);
  });

  test("a lesson page plays the video with its captions, lists the chapters at their times, prints the narration under each headline, and links the next lesson", () => {
    const html = page("learn/tour/index.html");
    expect(html).toContain('<video id="lesson-video" class="clip" src="../../assets/lessons/tour.mp4" poster="../../assets/lessons/tour.jpg"');
    expect(html).toContain('<track kind="captions" srclang="en" label="English" src="../../assets/lessons/tour.vtt">');
    expect([...html.matchAll(/data-seek="([\d.]+)"><span class="at">([^<]+)<\/span>([^<]+)</g)].map((match) => match.slice(1))).toEqual([
      ["0", "0:00", "The first stop"],
      ["65", "1:05", "The second stop"],
    ]);
    expect(html).toContain('<h3 id="chapter-2">The second stop</h3><p>Run <code>hedge doctor</code> when something looks wrong.</p>');
    expect(html).toContain('href="../tour/">Next lesson: The tour');
  });

  test("a build ships each lesson's video, poster and captions, and refuses media it cannot find", async () => {
    expect(Buffer.from(site["assets/lessons/tour.mp4"] as Uint8Array).equals(readFileSync(join(lessonMedia, "tour.mp4")))).toBe(true);
    expect(site["assets/lessons/tour.vtt"]).toBe(captions(builtLesson()));
    expect(buildSite({ audience: "public", lessons: [builtLesson("gone")], lessonMedia })).rejects.toThrow(`lesson media gone.mp4 is missing from ${lessonMedia}. Download the lessons release first`);
  });

  test("without a built lesson, the site has no Learn link, no lesson band, and no lesson route", async () => {
    const bare = await buildSite({ audience: "public", lessons: [] });
    expect(Object.keys(bare).filter((path) => path.startsWith("learn/") || path.startsWith("assets/lessons/"))).toEqual([]);
    expect(bare["index.html"]).not.toMatch(/learn\/|learn-h/);
  });
});
