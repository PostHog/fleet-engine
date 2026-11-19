import { afterEach, describe, expect, test } from "bun:test";
import { tempDirs } from "../src/testing/git.ts";
import { envToken, fakeCoder, storedToken, type Coder } from "../src/testing/coder.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const coder = (setup: Coder) => fakeCoder(temp, setup);

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

  test("puts no template default into the environment or the arguments of any process it starts, and checks as before", () => {
    const marker = "template-default-marker";
    const result = coder({ parameters: built, mutable: template, defaultValue: marker }).check(passed);
    expect([result.code, result.output]).toEqual([0, "ok disk_size\nok region\nok instance_type\nok dotfiles_uri\nok hedge-hub runs and stays on\n"]);
    expect(result.environment).toContain("PATH=");
    expect(result.argv).not.toContain(marker);
    expect(result.environment).not.toContain(marker);
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

  test("tells to change in the Coder web app a workspace parameter, with a name outside ASCII, the template lets change", () => {
    const result = coder({ parameters: { ...built, région: "eu" }, mutable: { ...template, région: true } }).check(["région=us"]);
    expect([result.code, result.output]).toEqual([1, "x région is not the value you passed. In the Coder web app, set it under Settings, Parameters, and submit.\nok hedge-hub runs and stays on\n"]);
  });

  test("fails when the request for the template's parameters fails, even after it delivered JSON", () => {
    const result = coder({ parameters: built, mutable: template, templateTransferFails: true }).check(passed);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Coder did not return the parameters of the template of hedge-hub.");
    expect(result.output).not.toContain("ok hedge-hub runs and stays on");
  });

  test("says which value differs, sends a value the template lets change to the Coder web app, and sends one it cannot change to a new workspace", () => {
    const result = coder({ parameters: { ...built, disk_size: "100", instance_type: "m7g.xlarge" }, mutable: template }).check([...passed, "missing=1"]);
    expect(result.code).toBe(1);
    expect(result.output).toBe(
      [
        "x disk_size is not the value you passed, and the template does not let it change. Delete the workspace and create it again before setup.",
        "ok region",
        "x instance_type is not the value you passed. In the Coder web app, set it under Settings, Parameters, and submit.",
        "ok dotfiles_uri",
        "x missing is not a parameter of this build.",
        "ok hedge-hub runs and stays on",
        "",
      ].join("\n"),
    );
  });

  test("fails on a build that ended without a running start, before it reads any parameter: sends the person to the action the web app offers, and asks before a delete", () => {
    const builds = [
      { transition: "stop", status: "stopped" },
      { transition: "start", status: "failed" },
      { transition: "stop", status: "failed" },
      { transition: "start", status: "canceled" },
      { transition: "stop", status: "canceled" },
      { transition: "delete", status: "failed" },
      { transition: "delete", status: "canceled" },
    ];
    for (const build of builds) {
      const result = coder({ parameters: built, mutable: template, build }).check(passed);
      const advice = build.transition === "delete"
        ? `x hedge-hub has a delete build that is ${build.status}, so its name stays taken. Ask the person whether it should go. If so, they delete it from the workspace's menu in the Coder web app, and you create it again when it is gone. If not, they get it running with the action that the Coder web app offers for it, then run this check again.\n`
        : `x hedge-hub does not run: its latest build is a ${build.transition} that is ${build.status}. Ask the person to get it running with the action that the Coder web app offers for it, such as Start, Retry, or Update and start, then run this check again.\n`;
      expect([build, result.code, result.output, result.requests]).toEqual([build, 1, advice, []]);
    }
    expect(coder({ parameters: built, mutable: template }).check(passed).requests).toEqual(["https://coder.test/api/v2/workspacebuilds/build-1/parameters", "https://coder.test/api/v2/templateversions/version-1/rich-parameters"]);
  });

  test("fails while a build still runs, and says only to wait and check again, before it compares any parameter", () => {
    const mismatched = { ...built, disk_size: "100", instance_type: "m7g.xlarge" };
    for (const build of [{ transition: "start", status: "pending" }, { transition: "start", status: "starting" }, { transition: "stop", status: "stopping" }, { transition: "stop", status: "canceling" }, { transition: "delete", status: "deleting" }]) {
      const result = coder({ parameters: mismatched, mutable: template, build }).check(passed);
      expect([build, result.code, result.output]).toEqual([build, 1, `x hedge-hub is not ready: its latest build is a ${build.transition} that is ${build.status}. Wait until it ends, then run this check again.\n`]);
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
