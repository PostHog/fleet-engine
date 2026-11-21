import { join } from "node:path";
import { parseLesson, sentences, type BuiltLesson } from "../../page/lessons.ts";
import { narrationHash } from "../../scripts/lessons.ts";

export const testVoice = JSON.stringify({ voice: "tour-voice", model: "tour-model", seed: 1, settings: {}, pauses: { colon: 0.1, sentence: 0.2, chapter: 1 } });

export const lessonMedia = join(import.meta.dir, "fixtures/lessons");

export const tourSource = `---
title: The tour
shelf: start
for: Anyone who starts.
after: You know the tour.
---

## The first stop

You open the inbox. A card waits: you answer it.

## The second stop

Run \`hedge doctor\` when something looks wrong.
`;

export function builtLesson(id = "tour", source = tourSource): BuiltLesson {
  const lesson = parseLesson(id, source);
  return {
    ...lesson,
    cut: { video: `${id}-take.mp4`, poster: `${id}-take.jpg`, seconds: 150, narration: narrationHash(lesson, testVoice), chapters: lesson.chapters.map((_, index) => index * 65), captions: sentences(lesson).map((_, index) => [index * 5, index * 5 + 4]) },
  };
}

export const withLessons = () => ({ lessons: [builtLesson()], lessonMedia });
