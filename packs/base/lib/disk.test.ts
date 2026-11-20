import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { diskStatus, startDecision } from "./disk.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const gigabyte = 1024 ** 3;

test("calls the disk critical below the floor, or below 10% of free inodes though bytes remain", () => {
  expect(diskStatus({ bytes: 25 * gigabyte, inodes: 0.5 }, 20)).toEqual({ critical: false, message: "Disk: 25.0G free, 50% of inodes free." });
  expect(diskStatus({ bytes: 15 * gigabyte, inodes: 0.5 }, 20)).toEqual({
    critical: true,
    message: "Disk is critical: 15.0G free, 50% of inodes free, below 20G. Do not start worktree lanes or heavy jobs here. hedge prune frees space every few minutes, and hedge disk-sweep lists the folders with the most files.",
  });
  expect(diskStatus({ bytes: 25 * gigabyte, inodes: 0.004 }, 20).message).toStartWith("Disk is critical: 25.0G free, 0% of inodes free, inodes below 10%.");
  const place = { here: "box-7", names: ["box-7"], freeMap: () => undefined, now: 0 };
  expect(startDecision(25 * gigabyte, 20, place, 0.004)).toMatchObject({ critical: true, message: expect.stringContaining("box-7: 0% of inodes free, below 10%") });
  expect(startDecision(25 * gigabyte, 20, place, 0.5).critical).toBe(false);
});

async function disk(settings: Record<string, unknown> | undefined, ...args: string[]) {
  const env = { ...Bun.env, HOME: temp.make("home-"), HEDGE_SETTINGS: settings && JSON.stringify(settings) };
  const child = Bun.spawn(["bun", join(import.meta.dir, "../commands/disk.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("hedge disk exits 1 while free space is under the floor setting", async () => {
  expect(await disk({ "base.diskFloorGigabytes": 0 })).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Disk: /) });
  expect(await disk({ "base.diskFloorGigabytes": 1e9 })).toMatchObject({ code: 1, stderr: expect.stringMatching(/^Disk is critical: /) });
  expect(await disk({ "base.diskFloorGigabytes": 0 }, "extra")).toMatchObject({ code: 2, stderr: "Usage: hedge disk [--start [--min-free <GB>]]\n" });
  expect((await disk(undefined)).stderr).toContain("run this command as hedge <command>");
});

const huge = 1e6;
const room = (gigabytes: number) => gigabytes * gigabyte;

