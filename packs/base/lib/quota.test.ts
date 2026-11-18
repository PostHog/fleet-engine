import { expect, test } from "bun:test";
import { quotaLine, quotaWatch } from "./quota.ts";

const quota = "API Error: 429 Too Many Requests\n";
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

function watching() {
  const stalls: string[] = [];
  const watch = quotaWatch(0, (line) => stalls.push(line));
  return { watch, stalls, stdout: watch.stream(), stderr: watch.stream() };
}

test("a stream that closes on an unfinished line does not count it as new progress after quota lines", async () => {
  const { watch, stalls, stdout, stderr } = watching();
  stdout.observe("reviewing file ");
  stderr.observe(quota + quota);
  stdout.end();
  await nextTick();
  expect(stalls).toEqual(["API Error: 429 Too Many Requests"]);
  expect(watch.waiting()).toBe("API Error: 429 Too Many Requests");
});

test("an unfinished line on another stream between two quota lines breaks the streak", async () => {
  const { watch, stalls, stdout, stderr } = watching();
  stderr.observe(quota);
  stdout.observe("reviewing file ");
  stderr.observe(quota);
  await nextTick();
  expect(stalls).toEqual([]);
  stderr.observe(quota);
  await nextTick();
  expect(stalls).toEqual(["API Error: 429 Too Many Requests"]);
  watch.stop();
});

test("a reconnect line is quota only when it names quota or follows a quota line, because Codex reconnects on any dropped stream", async () => {
  expect(quotaLine("ERROR: Reconnecting... 1/5")).toBeUndefined();
  expect(quotaLine("Reconnecting... 5/5 (stream disconnected before completion: unexpected EOF)")).toBeUndefined();
  expect(quotaLine("Reconnecting... 3/5 (stream disconnected before completion: 429 Too Many Requests)")).toBeDefined();
  expect(quotaLine("ERROR: Reconnecting... 2/5", true)).toBe("ERROR: Reconnecting... 2/5");

  const dropped = watching();
  dropped.stderr.observe("ERROR: Reconnecting... 1/5\nERROR: Reconnecting... 2/5\n");
  await nextTick();
  expect(dropped.stalls).toEqual([]);
  expect(dropped.watch.waiting()).toBeUndefined();

  const spent = watching();
  spent.stderr.observe(quota + "ERROR: Reconnecting... 1/5\n");
  await nextTick();
  expect(spent.stalls).toEqual(["ERROR: Reconnecting... 1/5"]);
});
