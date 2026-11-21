import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { loadPacks } from "../src/pack/manifest.ts";
import { fetchSource } from "../src/pack/sources.ts";
import { sourceCache } from "../src/setup/setup.ts";
import { saveMachine } from "../src/profile/profile.ts";
import { profilePath } from "../src/setup/profile.ts";
import { devboxesOf } from "../packs/hub/lib/machine.ts";
import { cliFixtures } from "../src/testing/cli.ts";
import { fakeMachine, hedgeSetup, savedAnswers, scripted } from "../src/setup/testing.ts";
import { isolateGit, spawnGit, tempDirs } from "../src/testing/git.ts";
import { fakeCoder } from "../src/testing/coder.ts";
import { needsHubPacks } from "../src/setup/defaults.ts";
import { promptLabels, startPrompt } from "../page/model.ts";
import { pageData } from "./build-page.ts";

isolateGit();
const temp = tempDirs();
const cli = cliFixtures(temp);
afterEach(() => temp.cleanup());

const root = join(import.meta.dir, "..");
const guide = () => readFileSync(join(root, "SETUP.md"), "utf8");
const notePaths = () => readdirSync(join(root, "packs")).map((pack) => join("packs", pack, "SETUP.md")).filter((path) => existsSync(join(root, path)));

const blocksIn = (text: string) => [...text.matchAll(/^( *)```\w*\n([\s\S]*?)^ *```$/gm)].map((match) => match[2]!.replace(new RegExp(`^ {0,${match[1]!.length}}`, "gm"), ""));

