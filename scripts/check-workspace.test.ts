import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const script = join(import.meta.dir, "check-workspace.sh");
const storedToken = "session-token-from-the-keyring";
const envToken = "session-token-from-the-environment";
const perl = Bun.which("perl")!;

type Build = { transition?: string; status?: string; deadline?: string };
type Coder = { parameters: Record<string, string>; mutable: Record<string, boolean>; build?: Build; ttl?: number; token?: string };

function coder({ parameters, mutable, build = {}, ttl, token = storedToken }: Coder) {
  const dir = temp.make("coder-");
  const workspaces = [
    { name: "hedge-hub-2", latest_build: { id: "other-build", template_version_id: "other-version", transition: "start", status: "running" }, ttl_ms: null },
    { name: "hedge-hub", latest_build: { id: "build-1", template_version_id: "version-1", transition: build.transition ?? "start", status: build.status ?? "running", ...(build.deadline ? { deadline: build.deadline } : {}) }, ttl_ms: ttl ?? null },
  ];
  writeFileSync(join(dir, "list.json"), JSON.stringify(workspaces));
  writeFileSync(join(dir, "parameters.json"), JSON.stringify(Object.entries(parameters).map(([name, value]) => ({ name, value }))));
  writeFileSync(join(dir, "rich-parameters.json"), JSON.stringify(Object.entries(mutable).map(([name, isMutable]) => ({ name, mutable: isMutable, default_value: "" }))));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/argv.log"\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub("perl", `exec "${perl}" "$@"`);
  stub("coder", `case "$1 $2" in
  "list -o") cat "${dir}/list.json" ;;
  "whoami -o") echo '[{"url":"https://coder.test","username":"nora"}]' ;;
  "login token") echo "${storedToken}" ;;
  *) exit 2 ;;
esac`);
  stub("curl", `[ "$1" = -q ] || { echo "curl read the curl config" >&2; exit 2; }
IFS= read -r header
[ "$header" = "Coder-Session-Token: ${token}" ] || { echo "curl: (22) 401" >&2; exit 22; }
for url; do :; done
case "$url" in
  https://coder.test/api/v2/workspacebuilds/build-1/parameters) cat "${dir}/parameters.json" ;;
  https://coder.test/api/v2/templateversions/version-1/rich-parameters) cat "${dir}/rich-parameters.json" ;;
  *) echo "curl: (22) 404 $url" >&2; exit 22 ;;
esac`);
  const check = (args: string[], env: Record<string, string> = {}) => {
    const run = Bun.spawnSync(["sh", script, "hedge-hub", ...args], { env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, LANG: "C", ...env } });
    return { code: run.exitCode, output: run.stdout.toString() + run.stderr.toString(), argv: readFileSync(join(dir, "argv.log"), "utf8") };
  };
  return { check };
}

const passed = ["disk_size=200", "region=eu", "instance_type=m7g.4xlarge", "dotfiles_uri=https://github.com/nora/hedge-profile"];
const built = { disk_size: "200", region: "eu", instance_type: "m7g.4xlarge", dotfiles_uri: "https://github.com/nora/hedge-profile", git_email: "nora@private.test" };
const template = { disk_size: false, region: false, instance_type: true, dotfiles_uri: true, git_email: true };

describe("the setup guide's workspace check", () => {
  test("passes when each parameter the guide sets has its value and the workspace runs with no stop time, with the token in no process's arguments and not in the output", () => {
    const result = coder({ parameters: built, mutable: template }).check(passed);
    expect(result.code).toBe(0);
    expect(result.output).toBe("ok disk_size\nok region\nok instance_type\nok dotfiles_uri\nok hedge-hub runs and stays on\n");
    expect(result.argv).toContain("perl ");
    expect(result.argv).toContain("curl -q ");
    expect(result.argv).not.toContain(storedToken);
    expect(result.output).not.toContain(storedToken);
    expect(result.output).not.toContain("nora@private.test");
  });

  test("sends the session token from CODER_SESSION_TOKEN when it is set, as coder itself does", () => {
    const result = coder({ parameters: built, mutable: template, token: envToken }).check(passed, { CODER_SESSION_TOKEN: envToken });
    expect([result.code, result.output.split("\n").at(-2)]).toEqual([0, "ok hedge-hub runs and stays on"]);
    expect(result.argv).not.toContain(envToken);
    expect(result.argv).not.toContain("coder login token");
  });

  test("compares a value with letters outside ASCII as the text it is", () => {
    const result = coder({ parameters: { ...built, region: "São Paulo" }, mutable: template }).check(["region=São Paulo"]);
    expect([result.code, result.output]).toEqual([0, "ok region\nok hedge-hub runs and stays on\n"]);
  });

  test("says which value differs, restarts with a value the template lets change, and sends one it cannot change to a new workspace", () => {
    const result = coder({ parameters: { ...built, disk_size: "100", instance_type: "m7g.xlarge" }, mutable: template }).check([...passed, "missing=1"]);
    expect(result.code).toBe(1);
    expect(result.output).toBe(
      [
        "x disk_size is not the value you passed, and the template does not let it change. Delete the workspace and create it again before setup.",
        "ok region",
        "x instance_type is not the value you passed. From this Mac, run: coder restart hedge-hub --parameter instance_type=<value> --yes",
        "ok dotfiles_uri",
        "x missing is not a parameter of this build.",
        "ok hedge-hub runs and stays on",
        "",
      ].join("\n"),
    );
  });

  test("fails when the latest build is not a running start, and says to start it with the parameters", () => {
    for (const build of [{ transition: "stop", status: "stopped" }, { transition: "start", status: "failed" }]) {
      const result = coder({ parameters: built, mutable: template, build }).check(passed);
      expect([build, result.code, result.output.split("\n").at(-2)]).toEqual([build, 1, `x hedge-hub does not run: its latest build is a ${build.transition} that is ${build.status}. From this Mac, run: coder restart hedge-hub --parameter <parameter>=<value> --yes, with each parameter you passed, and check again.`]);
    }
  });

  test("fails while the workspace has a stop schedule or its running build still has a stop time", () => {
    const scheduled = coder({ parameters: built, mutable: template, ttl: 3_600_000 }).check(["disk_size=200"]);
    expect([scheduled.code, scheduled.output]).toEqual([1, "ok disk_size\nx hedge-hub has a stop schedule. Run: coder schedule stop hedge-hub manual\n"]);
    const deadline = coder({ parameters: built, mutable: template, build: { deadline: "2026-11-19T20:00:00Z" } }).check(["disk_size=200"]);
    expect(deadline.code).toBe(1);
    expect(deadline.output).toContain("x hedge-hub still stops at 2026-11-19T20:00:00Z. Run coder schedule stop hedge-hub manual again.");
    const none = coder({ parameters: built, mutable: template, build: { deadline: "0001-01-01T00:00:00Z" } }).check(["disk_size=200"]);
    expect([none.code, none.output]).toEqual([0, "ok disk_size\nok hedge-hub runs and stays on\n"]);
  });
});