async function start(options: { settings?: Record<string, unknown>; env?: Record<string, string>; map?: unknown; ssh?: string | null; machine?: object }, ...args: string[]) {
  const home = temp.make("home-");
  const bin = temp.make("bin-");
  const asked = join(bin, "ssh.log");
  if (options.ssh !== null) {
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho "$*" >> "${asked}"\n${options.ssh ?? "exit 255"}\n`);
    chmodSync(join(bin, "ssh"), 0o755);
  }
  if (options.machine) {
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify(options.machine));
  }
  if (options.map !== undefined) {
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    writeFileSync(join(home, ".local/state/hedge/disk-free.json"), JSON.stringify(options.map));
  }
  const { XDG_STATE_HOME: _, HEDGE_START_MIN_FREE_GB: __, ...inherited } = Bun.env;
  const settings = { "base.diskFloorGigabytes": 0, "base.startFloorGigabytes": 25, ...options.settings };
  const env = { ...inherited, HOME: home, PATH: options.ssh === null ? bin : `${bin}:${Bun.env.PATH}`, CODER_WORKSPACE_NAME: "devbox-here", HEDGE_SETTINGS: JSON.stringify(settings), ...options.env };
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../commands/disk.ts"), "--start", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const result = { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
  return { ...result, asked: existsSync(asked) ? readFileSync(asked, "utf8") : "" };
}

const freshMap = (boxes: Record<string, number>, minutesAgo = 6) => ({ checkedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), boxes });

test("hedge disk --start exits 75 below the start floor and names the devbox with the most room on the hub's free map", async () => {
  const map = freshMap({ "devbox-here": room(4 * huge), "devbox-small": room(huge / 2), "devbox-mid": room(1.5 * huge), "devbox-big": room(3 * huge) });
  const result = await start({ settings: { "base.startFloorGigabytes": huge }, map });
  expect(result.code).toBe(75);
  expect(result.stderr).toContain(`below the ${huge}G floor`);
  expect(result.stderr).toContain(`devbox-big has ${(3 * huge).toFixed(1)}G free (disk-watch, 6 min ago): start it there.`);
  expect(result.stderr).not.toContain("devbox-mid has");
  expect(await start({ settings: { "base.startFloorGigabytes": 0 }, map })).toMatchObject({ code: 0, stdout: expect.stringContaining("above the 0G floor for new threads") });
});

test("the start floor is --min-free, else HEDGE_START_MIN_FREE_GB, else the setting", async () => {
  expect((await start({ settings: { "base.startFloorGigabytes": huge }, env: { HEDGE_START_MIN_FREE_GB: "0" } })).code).toBe(0);
  expect((await start({ settings: { "base.startFloorGigabytes": 0 }, env: { HEDGE_START_MIN_FREE_GB: String(huge) } })).code).toBe(75);
  expect((await start({ env: { HEDGE_START_MIN_FREE_GB: String(huge) } }, "--min-free", "0")).code).toBe(0);
  expect(await start({ env: { HEDGE_START_MIN_FREE_GB: "lots" } })).toMatchObject({ code: 2, stderr: "HEDGE_START_MIN_FREE_GB must be a number of gigabytes, not 'lots'.\n" });
  expect(await start({}, "--min-free")).toMatchObject({ code: 2, stderr: "Usage: hedge disk [--start [--min-free <GB>]]\n" });
});

test("away from the hub, hedge disk --start asks the hub for its free map over SSH, and only below the floor", async () => {
  const map = JSON.stringify(freshMap({ "devbox-big": room(3 * huge) }));
  const hub = { "hub.alias": "my-hub" };
  const above = await start({ settings: { ...hub, "base.startFloorGigabytes": 0 }, ssh: `echo '${map}'` });
  expect([above.code, above.asked]).toEqual([0, ""]);
  const below = await start({ settings: { ...hub, "base.startFloorGigabytes": huge }, ssh: `echo '${map}'` });
  expect(below.code).toBe(75);
  expect(below.asked).toContain("my-hub");
  expect(below.stderr).toContain("devbox-big has");
});

test("a free map older than an hour, or none, names no other devbox", async () => {
  const stale = await start({ settings: { "base.startFloorGigabytes": huge }, map: freshMap({ "devbox-big": room(3 * huge) }, 90) });
  expect(stale.code).toBe(75);
  expect(stale.stderr).toContain("Hedge knows no devbox with room");
  expect((await start({ settings: { "base.startFloorGigabytes": huge } })).stderr).toContain("Hedge knows no devbox with room");
});

test("never sends a thread to this machine under another of its names, or under the alias the hub reaches it by", async () => {
  const map = { ...freshMap({ "compute-alias": room(6 * huge), "devbox-saved": room(5 * huge), [hostname()]: room(4 * huge), "my-hub": room(3 * huge) }), hosts: { "compute-alias": "devbox-here", "my-hub": "hub-host" } };
  const below = { "base.startFloorGigabytes": huge, "hub.alias": "my-hub" };
  const devbox = await start({ settings: below, map, machine: { schema: 1, role: "devbox", name: "devbox-saved" } });
  expect(devbox.stderr).toContain("my-hub has");
  expect(devbox.stderr).not.toContain("compute-alias has");
  expect(devbox.stderr).not.toContain("devbox-saved has");
  expect(devbox.stderr).not.toContain(`${hostname()} has`);
  const hub = await start({ settings: { ...below, "hub.alias": "my-hub" }, env: { CODER_WORKSPACE_NAME: "hub-workspace" }, map: freshMap({ "my-hub": room(3 * huge) }), machine: { schema: 1, role: "hub" } });
  expect(hub.stderr).toContain("Hedge knows no devbox with room");
});

test("without ssh, hedge disk --start still refuses with 75 and its reason", async () => {
  const result = await start({ settings: { "base.startFloorGigabytes": huge, "hub.alias": "my-hub" }, ssh: null });
  expect(result).toMatchObject({ code: 75, stderr: expect.stringContaining("Hedge knows no devbox with room") });
});
