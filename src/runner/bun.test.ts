import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunScript } from "./bun.ts";
import { bunCheckout, nodeEnvs, reportCheckoutEnv } from "../testing/bun-checkout.ts";
import { tempDirs } from "../testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

test("a Bun script that Hedge starts inside a checkout reads none of its .env files and runs none of its bunfig.toml", async () => {
  const checkout = bunCheckout(temp);
  const script = join(temp.make("engine-"), "report.ts");
  const report = join(temp.make("out-"), "env.json");
  writeFileSync(script, reportCheckoutEnv(report));
  for (const nodeEnv of nodeEnvs) {
    const child = Bun.spawn(bunScript(script), { cwd: checkout.dir, env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) }, stdout: "ignore", stderr: "inherit" });
    expect([nodeEnv, await child.exited, JSON.parse(readFileSync(report, "utf8"))]).toEqual([nodeEnv, 0, {}]);
  }
  expect(checkout.preloaded()).toBe(false);
});