const coderValueOptions = new Set(["--client-tls-ca-file", "--client-tls-cert-file", "--client-tls-key-file", "--global-config", "--header", "--header-command", "--token", "--url"]);
function coderSubcommands(code: string) {
  return code.replace(/\\\n/g, "").split("\n").flatMap((line) => {
    const words = (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ""));
    return words.flatMap((word, at) => {
      if (word !== "coder") return [];
      let next = at + 1;
      while (words[next]?.startsWith("-")) next += coderValueOptions.has(words[next]!) ? 2 : 1;
      return words[next] ? [words[next]!] : [];
    });
  });
}
const wrappedSpans = (text: string) => [...text.replace(/^ *```[\s\S]*?^ *```$/gm, "").replace(/\s+/g, " ").matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
const cliParameterChanges = (markdown: string) => [...new Set([...codeIn(markdown), ...wrappedSpans(markdown)])].filter((code) => coderSubcommands(code).some((name) => ["update", "restart", "start"].includes(name)));
function codeIn(text: string) {
  const blocks = blocksIn(text);
  const spans = [...text.replace(/^ *```[\s\S]*?^ *```$/gm, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  return [...blocks, ...spans];
}
const guidePath = "$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";
const manifests = async () => (await loadPacks(root)).map((pack) => pack.manifest);
const words = (text: string) => text.replace(/\s+/g, " ");
const step = (number: number) => {
  const from = guide().indexOf(`\n## ${number}. `);
  const to = guide().indexOf(`\n## ${number + 1}. `);
  return guide().slice(from, to < 0 ? undefined : to);
};
const hubStep = () => step(9);
const beforeSteps = (heading: string) => guide().slice(guide().indexOf(heading), guide().indexOf("\n## 1. "));
const onHubLine = (command: string) => `ssh coder.<hub> 'export PATH="${guidePath}"; ${command}'`;
const setupArgs = () => guide().match(/; hedge setup (--chat [^']+)'/)![1]!;

function fakeTools(tools: Record<string, string>) {
  const bin = temp.make("bin-");
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

async function runShell(script: string, env: Record<string, string>, stdin?: string) {
  const child = Bun.spawn(["sh", "-c", script], { env, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

const remotePart = (command: string) => command.slice(command.indexOf("'") + 1, command.lastIndexOf("'"));
const blockWith = (text: string, start: string, holding = "") => blocksIn(text).find((block) => block.startsWith(start) && block.includes(holding))!.trim();

function flagValues(flag: string) {
  const code = [guide(), ...notePaths().map((path) => readFileSync(join(root, path), "utf8"))].flatMap(codeIn).join("\n");
  return [...code.matchAll(new RegExp(`${flag} (\\S+)`, "g"))].map((match) => match[1]!.replace(/'$/, "")).filter((value) => !value.startsWith("<"));
}

const presets = () => JSON.parse(readFileSync(join(root, "presets.json"), "utf8")) as Array<{ id: string; packs: string[] }>;

function packRows() {
  return [...guide().matchAll(/^\| `([a-z-]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].map((match) => ({ name: match[1]!, summary: match[2]!, note: match[4]! }));
}

async function hedgeCommands() {
  let usage = "";
  await main(["help"], { home: "/nonexistent", engineRoot: root, platform: "darwin", print: (line) => (usage += `${line}\n`) });
  const commandFiles = (dir: string) => (existsSync(join(dir, "commands")) ? readdirSync(join(dir, "commands")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => name.slice(0, -3)) : []);
  const shipped = (await loadPacks(root)).flatMap(({ dir, code }) => [...Object.keys(code?.commands ?? {}), ...commandFiles(dir)]);
  return new Set(["help", ...shipped, ...[...usage.matchAll(/^ {2}hedge ([a-z][a-z-]*)/gm)].map((match) => match[1])]);
}

describe("the agent setup guide", () => {
  test("runs only hedge commands that exist", async () => {
    const known = await hedgeCommands();
    const code = [guide(), ...notePaths().map((path) => readFileSync(join(root, path), "utf8"))].flatMap(codeIn);
    const used = code.flatMap((span) => [...span.matchAll(/\bhedge ([a-z][a-z-]*)\b/g)].map((match) => match[1]));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((command) => !known.has(command!))).toEqual([]);
  });

  test("turns workflows on or off only by ids that exist", async () => {
    const workflows = new Set((await manifests()).flatMap((manifest) => (manifest.workflows ?? []).map((workflow) => workflow.id)));
    const pairs = flagValues("--workflows").flatMap((value) => value.split(","));
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.filter((pair) => !/^[a-z-]+=(on|off)$/.test(pair) || !workflows.has(pair.split("=")[0]!))).toEqual([]);
  });

  test("sets only settings that exist", async () => {
    const settings = new Set((await manifests()).flatMap((manifest) => (manifest.settings ?? []).map((setting) => setting.key)));
    const keys = flagValues("--set").map((value) => value.split("=")[0]!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !settings.has(key))).toEqual([]);
  });

  test("its hedge setup command sets up each preset to the end, or stops only at a step that a note of its packs walks through", async () => {
    const noteAnswers: Record<string, string[]> = { slack: ["--set", "slack.userId=U012ABCDEF"] };
    const noteSteps: Record<string, string> = { slack: "Make your own Slack app" };
    for (const preset of presets()) {
      const home = temp.make("home-");
      const args = [...setupArgs().replace("<id>", preset.id).replace("<claude|codex|both>", "both").split(" "), ...preset.packs.flatMap((pack) => noteAnswers[pack] ?? [])];
      const result = await hedgeSetup(home, args, [], fakeMachine(home));
      const stops = preset.packs.flatMap((pack) => (noteSteps[pack] ? [noteSteps[pack]] : []));
      const needs = [...result.output.matchAll(/^ {2}Needs you: (.+)$/gm)].map((match) => match[1]!);
      expect({ code: result.code, prompts: result.prompts, packs: savedAnswers(home).packs, needs: needs.map((line) => stops.find((stop) => line.startsWith(stop)) ?? line) }).toEqual({ code: stops.length ? 2 : 0, prompts: [], packs: preset.packs, needs: stops });
    }
  });

  test("on a fresh Coder hub, step 7 names the hub right after hedge setup, so a pack note's hub-only command, such as incident.io's hedge page, runs there before step 9", async () => {
    const hedgeCommandsOf = (text: string) => codeIn(text).flatMap((code) => [...code.matchAll(/; hedge ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)].map((match) => match[1]!));
    const inStep7 = hedgeCommandsOf(step(7));
    expect(inStep7.slice(inStep7.indexOf("setup"), inStep7.indexOf("setup") + 2)).toEqual(["setup", "hub here"]);
    expect(codeIn(readFileSync(join(root, "packs/incident-io/SETUP.md"), "utf8")).join("\n")).toContain(`; hedge page --key setup-check --title "Setup check" --dry-run'`);

    let alerts = 0;
    const incident = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (alerts++, new Response("{}", { status: 202 })) });
    const sourceUrl = `http://127.0.0.1:${incident.port}/v2/alert_events/http/hedgesetupcheck`;
    const runOnHub = async (order: "guide" | "without hub here") => {
      const home = temp.make("hub-home-");
      const box = fakeMachine(home);
      const io = scripted([]);
      const env = { CODER: "true", CODER_AGENT_URL: "https://coder.example.com", CODER_WORKSPACE_NAME: "hedge-hub" };
      const onHub = (args: string[], stdin?: string) => main(args, { home, engineRoot: root, platform: "linux", env, hostname: () => "hedge-hub", print: io.terminal.print, fail: io.terminal.print, terminal: io.terminal, apply: async () => 0, stdin: () => new Response(stdin ?? "").body!, setup: { machine: box.machine, clock: box.clock, doctor: async () => 0, env, timeZone: "UTC" } });
      const args = setupArgs().replace("<id>", "starter").replace("<claude|codex|both>", "codex").split(" ");
      expect(await onHub(["setup", ...args, "--add", "incident-io", "--workflows", "page-owner=on"])).toBe(0);
      if (order === "guide") expect(await onHub(["hub", "here"])).toBe(0);
      const saved = await onHub(["page", "setup", sourceUrl], "token-from-the-secret-prompt\n");
      const dryRun = await onHub(["page", "--key", "setup-check", "--title", "Setup check", "--dry-run"]);
      return { saved, dryRun, output: io.output() };
    };
    try {
      const refused = await runOnHub("without hub here");
      expect([refused.saved === 0, refused.dryRun === 0]).toEqual([false, false]);
      expect(refused.output).toContain("hedge page runs on the hub. Run it there.");
      const inOrder = await runOnHub("guide");
      expect([inOrder.saved, inOrder.dryRun]).toEqual([0, 0]);
      expect(inOrder.output).toContain("hedge page: saved the alert source.");
      expect(inOrder.output).toContain("hedge page: dry run, nothing sent.");
      expect(inOrder.output).not.toContain("runs on the hub");
      expect(alerts).toBe(0);
    } finally {
      incident.stop(true);
    }
  });

  test("on the hub, its hedge setup command waits for GitHub and ChatGPT in the browser, stops for Claude, and finishes after the guide's Claude sign-in in a terminal", async () => {
    const home = temp.make("home-");
    const args = setupArgs().replace("<id>", "everyday").replace("<claude|codex|both>", "both").split(" ");
    const hub = fakeMachine(home, { github: 5, claude: 1, chatgpt: 4 });
    const first = await hedgeSetup(home, args, [], hub);
    expect(first.code).toBe(2);
    expect(first.output).toContain("  Needs you: Sign in to Claude\n  In a terminal, run: claude auth login\n");
    expect(codeIn(step(7))).toContain(`ssh -t coder.<hub> 'export PATH="${guidePath}"; claude auth login'\n`);
    await hub.machine.run(["claude", "auth", "login"], { input: true });
    const again = await hedgeSetup(home, args, [], hub);
    expect(again.code).toBe(0);
    expect(again.output).toContain("✓ Ready to use. Start a new thread in T3 Code now.");
  });

  test("offers every pack setup can turn on, in the words of its own summary", async () => {
    const rows = packRows();
    const packs = (await loadPacks(root)).map((pack) => pack.manifest).filter((manifest) => manifest.name !== "base");
    expect(rows.map((row) => row.name).sort()).toEqual(packs.map((manifest) => manifest.name).sort());
    expect(rows.filter((row) => row.summary !== packs.find((manifest) => manifest.name === row.name)?.summary)).toEqual([]);
  });

  test("gives each pack its own setup note that is in the repo, or says it needs none, and names every note the packs hold", () => {
    const rows = packRows();
    const notes = rows.filter((row) => row.note.startsWith("`")).map((row) => ({ name: row.name, path: row.note.slice(1, -1) }));
    expect(notes.length).toBeGreaterThan(0);
    expect(rows.filter((row) => !row.note.startsWith("`") && row.note !== "None")).toEqual([]);
    expect(notes.filter(({ name, path }) => path !== `packs/${name}/SETUP.md` || !existsSync(join(root, path)))).toEqual([]);
    const held = readdirSync(join(root, "packs")).filter((pack) => existsSync(join(root, "packs", pack, "SETUP.md")));
    expect(notes.map((note) => note.name).sort()).toEqual(held.sort());
  });

  test("steps 4 and 5 give the hub a 200 GB disk and each node a 500 GB disk", () => {
    expect(words(step(4))).toContain("one **hub** with a 200 GB disk and one **node** with a 500 GB disk");
    expect(words(step(5))).toContain("Give the hub a 200 GB disk and each node a 500 GB disk.");
  });

  test("the guide's one coder create command passes the disk, region, dotfiles, and every other parameter with --parameter, with --preset none and --yes", () => {
    const creates = codeIn(guide()).filter((code) => code.startsWith("coder create "));
    expect(creates).toEqual(["coder create <name> --template <template> --preset none --parameter <disk parameter>=<200 or 500> --parameter <region parameter>=<region> --parameter <dotfiles parameter>=git@github.com:<profile repo>.git --parameter <other parameter>=<value> --yes\n"]);
    expect(words(step(5))).toContain("Pass each parameter with its own `--parameter`, also those where the default is right, so Coder asks nothing");
  });

  test("no command line in the guide or a pack note has --rich-parameter-file, --parameter-default, coder secret, or a --parameter value that the shell fills in", () => {
    const lines = [guide(), ...notePaths().map((path) => readFileSync(join(root, path), "utf8"))].flatMap(codeIn).flatMap((code) => code.split("\n"));
    expect(lines.filter((line) => /--parameter[ =][^ =]*=[^ ]*[$`]|--rich-parameter-file|--parameter-default|coder secret /.test(line))).toEqual([]);
  });

  test("checks each new workspace with the engine's own check, given only the parameters the guide sets and no private value, and replaces a workspace whose fixed parameter is wrong before setup", () => {
    const code = codeIn(step(5));
    const fetched = code.find((line) => line.includes("/scripts/check-workspace.sh -o "))!;
    const script = fetched.match(/main\/(scripts\/check-workspace\.sh)/)![1]!;
    expect(existsSync(join(root, script))).toBe(true);
    expect(code).toContain("sh ~/.cache/hedge-setup/check-workspace.sh <name> <parameter>=<value> <parameter>=<value>\n");
    expect(code.join("\n")).not.toMatch(/\$dir\/session|Coder-Session-Token/);
    expect(words(step(5))).toContain("the disk size, the region, the instance type, and the dotfiles repo. Never pass a private value to the check");
    expect(words(step(5))).toContain("A parameter that the template does not let change, such as the disk size or the region, needs a new workspace: ask, then `coder delete <name>` and create it again, before setup touches it.");
  });

  test("changes a parameter in the workspace's Settings in the Coder web app, as the check says, and never with the Coder CLI", () => {
    const texts = [guide(), readFileSync(join(root, "docs/getting-started.md"), "utf8")];
    expect(texts.flatMap(cliParameterChanges)).toEqual([]);
    const flagged = (markdown: string) => cliParameterChanges(markdown).length > 0;
    const rejected = ["Run `coder start`.", "Run `coder --verbose restart hub`.", "Run `CODER_URL=x coder --url x 'restart'\nhub`.", "```sh\na && coder update hub\n```\n", "```sh\ncoder --verbose \\\n  restart hub\n```\n", "```sh\ncoder re\\\nstart hub\n```\n", "1. Step:\n\n   ```sh\n   coder\\\n     restart hub\n   ```\n"];
    const kept = ["Keep `coder create start --template dev`.", "Keep `coder schedule start hub`.", "Its restart command can ask for a parameter."];
    expect([rejected.map(flagged), kept.map(flagged)]).toEqual([rejected.map(() => true), kept.map(() => false)]);
    for (const text of texts) expect(text.replace(/\s+/g, " ")).toContain("**Settings → Parameters**");
    const printed = fakeCoder(temp, { parameters: { instance_type: "m7g.xlarge" }, mutable: { instance_type: true } }).check(["instance_type=m7g.4xlarge"]);
    expect([printed.code, printed.output]).toEqual([1, "x instance_type is not the value you passed. In the Coder web app, set it under Settings, Parameters, and submit.\nok hedge-hub runs and stays on\n"]);
  });

  test("reads the parameters of the template's active version with the engine's script, prints no free-text default, no default or option of a masked, password or secret-named field, and keeps the session token off every command line", async () => {
    const fixtures = temp.make("coder-");
    writeFileSync(join(fixtures, "templates.json"), JSON.stringify([{ Template: { name: "other", active_version_id: "v-other" } }, { Template: { name: "dev", active_version_id: "v-active" } }]));
    const credential = ["ghp", "fixture", "default", "credential"].join("-");
    const key = ["fixture", "ssh", "key", "default"].join("-");
    const masked = ["masked", "fixture", "default"].join("-");
    const maskedOption = ["masked", "fixture", "option"].join("-");
    const password = String(Date.now() % 9000 + 1000);
    const namedOption = ["named", "fixture", "option"].join("-");
    writeFileSync(join(fixtures, "parameters.json"), JSON.stringify([
      { name: "disk_size", display_name: "Disk size", type: "number", mutable: false, default_value: "100", options: [] },
      { name: "region", type: "string", default_value: "us-east-1", options: [{ value: "us-east-1" }, { value: "eu-central-1" }] },
      { name: "dotfiles_uri", type: "string", mutable: true, default_value: "" },
      { name: "jetbrains", type: "bool", default_value: "false" },
      { name: "github_pat", display_name: "GitHub", description: "A personal access token", type: "string", mutable: true, default_value: credential },
      { name: "ssh_key", type: "string", default_value: key },
      { name: "agent_config", description: "Settings", type: "string", default_value: masked, styling: { mask_input: true }, options: [{ value: masked }, { value: maskedOption }] },
      { name: "pin", type: "number", form_type: "password", default_value: password },
      { name: "api_key", type: "string", default_value: namedOption, options: [{ value: namedOption }] },
      { name: "scratch", type: "string", ephemeral: true, default_value: "x" },
    ]));
    const bin = fakeTools({
      coder: `case "$*" in\n  "templates list -o json") cat "${fixtures}/templates.json" ;;\n  "whoami -o json") printf '[{"url":"https://coder.example.com"}]' ;;\n  "login token") echo stored-session ;;\n  *) exit 1 ;;\nesac`,
      curl: `for url; do :; done\n[ "$(cat)" = "Coder-Session-Token: $CODER_ACCEPTS" ] || exit 22\n[ "$url" = https://coder.example.com/api/v2/templateversions/v-active/rich-parameters ] || exit 22\nprintf '%s ' "$@" > "${fixtures}/curl-args"\ncat "${fixtures}/parameters.json"`,
    });
    const code = codeIn(step(5));
    expect(code).toContainEqual(expect.stringContaining("https://raw.githubusercontent.com/PostHog/hedge/main/scripts/template-parameters.sh -o ~/.cache/hedge-setup/template-parameters.sh"));
    const command = code.find((line) => line.startsWith("sh ~/.cache/hedge-setup/template-parameters.sh "))!.trim().replace("~/.cache/hedge-setup/template-parameters.sh", join(root, "scripts/template-parameters.sh")).replace("<template>", "dev");
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: fixtures };

    const stored = await runShell(command, { ...env, CODER_ACCEPTS: "stored-session" });
    const fromEnvironment = await runShell(command, { ...env, CODER_SESSION_TOKEN: "environment-session", CODER_ACCEPTS: "environment-session" });

    expect([stored.code, stored.stderr]).toEqual([0, ""]);
    expect(stored.stdout).toBe(["disk_size (Disk size): number, default 100", "region: string, default us-east-1, options us-east-1 | eu-central-1", "dotfiles_uri: string, mutable, no default", "jetbrains: bool, default false", "github_pat (GitHub): string, mutable, secret, default hidden", "ssh_key: string, default hidden", "agent_config: string, secret, default hidden", "pin: number, secret, default hidden", "api_key: string, secret, default hidden", "scratch: string, ephemeral, default hidden", ""].join("\n"));
    for (const value of [credential, key, masked, maskedOption, password, namedOption]) expect(stored.stdout).not.toContain(value);
    expect([fromEnvironment.code, fromEnvironment.stdout]).toEqual([0, stored.stdout]);
    expect(readFileSync(join(fixtures, "curl-args"), "utf8")).not.toContain("session");
    expect(blocksIn(guide()).join("\n")).not.toContain("coder templates pull");
  });

  test("gives the dotfiles the private profile's SSH address, names the dotfiles branch, and says a fresh node's start script fails until hedge devbox add", () => {
    expect(words(guide())).not.toMatch(/dotfiles parameter[^.]*https:\/\/github\.com\/<|`https:\/\/github\.com\/<repo>`/);
    expect(words(step(5))).toContain("| The dotfiles | Pass the profile repo of item 3, as `git@github.com:<profile repo>.git`. |");
    expect(words(step(5))).toContain("| The dotfiles branch, such as `dotfiles_branch` |");
    expect(words(step(7))).toContain("change the dotfiles parameter of each workspace to `git@github.com:<repo>.git`");
    expect(words(step(5))).toContain("each `ssh coder.<node>` prints `A startup script exited with an error` and the start log. That is expected");
  });

  test("checks the hub's own Coder session before it makes a token, and when Coder forbids tokens, asks for one as a file", () => {
    const code = codeIn(step(7)).join("\n");
    const whoami = code.indexOf(onHubLine("coder whoami && coder config-ssh --yes"));
    expect(whoami).toBeGreaterThanOrEqual(0);
    expect(whoami).toBeLessThan(code.indexOf("coder tokens create | ssh coder.<hub>"));
    expect(words(step(7))).toContain("When `coder tokens create` prints `rbac: forbidden`, the Coder deployment forbids its members to make tokens");
  });

  test("the hub reads the whole Coder token from standard input, also without a final new line, and refuses an empty one", async () => {
    const fixtures = temp.make("coder-");
    const bin = fakeTools({ coder: `case "$1" in\n  login) printf '%s|%s' "$*" "$CODER_SESSION_TOKEN" > "${fixtures}/login" ;;\n  config-ssh) touch "${fixtures}/ssh-config" ;;\n  *) exit 1 ;;\nesac` });
    const remote = remotePart(blockWith(step(7), "coder tokens create | ssh coder.<hub> '")).replaceAll("<coder address>", "https://coder.example.com");
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: fixtures };
    const token = ["fixture", "session", "token"].join("-");

    const fromFile = await runShell(remote, env, token);
    expect(fromFile.code).toBe(0);
    expect(readFileSync(join(fixtures, "login"), "utf8")).toBe(`login --use-token-as-session https://coder.example.com|${token}`);
    expect(existsSync(join(fixtures, "ssh-config"))).toBe(true);

    const fromPipe = await runShell(remote, env, `${token}2\n`);
    expect([fromPipe.code, readFileSync(join(fixtures, "login"), "utf8")]).toEqual([0, `login --use-token-as-session https://coder.example.com|${token}2`]);

    const empty = await runShell(remote, { ...env, HOME: temp.make("coder-") }, "\n");
    expect([empty.code, empty.stderr]).toEqual([1, "No Coder token came in.\n"]);
  });

  test("on a rerun, says the profile's packs win over the page's picks", () => {
    expect(words(step(1))).toContain("The profile's packs win over the picks from the page.");
    expect(words(beforeSteps("## Picks from the page"))).toContain("the packs in their profile win over the page's picks");
  });

  test("checks only the earlier hub the person names, never every workspace", () => {
    expect(words(step(1))).toContain("Check only the workspace they name. Never check every workspace");
    expect(words(step(1))).not.toContain("For each workspace that runs");
  });

  test("names the hub before setup runs again when the gateway needs it, for the To do line of code 2 and the Fix line of the last check", () => {
    expect(words(step(7))).toContain("a line `To do: This machine cannot reach the MCP gateway` or `Fix: This machine cannot reach the MCP gateway` means that the profile turns on the MCP gateway, and the gateway needs a named hub. Run `hedge hub status` on the hub. When it prints `The hub: not named.`, run the `hedge hub here` of item 4 now.");
  });

  test("the Hub note sends the proxy's Claude callback from a file to the waiting sign-in, past the hub's proxy, and never shows its code", async () => {
    const received: string[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => (received.push(new URL(request.url).pathname + new URL(request.url).search), new Response("signed in\n")) });
    try {
      const note = readFileSync(join(root, "packs/hub/SETUP.md"), "utf8");
      const remote = remotePart(blockWith(note, "ssh coder.<hub> '", "url = "));
      const code = ["one", "time", "fixture"].join("-");
      const proxy = "http://127.0.0.1:9";
      const sent = await runShell(remote, { PATH: process.env.PATH ?? "", http_proxy: proxy, HTTP_PROXY: proxy, all_proxy: proxy }, `http://localhost:${server.port}/callback?code=${code}&state=s`);
      expect(sent.code).toBe(0);
      expect(received).toEqual([`/callback?code=${code}&state=s`]);
      expect(`${sent.stdout}${sent.stderr}`).not.toContain(code);
      expect(words(note)).toContain("Ask for that whole address with the secret prompt, delivered as a file");
    } finally {
      server.stop(true);
    }
  });

  test("adds the profile folder that the hub applies as its T3 Code project, also a Coder dotfiles checkout", async () => {
    const home = temp.make("hub-");
    const checkout = join(home, ".config/coderv2/dotfiles");
    await saveMachine(home, { schema: 1, role: "hub", name: "hedge-hub", profileDir: checkout });
    const bin = fakeTools({ t3: `printf '%s\\n' "$@" > "${home}/t3-args"` });
    const remote = remotePart(blockWith(step(11), "ssh coder.<hub> '", "t3 project add"));
    const added = await runShell(remote, { PATH: `${bin}:/usr/bin:/bin`, HOME: home });
    expect(added.code).toBe(0);
    expect(readFileSync(join(home, "t3-args"), "utf8")).toBe(["project", "add", "--title", "hedge-profile", checkout, ""].join("\n"));
    expect(words(step(11))).toContain("open a thread in the `hedge-profile` project");
  });

  test("follows a team pack's own setup note first, at the path where setup keeps that team's pack", async () => {
    expect(words(hubStep())).toContain("When step 7 printed that a team pack is ticked");
    const notePath = codeIn(hubStep()).join("\n").match(/~\/\S+\/packs\/<pack>\/SETUP\.md/)?.[0];
    const home = temp.make("home-");
    const teamRepo = temp.make("team-pack-");
    cpSync(join(root, "packs", "hub"), join(teamRepo, "packs", "hub"), { recursive: true });
    await spawnGit(teamRepo, "init", "-q", "-b", "main");
    await spawnGit(teamRepo, "add", ".");
    await spawnGit(teamRepo, "commit", "-q", "-m", "team pack");
    const source = await fetchSource({ name: "team", repo: teamRepo, ref: "main" }, sourceCache(home));
    const pack = "packs" in source ? source.packs.find((loaded) => loaded.manifest.name === "hub") : undefined;
    const guidePathOfNote = notePath?.replace("~", home).replace("<source>", "team").replace("<pack>", "hub");
    expect(guidePathOfNote).toBe(join(pack!.dir, "SETUP.md"));
    expect(existsSync(guidePathOfNote!)).toBe(true);
  });

  test("keeps the hub and the nodes running while the Mac sleeps, and checks the running build's stop time after", () => {
    const text = guide();
    const schedule = text.indexOf("`coder schedule stop <name> manual`");
    const check = text.indexOf("sh ~/.cache/hedge-setup/check-workspace.sh <name>");
    expect([schedule >= 0, check >= 0, schedule < check]).toEqual([true, true, true]);
  });

  test("a change to an earlier setup ends at step 8, so step 9's first-install defaults never turn off a workflow the person did not name", () => {
    expect(words(step(1))).toContain("Then check the hub as in step 8, and end there. Skip step 9: its command sets first-install defaults, such as `mcp-gateway=off`, that would change what they did not name.");
    expect(words(hubStep())).toContain("Item 2 runs only on a first setup, because its command sets first-install defaults.");
  });

  test("a rerun of setup still adds each node that step 5 created, and skips only the first-install pack defaults", () => {
    expect(words(step(1))).toContain("Skip step 5 for the hub.");
    expect(words(hubStep())).toContain("On a rerun of setup (step 1), skip item 2, and run items 1, 3, and 4 for each node that step 5 created.");
    expect(words(hubStep())).not.toContain("This step runs only on a first setup");
  });

  async function boxAddress(box: (home: string) => ReturnType<typeof fakeMachine>) {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const command = codeIn(step(10)).map((line) => line.match(/^ssh coder\.<name> '[^']*; hedge (devbox address)'\n$/)?.[1]).find(Boolean);
    const io = scripted([]);
    const code = await main(command!.split(" "), { home, engineRoot: root, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box(home).machine } });
    return { code, output: io.output() };
  }

  test("pairs a box that T3 Code does not list through the address its live T3 server gives, also when t3 connect status prints none, and never through the loopback pairing URL", async () => {
    const code = codeIn(step(10));
    const address = code.indexOf(`ssh coder.<name> 'export PATH="${guidePath}"; hedge devbox address'\n`);
    const token = code.indexOf(`ssh coder.<name> 'export PATH="${guidePath}"; t3 pair --ttl 10m --label t3-app'\n`);
    expect([address >= 0, address < token]).toEqual([true, true]);
    expect(await boxAddress((home) => fakeMachine(home, {}, { connectHere: true }))).toEqual({ code: 0, output: "https://here.relay.example" });
    expect(words(step(10))).toContain("Give the person the address and the token after `Token:`.");
    expect(words(step(10))).toContain("Never give the `Pairing URL` it prints");
  });

  test("stops where the address lookup says it found none, makes no token without an address, and sends no box through an update", async () => {
    const pairing = words(step(10));
    const off = await boxAddress((home) => fakeMachine(home));
    const none = await boxAddress((home) => fakeMachine(home, {}, { connectHere: true, serverWithoutLinkState: ["here"] }));
    expect([off.code, none.code]).toEqual([1, 1]);
    expect(off.output).toContain("T3 Connect is off");
    expect(pairing).toContain("When it says that T3 Connect is off, start it on that box as in item 5 of step 7");
    expect(none.output).toContain("gives no tunnel address");
    expect(pairing).toContain("When it says that T3 Code gives no tunnel address, stop, and make no token. Tell the person that this box does not report its address yet, and pair it later.");
    expect(pairing.indexOf("Make a pairing token only once you have the address")).toBeGreaterThan(pairing.indexOf("gives no tunnel address"));
    expect(pairing).not.toContain("agent-update");
    expect(pairing).not.toContain("tunnelHostname");
  });

  test("checks each workspace with a hedge doctor that sets the guide's PATH over SSH", () => {
    expect(codeIn(guide())).toContain(`ssh coder.<name> 'export PATH="${guidePath}"; hedge doctor'\n`);
  });

  test("says how to add a node later", () => {
    expect(words(hubStep())).toContain("To add a node later, when the load grows, create it as in step 5 with the next node name and a 500 GB disk, then run item 3 above for it");
  });

  test("signs the hub in to Coder, sets Hedge up there, names it the hub, turns the hub packs on there, and only then adds each node from the hub", () => {
    const code = codeIn(guide()).join("\n");
    const order = [
      code.indexOf("coder tokens create | ssh coder.<hub>"),
      code.indexOf(`; hedge setup --chat `),
      code.indexOf(onHubLine("hedge hub here")),
      code.indexOf(onHubLine("hedge packs --add hub --workflows mcp-gateway=off")),
      code.indexOf(`ssh -t coder.<hub> 'export PATH="${guidePath}"; hedge devbox add coder.<node>'`),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("installs nothing from Hedge on the Mac: every hedge command runs over SSH on a cloud box", () => {
    const local = blocksIn(guide()).flatMap((code) => code.split("\n")).filter((line) => /(^|[;&|] *)(hedge|sh [^ ]*get\.sh) /.test(line) && !line.includes("ssh "));
    expect(local).toEqual([]);
  });

  test("says how to use each line the page's prompt can carry", async () => {
    const data = await pageData({ audience: "public" });
    const prompt = startPrompt(data, { off: [] });
    const labels = [...prompt.matchAll(/^- ([^:]+): /gm)].map((match) => match[1]!);
    expect(new Set(labels)).toEqual(new Set(Object.values(promptLabels).filter((label) => label !== promptLabels.intro)));
    const [, intro] = prompt.split("\n\n");
    expect(words(guide())).toContain(`\`${intro!.split("\n")[0]}\``);
    const picks = beforeSteps("## Picks from the page");
    const rows = [...picks.matchAll(/^\| `([^`|]+)` \| [^|]+ \|$/gm)].map((match) => match[1]!);
    expect(rows).toEqual(labels);
  });

  test("still says how to use each line that only a prompt from the earlier page carries, and skips the hub packs when that prompt names none", () => {
    const picks = words(beforeSteps("## Picks from the page"));
    expect(picks).toContain("A prompt from an earlier page can carry more lines. Use them too:");
    expect(picks).toContain("- `Workflows on the first setup` and `Workflows once the hub runs`: add the list to the command of that step as `--workflows`, without the spaces.");
    expect(picks).toContain("- `Setting`: add `--set <key>=<value>` to the setup command in step 7, once for each line.");
    expect(picks).toContain("`none` means no pack, so skip item 2.");
    expect(words(guide())).toContain("With picks from the page, leave out `--add hub` when the line does not name `hub`:");
  });

  test("takes a first setup with every pack switched off, and leaves workflows and settings to each pack's setup note", async () => {
    const data = await pageData({ audience: "public" });
    const text = words(guide());
    expect(startPrompt(data, { off: data.startPacks })).toContain("- Packs on the first setup: none");
    expect(text).toContain("`none` means no pack.");
    expect(text).toContain("The page names packs only. Each pack's setup note still asks which of its workflows to turn on and which settings it needs.");
  });

  test("offers in step 9 the packs the page keeps for a hub, and every other pack on the first setup", () => {
    const offer = (name: string) => guide().match(new RegExp(`^\\| \`${name}\` \\| [^|]+ \\| ([^|]+) \\|`, "m"))?.[1];
    expect(needsHubPacks.map(offer)).toEqual(needsHubPacks.map(() => "Step 9"));
    const others = packRows().map((row) => row.name).filter((name) => !needsHubPacks.includes(name));
    expect(others.map(offer)).toEqual(others.map(() => "Always"));
  });

  test("offers the Hub pack and the packs that need a running hub in step 9, each with its setup note", () => {
    const later = packRows().filter((row) => ["hub", "mcp-gateway"].includes(row.name));
    expect(later.map((row) => row.note)).toEqual(["`packs/hub/SETUP.md`", "`packs/mcp-gateway/SETUP.md`"]);
    for (const name of ["hub", "mcp-gateway"]) expect(words(hubStep())).toContain(`\`packs/${name}/SETUP.md\``);
  });

  test("gives every command in the guide and the pack notes the same PATH, with Bun's Homebrew folders on it", () => {
    const notes = readdirSync(join(root, "packs")).map((pack) => join(root, "packs", pack, "SETUP.md")).filter(existsSync);
    const paths = [guide(), ...notes.map((path) => readFileSync(path, "utf8"))].flatMap((text) => [...text.matchAll(/export PATH="([^"]+)"/g)].map((match) => match[1]));
    expect(paths.length).toBeGreaterThan(1);
    expect(new Set(paths)).toEqual(new Set([guidePath]));
  });

  test("names only files that are in the repo", () => {
    const files = [...guide().matchAll(/`([\w./-]+\.(?:json|md|svg|ts|sh|html))`|\]\((?!https?:|#|\/)([^)#\s]+)/g)].map((match) => (match[1] ?? match[2])!);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !existsSync(join(root, file)))).toEqual([]);
  });

  test("signs in to Coder with a token from the secret prompt, and says where to make it", () => {
    expect(words(step(1))).toContain("make one at `<coder address>/cli-auth`");
    expect(codeIn(step(1))).toContain('CODER_SESSION_TOKEN="$(cat <file>)" coder login <coder address>\n');
  });

  test("explains a workflow in one plain line the first time it tells the person what Hedge is, whatever they know", () => {
    const show = words(step(3));
    expect(show).toContain("A **workflow** is one way of working that agents follow, such as a draft pull request for every fix.");
    expect(show.indexOf("**workflow**")).toBeLessThan(show.indexOf("**pack**"));
  });

  test("uses each long wait to explain one thing, from each step that waits", () => {
    const waits = words(beforeSteps("## While something runs"));
    for (const topic of ["**T3 Code's inbox.**", "**The Slack trigger.**", "**Threads on nodes.**", "**What runs each night.**"]) expect(waits).toContain(topic);
    for (const number of [5, 7, 9]) expect([number, words(step(number))]).toEqual([number, expect.stringContaining("(see \"While something runs\")")]);
  });

  test("when the person takes Hedge's version of a kept file, the old file is in the backup folder the guide names", async () => {
    const backups = codeIn(guide()).find((code) => code.startsWith("~/.local/state/hedge/backups"));
    const home = temp.make("home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/AGENTS.md"), "my own codex rules\n");
    const kept = await cli.hedge(["apply", "--profile", cli.profileDir()], home);
    const adopt = kept.output.match(/Run (hedge apply --adopt \S+) to take Hedge's version/)?.[1];
    expect(adopt).toBe("hedge apply --adopt .codex/AGENTS.md");
    expect((await cli.hedge([...adopt!.split(" ").slice(1), "--profile", cli.profileDir()], home)).code).toBe(0);
    const folder = backups!.replace("~", home).replace(/\/$/, "");
    expect(readdirSync(folder).map((run) => readFileSync(join(folder, run, ".codex/AGENTS.md"), "utf8"))).toEqual(["my own codex rules\n"]);
  });

  test("rules moved to the profile's About me file reach the agents after the packs' rules", async () => {
    expect(words(guide())).toContain("to the \"About me\" file in their profile, which agents read after the packs' rules");
    const home = temp.make("home-");
    expect((await cli.hedge(["apply", "--profile", cli.profileDir([], "# About me\n\nI like small diffs.\n")], home)).code).toBe(0);
    expect(readFileSync(join(home, ".claude/rules/hedge.md"), "utf8")).toContain("I like small diffs.");
  });

  test("a second setup without --preset, as the guide says, reuses the profile and keeps its packs, workflows, and settings", async () => {
    expect(words(step(1))).toContain("In the step 7 command, leave out `--preset`, and name only what changes with `--add`, `--remove`, and `--workflows`.");
    const command = setupArgs().replace("<claude|codex|both>", "codex");
    const home = temp.make("home-");
    const box = fakeMachine(home);
    const first = await hedgeSetup(home, [...command.replace("<id>", "everyday").split(" "), "--add", "guards", "--workflows", "oom-survival=on", "--set", "orchestration.tracker=nora/maps"], [], box);
    const again = await hedgeSetup(home, [...command.replace("--preset <id> ", "").split(" "), "--add", "integrations"], [], box);
    expect({ first: first.code, again: again.code }).toEqual({ first: 0, again: 0 });
    expect(again.output).toContain("Reusing your repo nora/nora-hedge");
    expect(savedAnswers(home).packs).toEqual([...presets().find((preset) => preset.id === "everyday")!.packs, "guards", "integrations"]);
    expect(savedAnswers(home).workflows["oom-survival"]).toBe(true);
    expect(savedAnswers(home).settings["orchestration.tracker"]).toBe("nora/maps");
  });

  test("the guide's cleanup runs hedge devbox remove, and a host it takes out of the profile leaves the hub's list of machines", () => {
    expect(codeIn(hubStep())).toContain(onHubLine("hedge devbox remove coder.<old name>") + "\n");
    expect(words(hubStep())).toContain("It takes the old host out of their profile");
    const home = temp.make("home-");
    const profile = profilePath(home);
    mkdirSync(profile, { recursive: true });
    const save = (devboxes: string[]) => writeFileSync(join(profile, "hedge.json"), JSON.stringify({ schema: 1, hub: "coder.hub", devboxes }));
    save(["coder.hub", "coder.old-node", "coder.node"]);
    expect(devboxesOf({ HEDGE_PROFILE_DIR: profile }, home)).toContain("coder.old-node");
    save(["coder.hub", "coder.node"]);
    expect(devboxesOf({ HEDGE_PROFILE_DIR: profile }, home)).toEqual(["coder.hub", "coder.node"]);
  });

  test("fetches only files that are in the repo", () => {
    const paths = [...guide().matchAll(/https:\/\/raw\.githubusercontent\.com\/PostHog\/hedge\/main\/(\S+?)[`)\s]/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });
});
