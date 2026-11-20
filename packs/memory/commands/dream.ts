import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { modelFor } from "../../base/lib/models.ts";
import { optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { activeRuntime } from "../../../src/runtime/active.ts";
import { capture, Coder } from "../../hub/lib/coder.ts";
import { devboxesOf, quote, shellLimitMs } from "../../hub/lib/machine.ts";
import { modelAnalyst, modelAsk } from "../lib/dream/analyze.ts";
import { checkerPrompt, checkerSchema, type Verdict } from "../lib/dream/audit.ts";
import { boundedSpawn } from "../lib/dream/spawn.ts";
import { dreamCommand, dreamPeers } from "../lib/dream/command.ts";

const home = homedir();
const env = Bun.env;

function boxes() {
  const coderUrl = optionalStringSetting("hub.coderUrl", env);
  const template = optionalStringSetting("hub.boxTemplate", env);
  if (!coderUrl || !template) return undefined;
  const coder = new Coder({ home, env, coderUrl, template });
  return { running: async () => (await coder.boxes(30_000)).filter((box) => box.status === "running").map((box) => box.name), ssh: (box: string, command: string) => coder.ssh(box, command, undefined, 120_000) };
}

await runCommand(() => dreamCommand(Bun.argv.slice(2), {
  home,
  env,
  self: env.CODER_WORKSPACE_NAME ?? hostname(),
  now: Date.now,
  print: (text) => void process.stdout.write(text.endsWith("\n") || !text ? text : `${text}\n`),
  say: (line) => console.error(line),
  peers: () => dreamPeers(stringSetting("hub.alias", env), devboxesOf(env, home), hostname()),
  onPeer: (alias, command) => capture(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, `bash -lc ${quote(command)}`], { timeoutMs: shellLimitMs }),
  boxes,
  git: (args) => capture(["git", ...args], { timeoutMs: shellLimitMs }),
  analyst: () => modelAnalyst(modelFor("lookup", env), home, env, boundedSpawn()),
  checker: () => modelAsk<Verdict>(modelFor("survey", env), home, env, boundedSpawn(), checkerPrompt, checkerSchema),
  launch: async (title, prompt) => (await (await activeRuntime(env, home)).threads.start({ key: `memory:${title}`, title, prompt, modelRole: "implementation" })).id,
}), "hedge dream");
