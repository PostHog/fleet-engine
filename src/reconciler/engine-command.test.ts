import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { engineCommand, engineShellCommand } from "./engine-command.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

describe("a command from before the rename", () => {
  test("runs fleet as the engine's hedge launcher, in a job and in a shell line, and leaves a longer name alone", () => {
    const root = temp.make("engine-");
    writeFileSync(join(root, "hedge"), 'printf "hedge %s" "$*"\nexit 3\n');
    const ran = (result: { exitCode: number; stdout: Buffer }) => ({ code: result.exitCode, output: result.stdout.toString() });
    expect(ran(Bun.spawnSync(engineCommand(["fleet", "update"], root)))).toEqual({ code: 3, output: "hedge update" });
    expect(ran(Bun.spawnSync(["sh", "-c", engineShellCommand("fleet login --web", root)]))).toEqual({ code: 3, output: "hedge login --web" });
    expect(engineCommand(["fleetwood"], root)).toEqual(["fleetwood"]);
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
