import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getShHarness, onLinuxHost } from "./testing/get-sh.ts";
import { legacyPaths } from "./legacy.ts";

const { sandbox, getSh } = getShHarness();

describe("hedge on the PATH", () => {
  test("puts hedge into ~/.local/bin, where it runs the engine even from a directory it cannot read", () => {
    const box = sandbox("Linux");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    const hedge = join(box.home, ".local/bin/hedge");
    const unreadable = join(box.root, "unreadable");
    mkdirSync(unreadable, { mode: 0o100 });
    const result = Bun.spawnSync([hedge, "--help"], { cwd: unreadable, env: { PATH: box.bin, HOME: box.home } });
    chmodSync(unreadable, 0o700);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toStartWith("Hedge: one setup for T3 Code, agents, and your workflows");
    expect(result.exitCode).toBe(0);
  });

  test("on Linux adds the PATH line to ~/.profile once and keeps the lines already there", () => {
    const box = sandbox("Linux");
    writeFileSync(join(box.home, ".profile"), "umask 022\n");
    const first = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    const second = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(readFileSync(join(box.home, ".profile"), "utf8")).toBe('umask 022\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" # Added by Hedge\n');
    expect(first.output).toContain("Hedge: Open a new terminal to use hedge. ~/.profile now puts ~/.local/bin and ~/.bun/bin on your PATH.");
    expect(second.output).not.toContain("Open a new terminal");
  });

  test("on Linux uses ~/.bash_profile when it exists, because bash then skips ~/.profile", () => {
    const box = sandbox("Linux");
    writeFileSync(join(box.home, ".bash_profile"), ". ~/.bashrc\n");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/bin/bash" } }).code).toBe(0);
    expect(readFileSync(join(box.home, ".bash_profile"), "utf8")).toEndWith('export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" # Added by Hedge\n');
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
  });

  onLinuxHost("on macOS adds the PATH line, with Homebrew's bin, to ~/.zprofile once", () => {
    const box = sandbox("Darwin");
    box.stub("brew", "exit 0");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    expect(readFileSync(join(box.home, ".zprofile"), "utf8")).toBe('export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH" # Added by Hedge\n');
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
  });

  test("replaces its own hedge in ~/.local/bin and leaves another hedge there alone", () => {
    const box = sandbox("Linux");
    const hedge = join(box.home, ".local/bin/hedge");
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    writeFileSync(hedge, "#!/bin/sh\n# Hedge\nexit 3\n");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    expect(readFileSync(hedge, "utf8")).toBe(`#!/bin/sh\n# Hedge\nexec sh '${join(box.home, ".local/share/hedge/engine/hedge")}' "$@"\n`);
    writeFileSync(hedge, "#!/bin/sh\necho someone else's hedge\n");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(readFileSync(hedge, "utf8")).toBe("#!/bin/sh\necho someone else's hedge\n");
    const engine = join(box.home, ".local/share/hedge/engine/hedge");
    expect(result.output).toContain(`Hedge: ${hedge} is not Hedge's, so it stays as it is. Run Hedge with sh ${engine}.\n`);
    expect(readdirSync(join(box.home, ".local/bin")).sort()).toEqual(["fleet", "gh", "hedge", "t3"]);
  });

  test("puts fleet beside hedge as the same command, replacing the fleet that Hedge wrote before the rename", () => {
    const box = sandbox("Linux");
    const fleet = join(box.home, ".local/bin/fleet");
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    writeFileSync(fleet, "#!/bin/sh\n# Fleet\nexit 3\n");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    const ran = (command: string) => Bun.spawnSync([join(box.home, ".local/bin", command), "--help"], { cwd: box.home, env: { PATH: box.bin, HOME: box.home } });
    expect(ran("fleet").stdout.toString()).toBe(ran("hedge").stdout.toString());
    expect(ran("fleet").stdout.toString()).toStartWith("Hedge: one setup for T3 Code, agents, and your workflows");
    expect(ran("fleet").stderr.toString()).toBe("");
  });

  test("leaves another fleet in ~/.local/bin alone, and says nothing about it", () => {
    const box = sandbox("Linux");
    const fleet = join(box.home, ".local/bin/fleet");
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    writeFileSync(fleet, "#!/bin/sh\necho the private fleet\n");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(readFileSync(fleet, "utf8")).toBe("#!/bin/sh\necho the private fleet\n");
    expect(result.output).not.toContain("fleet");
  });

  test("moves the folders from before the rename to their new names and leaves a link at each old name", () => {
    const box = sandbox("Linux");
    mkdirSync(join(box.home, ".config/fleet"), { recursive: true });
    writeFileSync(join(box.home, ".config/fleet/machine.json"), "{}\n");
    mkdirSync(join(box.home, ".local/share/fleet-mcphub"), { recursive: true });
    mkdirSync(join(box.home, ".local/share/hedge-mcphub"), { recursive: true });
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    expect(readFileSync(join(box.home, ".config/hedge/machine.json"), "utf8")).toBe("{}\n");
    expect(readlinkSync(join(box.home, ".config/fleet"))).toBe("hedge");
    expect(lstatSync(join(box.home, ".local/share/fleet-mcphub")).isDirectory()).toBe(true);
  });

  test("moves the same paths as hedge apply", () => {
    const listed = /^legacy_paths="([^"]+)"$/m.exec(readFileSync(join(import.meta.dir, "../get.sh"), "utf8"))![1]!.split(" ").map((pair) => pair.split(":"));
    expect(listed).toEqual(legacyPaths.map((pair) => [...pair]));
  });

  test("takes FLEET_ENGINE_DIR when HEDGE_ENGINE_DIR is not set", () => {
    const box = sandbox("Linux");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { FLEET_ENGINE_DIR: join(box.root, "old-engine") } }).code).toBe(0);
    expect(existsSync(join(box.root, "old-engine/hedge"))).toBe(true);
    expect(readFileSync(join(box.home, ".local/bin/hedge"), "utf8")).toContain(join(box.root, "old-engine/hedge"));
  });

  test("writes a hedge that works from any directory when HEDGE_ENGINE_DIR is relative", () => {
    const box = sandbox("Linux");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { HEDGE_ENGINE_DIR: "engine" }, cwd: box.root }).code).toBe(0);
    const result = Bun.spawnSync([join(box.home, ".local/bin/hedge"), "--help"], { cwd: box.home, env: { PATH: box.bin, HOME: box.home } });
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toStartWith("Hedge: one setup for T3 Code, agents, and your workflows");
  });

  test("with bash as the login shell, uses ~/.bash_login when it exists and ~/.bash_profile does not, and starts the PATH line on a new line", () => {
    const box = sandbox("Linux");
    writeFileSync(join(box.home, ".bash_login"), "# existing comment");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/usr/bin/bash" } }).code).toBe(0);
    expect(readFileSync(join(box.home, ".bash_login"), "utf8")).toBe('# existing comment\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" # Added by Hedge\n');
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
    const login = Bun.spawnSync([Bun.which("bash") ?? "bash", "-lc", "command -v hedge"], { env: { PATH: "/usr/bin:/bin", HOME: box.home } });
    expect(login.stdout.toString().trim()).toBe(join(box.home, ".local/bin/hedge"));
  });

  test.if(Bun.which("zsh") !== null)("on Linux with zsh as the login shell, a new zsh login shell finds hedge through ~/.zprofile", () => {
    const box = sandbox("Linux");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/usr/bin/zsh" } }).code).toBe(0);
    expect(readFileSync(join(box.home, ".zprofile"), "utf8")).toBe('export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" # Added by Hedge\n');
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
    const login = Bun.spawnSync([Bun.which("zsh") ?? "zsh", "-lc", "command -v hedge"], { env: { PATH: "/usr/bin:/bin", HOME: box.home } });
    expect(login.stdout.toString().trim()).toBe(join(box.home, ".local/bin/hedge"));
  });

  test("with fish as the login shell, writes its own fish file once", () => {
    const box = sandbox("Linux");
    const first = getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/usr/bin/fish" } });
    const second = getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/usr/bin/fish" } });
    expect(readFileSync(join(box.home, ".config/fish/conf.d/hedge.fish"), "utf8")).toBe("fish_add_path --global $HOME/.local/bin $HOME/.bun/bin\n");
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
    expect(first.output).toContain("Hedge: Open a new terminal to use hedge. ~/.config/fish/conf.d/hedge.fish now puts ~/.local/bin and ~/.bun/bin on your PATH.");
    expect(second.output).not.toContain("Open a new terminal");
  });
});
