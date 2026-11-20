import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { getShHarness } from "../../../src/testing/get-sh.ts";

const { sandbox } = getShHarness();
const temp = tempDirs();
afterEach(() => temp.cleanup());
const onLinux = test.skipIf(process.platform !== "linux");
const shipped = readFileSync(join(import.meta.dir, "node.release"), "utf8");
const version = shipped.match(/^version (\S+)$/m)![1]!;
const targets = ["linux-x64", "linux-arm64"];
const engineRoot = join(import.meta.dir, "../../..");

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${join(bin, "calls.log")}"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

async function archive(dist: string, target: string) {
  const tree = temp.make("node-tree-");
  const top = join(tree, `node-v${version}-${target}`, "bin");
  mkdirSync(top, { recursive: true });
  for (const name of ["node", "npm", "npx"]) {
    writeFileSync(join(top, name), `#!/bin/sh\necho "${name} ${version} ${target}"\n`);
    chmodSync(join(top, name), 0o755);
  }
  const file = join(dist, `node-v${version}-${target}.tar.gz`);
  expect(await Bun.spawn(["tar", "-czf", file, "-C", tree, `node-v${version}-${target}`]).exited).toBe(0);
  return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
}

async function machine(arch: string, options: { corrupt?: boolean } = {}) {
  const bin = temp.make("bin-");
  const home = temp.make("home-");
  const dist = temp.make("dist-");
  const lib = temp.make("lib-");
  const sums = await Promise.all(targets.map((target) => archive(dist, target)));
  copyFileSync(join(import.meta.dir, "install-node.sh"), join(lib, "install-node.sh"));
  writeFileSync(join(lib, "node.release"), [`version ${version}`, ...targets.map((target, index) => `${target} ${options.corrupt ? "0".repeat(64) : sums[index]}`)].join("\n") + "\n");
  stub(bin, "uname", `echo ${arch}`);
  stub(
    bin,
    "curl",
    [
      "out='' url=''",
      'while [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done',
      `case "$url" in https://nodejs.org/dist/v${version}/*) ;; *) exit 22 ;; esac`,
      `file="${dist}/\${url##*/}"`,
      '[ -f "$file" ] || exit 22',
      'cp "$file" "$out"',
    ].join("\n"),
  );
  const calls = () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8") : "");
  const install = async (path = `${bin}:${home}/.local/bin:/usr/bin:/bin`, args: string[] = []) => {
    const child = Bun.spawn(["/bin/sh", join(lib, "install-node.sh"), ...args], { env: { HOME: home, PATH: path }, stdout: "pipe", stderr: "pipe" });
    return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
  };
  return { bin, home, lib, calls, install, downloads: () => calls().split("\n").filter((line) => line.startsWith("curl ")) };
}

