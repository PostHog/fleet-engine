import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerConfigAdapter } from "../../adapters/provider-config/adapter.ts";
import type { CommandRunner } from "../../adapters/run.ts";
import { main } from "../../cli.ts";
import { waitsForPerson } from "../../pack/types.ts";
import { filesAdapter } from "../../reconciler/apply.ts";

const home = process.env.HOME!;
const state = join(home, ".node");
const holds = (name: string) => (existsSync(join(state, name)) ? 0 : 1);
const args = process.argv.slice(2);
const words = args.join(" ");

if (existsSync(join(state, "older-engine")) && args.includes("--to-do")) {
  console.error("hedge: unknown option --to-do");
  process.exit(1);
}

if (words === "guards allowlist --check") process.exit(holds("allowlist"));
if (words.startsWith("guards allowlist stage ")) {
  mkdirSync(args[3]!, { recursive: true });
  writeFileSync(join(args[3]!, "install.sh"), `[ -n "$SUDO_USER" ] && touch "$HOME/.node/allowlist"\n`);
  process.exit(0);
}

const signedOut = existsSync(join(state, "signed-out"));
const signIns = ["claude mcp get ", "codex mcp list", ".convex/config.json"];

const providers: CommandRunner = async (command) => {
  const line = command.join(" ");
  if (line === "codex plugin list --json") return { code: 0, stdout: JSON.stringify({ installed: [] }) };
  if (line.startsWith("codex plugin add ")) return { code: 1, stdout: "", stderr: "Error: chatgpt authentication required for remote plugin catalog\n" };
  if (line === "codex login status") return { code: 1, stdout: "", stderr: "Not logged in\n" };
  const claudePlugins = join(state, "claude-plugins");
  if (line.startsWith("claude plugin install ")) appendFileSync(claudePlugins, `${command[3]}\n`);
  const installed = existsSync(claudePlugins) ? readFileSync(claudePlugins, "utf8").split("\n").filter(Boolean) : [];
  if (line === "claude plugin list --json") return { code: 0, stdout: JSON.stringify(installed.map((id) => ({ id, scope: "user" }))) };
  return { code: 0, stdout: line.endsWith(" list --json") ? "[]" : "" };
};

const probe = async (command: string[]) => {
  if (existsSync(join(state, "steps-fail"))) return 1;
  const line = command.join(" ");
  if (signedOut && signIns.some((part) => line.includes(part))) return waitsForPerson;
  if (line.endsWith("guards allowlist --check")) return holds("allowlist");
  if (line.includes("earlyoom.sh") && line.includes("--check")) return holds("earlyoom");
  if (line.includes("systemctl --version")) return existsSync(join(state, "old-systemd")) ? 1 : 0;
  return 0;
};

const print = (line: string) => console.log(line);
process.exit(await main(args, { home, engineRoot: join(import.meta.dir, "../../.."), platform: "linux", env: {}, print, fail: (line) => console.error(line), adapters: () => (signedOut ? [filesAdapter, providerConfigAdapter({ run: providers })] : [filesAdapter]), run: probe }));
