import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Machine } from "./commands.ts";

const overSsh = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)/;
const hostKey = /^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;

export async function knowGitHub(machine: Machine, home: string, dir: string) {
  const origin = await machine.exec(["git", "-C", dir, "config", "--get", "remote.origin.url"]);
  if (!overSsh.test(origin.output.trim())) return;
  const file = join(home, ".ssh", "known_hosts");
  const known = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (known.split("\n").some((line) => line.split(/\s/)[0]!.split(",").includes("github.com"))) return;
  const meta = await machine.exec(["gh", "api", "--hostname", "github.com", "meta", "--jq", ".ssh_keys[]"]);
  const keys = meta.code === 0 ? meta.stdout.split("\n").map((line) => line.trim()).filter((line) => hostKey.test(line)) : [];
  if (!keys.length) return;
  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${known && !known.endsWith("\n") ? "\n" : ""}${keys.map((key) => `github.com ${key}`).join("\n")}\n`, { mode: 0o600 });
}
