import { describe, expect } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./testing/git.ts";
import { getShHarness, onLinuxHost, type Sandbox } from "./testing/get-sh.ts";
import { legacyPaths } from "./legacy.ts";

const { sandbox, profile, engine, getSh } = getShHarness();

function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (path: string, key: string) => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return;
    const mode = (info.mode & 0o7777).toString(8);
    if (info.isSymbolicLink()) entries[key] = `link ${readlinkSync(path)}`;
    else if (info.isFile()) entries[key] = `file ${mode} ${readFileSync(path, "utf8")}`;
    else {
      entries[key] = `folder ${mode}`;
      for (const name of readdirSync(path).sort()) walk(join(path, name), `${key}/${name}`);
    }
  };
  walk(root, ".");
  return entries;
}

const oldTree = (home: string) => Object.fromEntries([...legacyPaths.map(([before]) => before), ".local/bin/fleet", ".config/systemd/user/fleet-watch.service"].map((path) => [path, tree(join(home, path))]));
const unit = "[Unit]\nDescription=Fleet: watch\n";

/** A Linux machine as the engine from before the rename left it: its checkout, its profile, its machine file, a secret, an SSH key, a lock, and a watch service. */
function beforeTheRename(box: Sandbox) {
  const home = box.home;
  const oldEngine = join(home, ".local/share/fleet/engine");
  git(home, "clone", "-q", engine.repo, oldEngine);
  git(oldEngine, "checkout", "-q", "v0.0.9");
  const oldProfile = join(home, ".local/share/fleet/profile");
  git(home, "clone", "-q", profileRepo(box), oldProfile);
  mkdirSync(join(home, ".config/fleet/secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "devbox", profileDir: oldProfile }));
  writeFileSync(join(home, ".config/fleet/secrets/hub.box"), "secret\n", { mode: 0o600 });
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  writeFileSync(join(home, ".ssh/fleet_ed25519"), "private key\n", { mode: 0o600 });
  mkdirSync(join(home, ".local/state/fleet/jobs"), { recursive: true });
  mkdirSync(join(home, ".local/state/fleet/lock"));
  writeFileSync(join(home, ".local/state/fleet/jobs/watch.service"), unit);
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(join(home, ".config/systemd/user/fleet-watch.service"), unit);
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/fleet"), `#!/bin/sh\n# Fleet\nexec sh '${oldEngine}/fleet' "$@"\n`, { mode: 0o755 });
  return oldEngine;
}

function profileRepo(box: Sandbox) {
  const repo = profile();
  renameSync(join(repo, "hedge.json"), join(repo, "fleet.json"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "profile");
  return repo;
}

describe("get.sh on a machine from before the rename", () => {
  onLinuxHost("makes a fresh checkout, brings the setup over with its modes, applies, leaves every old path as it was, and does nothing the second time", () => {
    const box = sandbox("Linux");
    const oldEngine = beforeTheRename(box);
    const home = box.home;
    const before = oldTree(home);

    const first = getSh(box, ["--ref", "v0.1.0"], { env: { FLEET_ENGINE_DIR: oldEngine } });

    expect(first.code).toBe(0);
    expect(first.output).toContain(`FLEET_ENGINE_DIR points into a Fleet path from before the rename, so the engine goes to ${join(home, ".local/share/hedge/engine")}.`);
    expect(first.output).toContain("Hedge: copied ~/.config/fleet to ~/.config/hedge.");
    expect(first.output).toContain("Applied ");
    expect(git(join(home, ".local/share/hedge/engine"), "rev-parse", "HEAD")).toBe(git(engine.repo, "rev-parse", "v0.1.0"));
    expect(git(oldEngine, "rev-parse", "HEAD")).toBe(git(engine.repo, "rev-parse", "v0.0.9^{commit}"));
    expect(readFileSync(join(home, ".local/bin/fleet"), "utf8")).toContain(join(home, ".local/share/hedge/engine/hedge"));
    expect(lstatSync(join(home, ".config/hedge/secrets/hub.box")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(home, ".config/hedge/secrets")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(home, ".ssh/hedge_ed25519")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, ".local/state/hedge/lock"))).toBe(false);
    expect(existsSync(join(home, ".local/share/hedge/profile/fleet.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8")).profileDir).toBe(join(home, ".local/share/hedge/profile"));
    const fleetBefore = { ...before, ".local/bin/fleet": tree(join(home, ".local/bin/fleet")) };
    expect(oldTree(home)).toEqual(fleetBefore);
    const newTree = tree(join(home, ".config/hedge"));

    const second = getSh(box, ["--ref", "v0.1.0", "--profile", join(home, ".local/share/hedge/profile")]);

    expect(second.code).toBe(0);
    expect(second.output).not.toContain("copied");
    expect(second.output).toContain("Applied 0 changes");
    expect(oldTree(home)).toEqual(fleetBefore);
    expect(tree(join(home, ".config/hedge"))).toEqual(newTree);
  });

  onLinuxHost("refuses to copy through a link at a new path, and writes nothing behind it", () => {
    const box = sandbox("Linux");
    beforeTheRename(box);
    const elsewhere = join(box.root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(box.home, ".config/hedge"));

    const result = getSh(box, ["--ref", "v0.1.0"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`${join(box.home, ".config/hedge")} is a link or a file, so Hedge did not bring the Fleet copy to ~/.config/hedge.`);
    expect(result.output).toContain("Hedge: could not copy the setup from before the rename.");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(result.output).not.toContain("Applied");
  });

  onLinuxHost("takes an empty HEDGE_ENGINE_REF over FLEET_ENGINE_REF, and says it is empty", () => {
    const box = sandbox("Linux");
    const result = getSh(box, ["--install-only"], { env: { HEDGE_ENGINE_REF: "", FLEET_ENGINE_REF: "v0.1.0" } });
    expect(result.code).toBe(1);
    expect(result.output).toContain("Hedge: HEDGE_ENGINE_REF is set but empty. Unset it or give it a value.");
    expect(existsSync(join(box.home, ".local/share/hedge/engine"))).toBe(false);
  });
});
