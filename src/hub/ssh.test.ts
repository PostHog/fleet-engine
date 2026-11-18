import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { onHost } from "./ssh.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const engine = (home: string, path: string, name: string) => {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), `printf '%s %s %s\\n' ${name} "$FLEET_FORWARDED$HEDGE_FORWARDED" "$*"\n`);
};
const remote = (home: string) => Bun.spawnSync(["sh", "-c", onHost("node-1", ["doctor", "--json"]).at(-1)!], { env: { HOME: home, PATH: "/usr/bin:/bin" } }).stdout.toString();

test("a call to a machine that has not taken the rename yet runs its fleet launcher, marked as forwarded for either version", () => {
  const home = temp.make("home-");
  engine(home, ".local/share/fleet/engine/fleet", "fleet");
  expect(remote(home)).toBe("fleet 11 doctor --json\n");
});

test("a call to a machine with Hedge runs its hedge launcher", () => {
  const home = temp.make("home-");
  engine(home, ".local/share/fleet/engine/fleet", "fleet");
  engine(home, ".local/share/hedge/engine/hedge", "hedge");
  expect(remote(home)).toBe("hedge 11 doctor --json\n");
});
