import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const script = join(import.meta.dir, "check-workspace.sh");
const token = "session-token-from-the-keyring";
const privateValue = "nora-private-value";

type Coder = { parameters: Record<string, string>; mutable: Record<string, boolean>; deadline?: string; ttl?: number };

function coder({ parameters, mutable, deadline, ttl }: Coder) {
  const dir = temp.make("coder-");
  const workspaces = [
    { name: "hedge-hub-2", latest_build: { id: "other-build", template_version_id: "other-version" }, ttl_ms: null },
    { name: "hedge-hub", latest_build: { id: "build-1", template_version_id: "version-1", ...(deadline ? { deadline } : {}) }, ttl_ms: ttl ?? null },
  ];
  writeFileSync(join(dir, "list.json"), JSON.stringify(workspaces));
  writeFileSync(join(dir, "parameters.json"), JSON.stringify(Object.entries(parameters).map(([name, value]) => ({ name, value }))));
  writeFileSync(join(dir, "rich-parameters.json"), JSON.stringify(Object.entries(mutable).map(([name, isMutable]) => ({ name, mutable: isMutable, default_value: "" }))));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub("coder", `echo "coder $*" >> "${dir}/argv.log"
case "$1 $2" in
  "list -o") cat "${dir}/list.json" ;;
  "whoami -o") echo '[{"url":"https://coder.test","username":"nora"}]' ;;
  "login token") echo "${token}" ;;
  *) exit 2 ;;
esac`);
  stub("curl", `echo "curl $*" >> "${dir}/argv.log"
IFS= read -r header
[ "$header" = "Coder-Session-Token: ${token}" ] || { echo "curl: (22) 401" >&2; exit 22; }
for url; do :; done
case "$url" in
  https://coder.test/api/v2/workspacebuilds/build-1/parameters) cat "${dir}/parameters.json" ;;
  https://coder.test/api/v2/templateversions/version-1/rich-parameters) cat "${dir}/rich-parameters.json" ;;
  *) echo "curl: (22) 404 $url" >&2; exit 22 ;;
esac`);
  const check = (...args: string[]) => {
    const run = Bun.spawnSync(["sh", script, "hedge-hub", ...args], { env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir } });
    return { code: run.exitCode, output: run.stdout.toString() + run.stderr.toString(), argv: readFileSync(join(dir, "argv.log"), "utf8") };
  };
  return { check };
}

const passed = ["disk_size=200", "region=eu", "dotfiles_uri=https://github.com/nora/hedge-profile", `git_email=${privateValue}`];
const template = { disk_size: false, region: false, dotfiles_uri: true, git_email: true };

describe("the setup guide's workspace check", () => {
  test("passes when each parameter has the value passed and the workspace has no stop time, with the token kept out of every command line and the output", () => {
    const { check } = coder({ parameters: { disk_size: "200", region: "eu", dotfiles_uri: "https://github.com/nora/hedge-profile", git_email: privateValue }, mutable: template });
    const result = check(...passed);
    expect(result.code).toBe(0);
    expect(result.output).toBe("ok disk_size\nok region\nok dotfiles_uri\nok git_email\nok hedge-hub stays on\n");
    expect(result.argv).not.toContain(token);
    expect(result.output).not.toContain(privateValue);
  });

  test("says which value differs, sends one the template cannot change to a new workspace, and never prints a value", () => {
    const other = "someone-else-private";
    const { check } = coder({ parameters: { disk_size: "100", region: "us", dotfiles_uri: "https://github.com/nora/hedge-profile", git_email: other }, mutable: { ...template, region: true } });
    const result = check(...passed, "missing=1");
    expect(result.code).toBe(1);
    expect(result.output).toBe(
      [
        "x disk_size is not the value you passed, and the template does not let it change. Delete the workspace and create it again before setup.",
        "x region is not the value you passed. Change it with: coder update hedge-hub --parameter region=<value>",
        "ok dotfiles_uri",
        "x git_email is not the value you passed. Change it with: coder update hedge-hub --parameter git_email=<value>",
        "x missing is not a parameter of this build.",
        "ok hedge-hub stays on",
        "",
      ].join("\n"),
    );
    for (const value of [privateValue, other]) expect(result.output).not.toContain(value);
  });

  test("fails while the workspace has a stop schedule or its running build still has a stop time", () => {
    const parameters = { disk_size: "200" };
    const scheduled = coder({ parameters, mutable: template, ttl: 3_600_000 }).check("disk_size=200");
    expect([scheduled.code, scheduled.output]).toEqual([1, "ok disk_size\nx hedge-hub has a stop schedule. Run: coder schedule stop hedge-hub manual\n"]);
    const deadline = coder({ parameters, mutable: template, deadline: "2026-11-19T20:00:00Z" }).check("disk_size=200");
    expect(deadline.code).toBe(1);
    expect(deadline.output).toContain("x hedge-hub still stops at 2026-11-19T20:00:00Z. Run coder schedule stop hedge-hub manual again.");
    const none = coder({ parameters, mutable: template, deadline: "0001-01-01T00:00:00Z" }).check("disk_size=200");
    expect([none.code, none.output]).toEqual([0, "ok disk_size\nok hedge-hub stays on\n"]);
  });
});
