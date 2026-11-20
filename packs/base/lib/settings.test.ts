import { expect, test } from "bun:test";
import { numberSetting, optionalStringSetting, stringSetting } from "./settings.ts";

const env = { HEDGE_SETTINGS: JSON.stringify({ "base.heavySlots": 3, "orchestration.mapTracker": "me/hedge-profile" }) };

test("reads a typed setting that the plan resolved", () => {
  expect(numberSetting("base.heavySlots", env)).toBe(3);
  expect(stringSetting("orchestration.mapTracker", env)).toBe("me/hedge-profile");
});

test("refuses a setting that no enabled pack declares, or one of the wrong type", () => {
  expect(() => numberSetting("base.missing", env)).toThrow("setting base.missing is not declared by an enabled pack");
  expect(() => stringSetting("base.heavySlots", env)).toThrow("setting base.heavySlots is a number, not a string");
});

test("says how to run a command outside hedge", () => {
  expect(() => numberSetting("base.heavySlots", {})).toThrow("run this command as hedge <command>, so it gets your settings");
});

test("reads an optional setting as undefined when the profile leaves it unset", () => {
  expect(optionalStringSetting("orchestration.mapTracker", env)).toBe("me/hedge-profile");
  expect(optionalStringSetting("orchestration.unset", env)).toBeUndefined();
  expect(() => optionalStringSetting("base.heavySlots", env)).toThrow("setting base.heavySlots is a number, not a string");
  expect(() => optionalStringSetting("orchestration.unset", {})).toThrow("run this command as hedge <command>, so it gets your settings");
});
