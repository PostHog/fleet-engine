import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunCheckout } from "../../../src/testing/bun-checkout.ts";
import { heavy, heavyIn, heavyWith, roomy, stubs, temp } from "./heavy-testing.ts";

afterEach(() => temp.cleanup());
const onLinux = test.skipIf(process.platform !== "linux");

onLinux("runs the command in a slot of the capped heavy slice", async () => {
  const { bin, calls } = stubs();
  expect(await heavy(bin, roomy, "--", "sh", "-c", "echo built")).toMatchObject({ code: 0, stdout: "built\n" });
  expect(calls()).toBe("uname -s\nsystemd-run --user --scope --quiet --collect --slice=hedge-heavy.slice -- sh -c echo built\n");
});

onLinux("runs a leading hedge in the command with this engine's launcher, though no hedge is on PATH", async () => {
  const { bin } = stubs();
  const slot = await heavy(bin, roomy, "--", "hedge", "help");
  expect(slot.code).toBe(0);
  expect(slot.stdout).toStartWith("Hedge: one setup");
  const served = await heavy(bin, roomy, "--service", "preview-a", "--", "hedge", "help");
  expect(served.stdout).toStartWith("Hedge: one setup");
});

onLinux("gives a service this shell's PATH, HOME, Hedge profile, memory, and XDG folders, though the systemd user manager starts it with its own environment", async () => {
  const { bin } = stubs();
  const profile = temp.make("profile-");
  const folders = { HEDGE_PROFILE_DIR: profile, HEDGE_MEMORY_DIR: `${profile}/memory`, XDG_STATE_HOME: `${profile}/state`, XDG_CONFIG_HOME: `${profile}/config` };
  const served = await heavyWith(folders, bin, roomy, "--service", "preview-a", "--", "sh", "-c", 'command -v bun >/dev/null && echo "$HOME" "$HEDGE_PROFILE_DIR" "$HEDGE_MEMORY_DIR" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME"');
  expect(served.stdout).toMatch(new RegExp(`^/\\S*home-\\S+ ${Object.values(folders).join(" ")}\n`));
});

onLinux("refuses to start while the disk is under the floor", async () => {
  const { bin, calls } = stubs();
  const result = await heavy(bin, { ...roomy, "base.diskFloorGigabytes": 1e9 }, "--", "sh", "-c", "echo built");
  expect(result).toMatchObject({ code: 75, stdout: "" });
  expect(result.stderr).toStartWith("Disk is critical: ");
  expect(calls()).toBe("");
});

onLinux("runs the command directly where there is no systemd", async () => {
  const { bin, calls } = stubs("Darwin");
  expect(await heavy(bin, roomy, "--", "sh", "-c", "echo built")).toMatchObject({ code: 0, stdout: "built\n" });
  expect(calls()).toBe("uname -s\n");
});

onLinux("stops a named unit, and refuses a unit name that is not plain", async () => {
  const { bin, calls } = stubs();
  expect((await heavy(bin, roomy, "--stop", "preview-a")).code).toBe(0);
  expect(calls()).toBe("systemctl --user stop preview-a\n");
  expect(await heavy(bin, roomy, "--unit", "a;b", "--", "true")).toMatchObject({ code: 2, stderr: "Hedge heavy: invalid unit name 'a;b'.\n" });
  expect(await heavy(bin, roomy)).toMatchObject({ code: 2, stderr: expect.stringMatching(/^Usage: hedge heavy/) });
});

onLinux("takes the slot count from HEDGE_HEAVY_SLOTS over the setting", async () => {
  const { bin } = stubs();
  const held = temp.make("locks-");
  const env = { XDG_RUNTIME_DIR: held, HEDGE_HEAVY_SLOTS: "1" };
  const busy = Bun.spawn(["sh", "-c", `mkdir -p ${held}/hedge-heavy; exec 9>${held}/hedge-heavy/slot-1; flock 9; echo locked; exec tail -f /dev/null`], { stdout: "pipe" });
  const reader = busy.stdout.getReader();
  await reader.read();
  const sleeper = join(bin, "sleep");
  writeFileSync(sleeper, "#!/bin/sh\nexit 9\n");
  chmodSync(sleeper, 0o755);
  const result = await heavyWith(env, bin, roomy, "--", "true");
  busy.kill();
  expect(result.stderr).toContain("this job is number 1 of 1 in the queue");
});

function routeHandler(bin: string) {
  const handler = join(bin, "route.ts");
  const seen = join(bin, "routed.log");
  writeFileSync(handler, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: Bun.argv.slice(2), routed: Bun.env.HEDGE_HEAVY_ROUTED }) + "\\n");\nprocess.exit(7);\n`);
  return { handlers: JSON.stringify({ "heavy-route": handler }), routed: () => (existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []) };
}

onLinux("hands a typed heavy command to the heavy-route handler, which decides where it runs", async () => {
  const { bin, calls } = stubs();
  const { handlers, routed } = routeHandler(bin);
  expect(await heavyWith({ HEDGE_HANDLERS: handlers }, bin, roomy, "--", "sh", "-c", "echo built")).toMatchObject({ code: 7, stdout: "" });
  expect(routed()).toEqual([{ argv: ["sh", "-c", "echo built"], routed: "1" }]);
  expect(calls()).toBe("");
});

onLinux("checks the disk and routes the command inside a checkout without running the checkout's bunfig.toml", async () => {
  const { bin } = stubs();
  const { handlers, routed } = routeHandler(bin);
  const checkout = bunCheckout(temp);
  expect(await heavyIn(checkout.dir, { HEDGE_HANDLERS: "{}" }, bin, roomy, "--", "true")).toMatchObject({ code: 0 });
  expect(await heavyIn(checkout.dir, { HEDGE_HANDLERS: handlers }, bin, roomy, "--", "true")).toMatchObject({ code: 7 });
  expect(routed()).toEqual([{ argv: ["true"], routed: "1" }]);
  expect(checkout.preloaded()).toBe(false);
});

onLinux("runs here when the handler already routed the command, or for a named unit or service, and the command routes its own heavy runs again", async () => {
  const { bin, calls } = stubs();
  const { handlers, routed } = routeHandler(bin);
  expect(await heavyWith({ HEDGE_HANDLERS: handlers, HEDGE_HEAVY_ROUTED: "1" }, bin, roomy, "--", "sh", "-c", "echo built ${HEDGE_HEAVY_ROUTED:-unrouted}")).toMatchObject({ code: 0, stdout: "built unrouted\n" });
  expect(await heavyWith({ HEDGE_HANDLERS: handlers }, bin, roomy, "--unit", "lane-a", "--", "true")).toMatchObject({ code: 0 });
  expect(await heavyWith({ HEDGE_HANDLERS: handlers }, bin, roomy, "--service", "preview-a", "--", "true")).toMatchObject({ code: 0 });
  expect(routed()).toEqual([]);
  expect(calls()).toContain("--unit=lane-a");
  expect(calls()).toContain("--unit=preview-a");
});

onLinux("refuses a slot count that is not a whole number above 0", async () => {
  const { bin, calls } = stubs();
  for (const slots of [0, -1, 1.5]) {
    const result = await heavy(bin, { ...roomy, "base.heavySlots": slots }, "--", "true");
    expect(result).toMatchObject({ code: 2, stderr: `Hedge heavy: base.heavySlots must be a whole number above 0, not '${slots}'.\n` });
  }
  expect(calls()).toBe("uname -s\nuname -s\nuname -s\n");
});
