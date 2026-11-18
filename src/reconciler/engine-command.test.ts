import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { engineCommand, engineShellCommand } from "./engine-command.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

describe("a command from before the rename", () => {
  test("runs fleet as the engine's hedge launcher, in a job and in a shell line", () => {
    expect(engineCommand(["fleet", "update"], "/engine")).toEqual(["/bin/sh", "/engine/hedge", "update"]);
    expect(engineShellCommand("fleet login --web", "/engine")).toBe("/bin/sh '/engine/hedge' login --web");
    expect(engineCommand(["fleetwood"], "/engine")).toEqual(["fleetwood"]);
  });
});

describe("engineShellCommand", () => {
  test.each(["match$&engine", "two$$dollars", "quote's"])("runs the launcher of an engine at a path holding %s", (name) => {
    const root = join(temp.make("engine-"), name);
    mkdirSync(root);
    writeFileSync(join(root, "hedge"), 'printf "%s" "$*"\n');
    const shell = Bun.spawnSync(["sh", "-c", engineShellCommand("hedge login --web", root)]);
    expect({ code: shell.exitCode, output: shell.stdout.toString() }).toEqual({ code: 0, output: "login --web" });
  });
});
