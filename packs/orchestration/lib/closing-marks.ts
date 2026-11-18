import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Park = "wait" | "snooze" | "check" | "done";
export type Marks = Record<Park, string>;
export type Parking = { waitSnoozeDays: number; timeZone: string };
export type ClosingSettings = { marks: Marks; parking?: Parking };

export const defaultMarks: Marks = { wait: "⏳", snooze: "💤", check: "🔕", done: "➡️" };

const parks: Park[] = ["wait", "snooze", "check", "done"];
const markKeys: Marks = { wait: "orchestration.waitMark", snooze: "orchestration.snoozeMark", check: "orchestration.checkMark", done: "orchestration.doneMark" };

function snapshot(home: string): Record<string, unknown> {
  try {
    const settings: unknown = JSON.parse(readFileSync(join(home, ".local/state/fleet/settings.json"), "utf8"));
    return typeof settings === "object" && settings !== null && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function closingSettings(home: string): ClosingSettings {
  const settings = snapshot(home);
  const text = (key: string) => (typeof settings[key] === "string" ? (settings[key] as string).trim() : "");
  const marks = Object.fromEntries(parks.map((park) => [park, text(markKeys[park]) || defaultMarks[park]])) as Marks;
  const days = settings["orchestration.waitSnoozeDays"];
  if (typeof days !== "number" || !(days > 0)) return { marks };
  return { marks, parking: { waitSnoozeDays: days, timeZone: text("orchestration.timeZone") || localZone() } };
}

const plain = (text: string) => text.replaceAll("\uFE0F", "");

export const closingLine = (message: string) => message.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";

export function closingPark(message: string, marks: Marks): Park | undefined {
  const line = plain(closingLine(message));
  return parks.find((park) => line.startsWith(plain(marks[park])));
}

export const closesOn = (message: string, marks: Marks, among: Park[]) => among.includes(closingPark(message, marks) as Park);