function throughLauncher(box: Awaited<ReturnType<typeof machine>>) {
  const engine = temp.make("engine-");
  for (const path of ["src", "packs", "hedge", "package.json", "presets.json"]) cpSync(join(engineRoot, path), join(engine, path), { recursive: true });
  symlinkSync(join(engineRoot, "node_modules"), join(engine, "node_modules"));
  copyFileSync(join(box.lib, "node.release"), join(engine, "packs/base/lib/node.release"));
  const tools = sandbox("Linux");
  for (const name of ["node", "npx", "curl"]) rmSync(join(tools.bin, name));
  copyFileSync(join(box.bin, "curl"), join(tools.bin, "curl"));
  chmodSync(join(tools.bin, "curl"), 0o755);
  symlinkSync(Bun.which("readlink")!, join(tools.bin, "readlink"));
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [], packs: [], plan: "both", settings: {}, workflows: {} }));
  mkdirSync(join(box.home, ".config/hedge"), { recursive: true });
  writeFileSync(join(box.home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "devbox", profileDir: profile }));
  return async (args: string[]) => {
    const child = Bun.spawn(["sh", join(engine, "hedge"), ...args], { env: { HOME: box.home, PATH: tools.bin, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: stdout + stderr };
  };
}

const links = (home: string) => Object.fromEntries(["node", "npm", "npx"].map((name) => [name, readlinkSync(join(home, ".local/bin", name))]));

function fleetNode(home: string) {
  const fleets = join(home, `.local/share/fleet/node/node-v${version}-linux-x64/bin`);
  mkdirSync(fleets, { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  for (const name of ["node", "npm", "npx"]) {
    writeFileSync(join(fleets, name), "#!/bin/sh\necho fleet\n", { mode: 0o755 });
    symlinkSync(join(fleets, name), join(home, ".local/bin", name));
  }
  return fleets;
}

async function runs(home: string, name: string) {
  const child = Bun.spawn([join(home, ".local/bin", name), "--version"], { stdout: "pipe" });
  return (await new Response(child.stdout).text()).trim();
}

describe("install-node.sh", () => {
  onLinux.each([
    ["x86_64", "linux-x64"],
    ["aarch64", "linux-arm64"],
  ])("installs the pinned, checked Node.js for %s, so node, npm and npx run from ~/.local/bin", async (arch, target) => {
    const box = await machine(arch);
    expect(await box.install()).toMatchObject({ code: 0 });
    for (const name of ["node", "npm", "npx"]) expect(await runs(box.home, name)).toBe(`${name} ${version} ${target}`);
    expect(readlinkSync(join(box.home, ".local/bin/npx"))).toBe(join(box.home, `.local/share/hedge/node/node-v${version}-${target}/bin/npx`));
    expect(box.downloads()).toEqual([expect.stringContaining(`https://nodejs.org/dist/v${version}/node-v${version}-${target}.tar.gz`)]);
  });

  onLinux("downloads nothing when node and npx already run, so a Node the person installed stays in charge", async () => {
    const box = await machine("x86_64");
    expect((await box.install()).code).toBe(0);
    expect((await box.install()).code).toBe(0);
    expect(box.downloads()).toHaveLength(1);
    const other = temp.make("other-node-");
    for (const name of ["node", "npx"]) stub(other, name, "echo other");
    const fresh = await machine("x86_64");
    expect(await fresh.install(`${fresh.bin}:${other}:/usr/bin:/bin`)).toMatchObject({ code: 0 });
    expect(fresh.downloads()).toEqual([]);
    expect(existsSync(join(fresh.home, ".local/bin/node"))).toBe(false);
  });

  onLinux("refuses an archive whose checksum does not match the pin, and installs nothing", async () => {
    const box = await machine("x86_64", { corrupt: true });
    const result = await box.install();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checksum");
    expect(existsSync(join(box.home, ".local/bin/node"))).toBe(false);
    expect(existsSync(join(box.home, ".local/share/hedge/node"))).toBe(false);
  });

  onLinux("keeps a node, npm or npx in ~/.local/bin that Hedge did not put there", async () => {
    const box = await machine("x86_64");
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    stub(join(box.home, ".local/bin"), "npm", "echo mine");
    expect((await box.install()).code).toBe(0);
    expect(await runs(box.home, "npm")).toBe("mine");
    expect(await runs(box.home, "npx")).toBe(`npx ${version} linux-x64`);
  });

  onLinux("repairs its own links when the Node.js release they point at is gone", async () => {
    const box = await machine("x86_64");
    expect((await box.install()).code).toBe(0);
    for (const name of ["node", "npx"]) {
      rmSync(join(box.home, ".local/bin", name));
      symlinkSync(join(box.home, `.local/share/hedge/node/node-v1.0.0-linux-x64/bin/${name}`), join(box.home, ".local/bin", name));
    }
    expect(await box.install()).toMatchObject({ code: 0 });
    expect(await runs(box.home, "node")).toBe(`node ${version} linux-x64`);
    expect(await runs(box.home, "npx")).toBe(`npx ${version} linux-x64`);
  });

  onLinux("replaces the links that Fleet put in ~/.local/bin before the rename, so node, npm and npx run Hedge's package, also on a second run", async () => {
    const box = await machine("x86_64");
    const fleets = fleetNode(box.home);
    expect(await box.install()).toMatchObject({ code: 0, stdout: `Node.js: ${version} in ${join(box.home, ".local/share/hedge/node")}/node-v${version}-linux-x64.\n` });
    expect(await box.install()).toMatchObject({ code: 0 });
    for (const name of ["node", "npm", "npx"]) expect(await runs(box.home, name)).toBe(`${name} ${version} linux-x64`);
    expect(readFileSync(join(fleets, "node"), "utf8")).toContain("echo fleet");
  });

  onLinux("hedge install-node --check, run through the launcher while node, npm and npx link into Fleet's package, exits 1 and changes nothing", async () => {
    const box = await machine("x86_64");
    fleetNode(box.home);
    const hedge = throughLauncher(box);
    const before = links(box.home);

    const checked = await hedge(["install-node", "--check"]);

    expect(checked.code).toBe(1);
    expect(links(box.home)).toEqual(before);
    expect(existsSync(join(box.home, ".local/share/hedge/node"))).toBe(false);
    expect(box.downloads()).toEqual([]);
  });

  onLinux("hedge apply on a devbox, run through the launcher while node, npm and npx link into Fleet's package, leaves node, npm and npx running Hedge's package", async () => {
    const box = await machine("x86_64");
    const fleets = fleetNode(box.home);
    const hedge = throughLauncher(box);

    const applied = await hedge(["apply"]);

    expect(applied.output).toContain("Applied");
    expect(applied.code).toBe(0);
    for (const name of ["node", "npm", "npx"]) expect(await runs(box.home, name)).toBe(`${name} ${version} linux-x64`);
    expect(readdirSync(fleets).map((name) => readFileSync(join(fleets, name), "utf8"))).toEqual(Array(3).fill("#!/bin/sh\necho fleet\n"));
  });

  onLinux("installs Node.js when the node or npx on PATH is there but does not run", async () => {
    const box = await machine("x86_64");
    const broken = temp.make("broken-node-");
    stub(broken, "node", "echo v1");
    stub(broken, "npx", "exit 42");
    expect(await box.install(`${box.bin}:${box.home}/.local/bin:${broken}:/usr/bin:/bin`)).toMatchObject({ code: 0 });
    expect(await runs(box.home, "npx")).toBe(`npx ${version} linux-x64`);
  });

  onLinux("names a broken npx in ~/.local/bin that Hedge did not put there, and keeps it", async () => {
    const box = await machine("x86_64");
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    stub(join(box.home, ".local/bin"), "npx", "exit 42");
    const result = await box.install();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(join(box.home, ".local/bin/npx"));
    expect(readFileSync(join(box.home, ".local/bin/npx"), "utf8")).toContain("exit 42");
  });

  onLinux("names the machine type when it has no pinned build", async () => {
    const box = await machine("riscv64");
    const result = await box.install();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("riscv64");
    expect(box.downloads()).toEqual([]);
  });
});
