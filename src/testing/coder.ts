import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { tempDirs } from "./git.ts";

const script = join(import.meta.dir, "../../scripts/check-workspace.sh");
export const storedToken = "session-token-from-the-keyring";
export const envToken = "session-token-from-the-environment";
const perl = Bun.which("perl")!;

export type Build = { transition?: string; status?: string; deadline?: string };
export type Coder = { parameters: Record<string, string>; mutable: Record<string, boolean>; defaultValue?: string; build?: Build; ttl?: number; token?: string; templateTransferFails?: boolean };

export function fakeCoder(temp: ReturnType<typeof tempDirs>, { parameters, mutable, defaultValue = "", build = {}, ttl, token = storedToken, templateTransferFails = false }: Coder) {
  const dir = temp.make("coder-");
  const workspaces = [
    { name: "hedge-hub-2", latest_build: { id: "other-build", template_version_id: "other-version", transition: "start", status: "running" }, ttl_ms: null },
    { name: "hedge-hub", latest_build: { id: "build-1", template_version_id: "version-1", transition: build.transition ?? "start", status: build.status ?? "running", ...(build.deadline ? { deadline: build.deadline } : {}) }, ttl_ms: ttl ?? null },
  ];
  writeFileSync(join(dir, "list.json"), JSON.stringify(workspaces));
  writeFileSync(join(dir, "parameters.json"), JSON.stringify(Object.entries(parameters).map(([name, value]) => ({ name, value }))));
  writeFileSync(join(dir, "rich-parameters.json"), JSON.stringify(Object.entries(mutable).map(([name, isMutable]) => ({ name, mutable: isMutable, ephemeral: false, default_value: defaultValue }))));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/argv.log"\nenv >> "${dir}/env.log"\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub("perl", `exec "${perl}" "$@"`);
  stub("coder", `case "$1 $2" in
  "list -o") cat "${dir}/list.json" ;;
  "whoami -o") echo '[{"url":"https://coder.test","username":"nora"}]' ;;
  "login token") echo "${storedToken}" ;;
  *) exit 2 ;;
esac`);
  stub("curl", `for url; do :; done
echo "$url" >> "${dir}/requests.log"
[ "$1" = -q ] || { echo "curl read the curl config" >&2; exit 2; }
IFS= read -r header
[ "$header" = "Coder-Session-Token: ${token}" ] || { echo "curl: (22) 401" >&2; exit 22; }
case "$url" in
  https://coder.test/api/v2/workspacebuilds/build-1/parameters) cat "${dir}/parameters.json" ;;
  https://coder.test/api/v2/templateversions/version-1/rich-parameters) cat "${dir}/rich-parameters.json"${templateTransferFails ? '; echo "curl: (18) transfer closed" >&2; exit 18' : ""} ;;
  *) echo "curl: (22) 404 $url" >&2; exit 22 ;;
esac`);
  const check = (args: string[], env: Record<string, string> = {}) => {
    const run = Bun.spawnSync(["sh", script, "hedge-hub", ...args], { env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, LANG: "C", ...env } });
    const requests = existsSync(join(dir, "requests.log")) ? readFileSync(join(dir, "requests.log"), "utf8").split("\n").filter(Boolean) : [];
    return { code: run.exitCode, output: run.stdout.toString() + run.stderr.toString(), argv: readFileSync(join(dir, "argv.log"), "utf8"), environment: readFileSync(join(dir, "env.log"), "utf8"), requests };
  };
  return { check };
}
