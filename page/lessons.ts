export const shelves = [
  { id: "start", title: "Start here" },
  { id: "build", title: "Build and ship" },
  { id: "live", title: "Live with Hedge" },
] as const;

export type Shelf = (typeof shelves)[number]["id"];

export type Chapter = { headline: string; text: string };

export type Cut = { video: string; poster: string; seconds: number; narration: string; chapters: number[]; captions: Array<[number, number]> };

export type Lesson = { id: string; title: string; shelf: Shelf; for: string; after: string; next?: string; chapters: Chapter[]; cut?: Cut };

export type BuiltLesson = Lesson & { cut: Cut };

const fields = ["title", "shelf", "for", "after", "next"] as const;

export function parseLesson(id: string, source: string): Lesson {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`lessons/${id}.md: starts with front matter between --- lines`);
  const front: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const [, key, value] = line.match(/^([a-z]+): (.+)$/) ?? [];
    if (!key || !fields.includes(key as (typeof fields)[number])) throw new Error(`lessons/${id}.md: unknown front matter line "${line}"`);
    front[key] = value!.trim();
  }
  for (const key of ["title", "shelf", "for", "after"]) if (!front[key]) throw new Error(`lessons/${id}.md: needs ${key}`);
  if (!shelves.some((shelf) => shelf.id === front.shelf)) throw new Error(`lessons/${id}.md: shelf is one of ${shelves.map((shelf) => shelf.id).join(", ")}`);
  const chapters = match[2]!.split(/^## /m).slice(1).map((block) => {
    const [headline, ...body] = block.trim().split("\n");
    return { headline: headline!.trim(), text: body.map((line) => line.trim()).filter(Boolean).join(" ") };
  });
  if (!chapters.length || chapters.some((chapter) => !chapter.text)) throw new Error(`lessons/${id}.md: needs chapters, each a ## headline over its narration`);
  return { id, title: front.title!, shelf: front.shelf as Shelf, for: front.for!, after: front.after!, ...(front.next ? { next: front.next } : {}), chapters };
}

export const narration = (lesson: Lesson) => lesson.chapters.map((chapter) => chapter.text).join("\n\n");

export const sentences = (lesson: Lesson) => lesson.chapters.flatMap((chapter) => chapter.text.split(/(?<=[.:])\s+/));

export const isBuilt = (lesson: Lesson): lesson is BuiltLesson => lesson.cut !== undefined;

export const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))} min`;

const stamp = (seconds: number) => {
  const whole = Math.round(seconds * 1000);
  const part = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${part(Math.floor(whole / 3600000))}:${part(Math.floor(whole / 60000) % 60)}:${part(Math.floor(whole / 1000) % 60)}.${part(whole % 1000, 3)}`;
};

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export const captions = (lesson: BuiltLesson) =>
  ["WEBVTT", ...sentences(lesson).map((line, index) => `${stamp(lesson.cut.captions[index]![0])} --> ${stamp(lesson.cut.captions[index]![1])}\n${line}`)].join("\n\n") + "\n";
