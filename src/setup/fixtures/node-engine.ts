import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../cli.ts";
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

const probe = async (command: string[]) => {
  if (existsSync(join(state, "steps-fail"))) return 1;
  const line = command.join(" ");
  if (line.endsWith("guards allowlist --check")) return holds("allowlist");
  if (line.includes("earlyoom.sh") && line.includes("--check")) return holds("earlyoom");
  if (line.includes("systemctl --version")) return existsSync(join(state, "old-systemd")) ? 1 : 0;
  return 0;
};

const print = (line: string) => console.log(line);
process.exit(await main(args, { home, engineRoot: join(import.meta.dir, "../../.."), platform: "linux", env: {}, print, fail: (line) => console.error(line), adapters: () => [filesAdapter], run: probe }));
