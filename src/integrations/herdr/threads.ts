import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRow } from "../../pack/types.ts";
import type { Threads } from "../../sdk/index.ts";
import { hcFinished, hcNotFound, hcProblem, spawnHc, type Hc } from "./hc.ts";
import { templateName } from "./templates.ts";

export const hedgeSpace = "hedge";
export const threadLabel = "hedge.thread";
export const threadsDir = ".local/state/hedge/herdr/threads";

type Terminal = { address?: string; name?: string; state?: string; first_message?: { sent?: boolean; reason?: string } };

export type HerdrThreadOptions = { hc?: Hc; home?: string };

const digest = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export function terminalName(title: string, key: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 23).replace(/-+$/, "");
  return [slug, digest(key).slice(0, 8)].filter(Boolean).join("-");
}

function terminals(stdout: string): Terminal[] {
  const parsed = JSON.parse(stdout) as { terminals?: Terminal[] } | Terminal[];
  return Array.isArray(parsed) ? parsed : (parsed.terminals ?? []);
}

export function herdrThreads(models: ModelRow[], { hc = spawnHc(), home = homedir() }: HerdrThreadOptions = {}): Threads {
  return {
    async start({ key, title, prompt, modelRole }) {
      const row = models.find((candidate) => candidate.role === modelRole);
      if (!row) throw new Error(`The model table of your AI plan has no ${modelRole} row, so Hedge cannot start the thread.`);
      const label = `${threadLabel}=${digest(key)}`;
      const listed = await hc(["ls", "--all", "--json", "--label", label]);
      if (listed.code !== 0) throw new Error(`herdr-core did not list its terminals: ${hcProblem(listed)}`);
      const existing = terminals(listed.stdout)[0];
      if (existing?.address) return { id: existing.address };
      const cwd = join(home, threadsDir);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const name = terminalName(title, key);
      const started = await hc([
        "run", "--json", "--bg", "--keep", "--no-parent", "--name", name, "--cwd", cwd,
        "--label", label, "--label", `herdr.space=${hedgeSpace}`, templateName(row.role), prompt,
      ]);
      if (started.code !== 0) throw new Error(`herdr-core did not start ${name}: ${hcProblem(started)}`);
      const terminal = JSON.parse(started.stdout) as Terminal;
      const id = terminal.address ?? name;
      if (terminal.first_message?.sent === false) {
        throw new Error(`herdr-core started ${name} (${id}), but the agent did not take its task (${terminal.first_message.reason ?? "no reason given"}). Open it with hc attach ${id}, or from the Herdr app.`);
      }
      return { id };
    },
    async send({ id, text }) {
      const sent = await hc(["send", id, text]);
      if (sent.code === hcNotFound || sent.code === hcFinished) return false;
      if (sent.code !== 0) throw new Error(`herdr-core did not send to ${id}: ${hcProblem(sent)}`);
      return true;
    },
  };
}
