import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { narration, parseLesson, sentences, type Cut, type Lesson } from "../page/lessons.ts";
import { builtins } from "../src/cli.ts";
import type { LoadedPack } from "../src/pack/types.ts";
import { packTitle } from "../src/setup/questions.ts";

export const narrationHash = (lesson: Lesson) => new Bun.CryptoHasher("sha256").update(narration(lesson)).digest("hex");

export function loadLessons(root: string): Lesson[] {
  const dir = join(root, "lessons");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const id = file.slice(0, -3);
      const lesson = parseLesson(id, readFileSync(join(dir, file), "utf8"));
      const cutFile = join(dir, `${id}.cut.json`);
      return existsSync(cutFile) ? { ...lesson, cut: JSON.parse(readFileSync(cutFile, "utf8")) as Cut } : lesson;
    });
}

export type Names = { skills: string[]; commands: string[]; packs: string[]; lessons: string[] };

export function knownNames(packs: LoadedPack[], lessons: Lesson[]): Names {
  const packCommands = packs.flatMap((pack) => {
    const dir = join(pack.dir, "commands");
    const files = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).map((file) => file.slice(0, -3)) : [];
    return [...files, ...Object.keys(pack.code?.commands ?? {})];
  });
  return {
    skills: packs.flatMap((pack) => (pack.manifest.skills ?? []).map((path) => path.split("/").at(-1)!)),
    commands: [...Object.keys(builtins), "refresh", ...packCommands],
    packs: packs.flatMap((pack) => [pack.manifest.name, packTitle(pack.manifest).toLowerCase()]),
    lessons: lessons.map((lesson) => lesson.id),
  };
}

export function lessonProblems(lesson: Lesson, names: Names): string[] {
  const where = `lessons/${lesson.id}.md`;
  const text = lesson.chapters.map((chapter) => `${chapter.headline}\n${chapter.text}`).join("\n");
  const problems = [
    ...[...text.matchAll(/`hedge ([a-z][a-z-]*)/g)].filter(([, name]) => !names.commands.includes(name!)).map(([, name]) => `${where}: names hedge ${name}, which no command ships`),
    ...[...text.matchAll(/`\/([a-z][a-z-]*)`/g)].filter(([, name]) => !names.skills.includes(name!)).map(([, name]) => `${where}: names /${name}, which no pack's skill ships`),
    ...[...text.matchAll(/the ([A-Z][A-Za-z.]*(?: [A-Z][A-Za-z.]*)*) pack\b/g)].filter(([, title]) => !names.packs.includes(title!.toLowerCase())).map(([, title]) => `${where}: names the ${title} pack, which does not exist`),
    ...(lesson.next && !names.lessons.includes(lesson.next) ? [`${where}: next names lesson ${lesson.next}, which does not exist`] : []),
  ];
  if (!lesson.cut) return problems;
  const cut = lesson.cut;
  if (cut.narration !== narrationHash(lesson)) problems.push(`${where}: the narration changed after its cut. Render the lesson again`);
  if (cut.chapters.length !== lesson.chapters.length) problems.push(`${where}: has ${lesson.chapters.length} chapters, but its cut has ${cut.chapters.length}`);
  if (cut.captions.length !== sentences(lesson).length) problems.push(`${where}: has ${sentences(lesson).length} sentences, but its cut has ${cut.captions.length} captions`);
  return problems;
}
