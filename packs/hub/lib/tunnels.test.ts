import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { fakeRun, modeOf, roleHome } from "./run-testing.ts";
import { sshTunnels, tunnelTargets, tunnelUnit, type TunnelMachine } from "./tunnels.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const host = "hub.internal.example.com";

function machine(role: string, fields: Partial<TunnelMachine> = {}) {
  const home = fields.home ?? roleHome(temp.make("hedge-tunnels-"), role);
  const hosts = join(temp.make("hedge-etc-"), "hosts");
  writeFileSync(hosts, "127.0.0.1 localhost\n10.0.0.1 unrelated.example\n");
  const fake = fakeRun();
  const printed: string[] = [];
  const deps: TunnelMachine = { home, devboxes: ["devbox-1", "devbox-2"], dialsHub: ["devbox-1", "devbox-2"], relayPort: 60002, httpsHost: host, hosts, run: fake.run, print: (line) => printed.push(line), ...fields };
  return { deps, home, hosts, calls: fake.calls, inputs: fake.inputs, printed };
}

const base = "127.0.0.1 localhost\n10.0.0.1 unrelated.example\n";
const fleetLine = `127.0.0.1 ${host} # fleet-hub-tunnel`;
const lineOf = (home: string, name = host) => `127.0.0.1 ${name} # hedge-hub-tunnel ${home}`;

function devbox(fields: Partial<TunnelMachine> = {}, privilegedWrites: "allowed" | "refused" = "allowed") {
  const fake = fakeRun((command, input) => {
    if (command[0] !== "sudo") return undefined;
    if (privilegedWrites === "refused") return { code: 1, stderr: "sudo: a password is required" };
    if (command.slice(0, 3).join(" ") === "sudo -n tee" && input !== undefined) writeFileSync(command[3]!, input);
    return undefined;
  });
  const made = machine("devbox", { run: fake.run, ...fields });
  return { ...made, calls: fake.calls, read: () => readFileSync(made.hosts, "utf8"), write: (text: string) => writeFileSync(made.hosts, text) };
}

const unitPath = (home: string, alias: string) => join(home, `.config/systemd/user/hedge-ssh-${alias}.service`);

test("a hub tunnel forwards only the relay port to the devbox's loopback, and never a proxy port or a catalog port, which the devbox's own forward carries", () => {
  const unit = tunnelUnit("devbox-1", 60002);
  expect(unit).toContain("-R 127.0.0.1:60002:127.0.0.1:60002");
  expect(unit).toMatch(/ devbox-1\n/);
  for (const option of ["ExitOnForwardFailure=yes", "ForwardAgent=no", "BatchMode=yes", "Restart=always", "Environment=CODER_SSH_DISABLE_AUTOSTART=true"]) expect(unit).toContain(option);
  expect(unit).not.toMatch(/3317|8317|60001| -L |:22\b/);
  expect([...unit.matchAll(/ -R /g)]).toHaveLength(1);
});

test("a devbox that only the hub's machine file names keeps the gateway port in its hub tunnel, because it does not dial the hub itself", async () => {
  const { deps, home } = machine("hub", { dialsHub: ["devbox-1"] });
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(readFileSync(unitPath(home, "devbox-1"), "utf8")).not.toContain("3317");
  const kept = readFileSync(unitPath(home, "devbox-2"), "utf8");
  expect(kept).toContain("-R 127.0.0.1:3317:127.0.0.1:3317 -R 127.0.0.1:60002:127.0.0.1:60002 devbox-2\n");
});

test("a tunnel refuses an alias that could break its unit, and a relay port that is the gateway's or a system port", () => {
  expect(() => tunnelUnit("devbox-1\nExecStart=bad", 60002)).toThrow("not an SSH name");
  expect(() => tunnelUnit("devbox-1", 3317)).toThrow("hub.relayPort");
  expect(() => tunnelUnit("devbox-1", 80)).toThrow("hub.relayPort");
});

test("the hub opens a tunnel to every devbox in the merged list, but not to itself", () => {
  expect(tunnelTargets("my-hub", ["devbox-1", "my-hub", "devbox-2", "devbox-1", "hub-host"], "hub-host")).toEqual(["devbox-1", "devbox-2"]);
});

test("install on the hub writes one unit per devbox with mode 600, restarts the changed ones, and the doctor checks each", async () => {
  const { deps, home, calls, printed } = machine("hub");
  expect(await sshTunnels("install", deps)).toBe(0);
  for (const alias of ["devbox-1", "devbox-2"]) {
    expect(readFileSync(unitPath(home, alias), "utf8")).toBe(tunnelUnit(alias, 60002));
    expect(modeOf(statSync(unitPath(home, alias)))).toBe("600");
    expect(calls).toContain(`systemctl --user restart hedge-ssh-${alias}.service`);
    expect(calls).toContain(`systemctl --user enable --now hedge-ssh-${alias}.service`);
    expect(calls).toContain(`systemctl --user is-active --quiet hedge-ssh-${alias}.service`);
  }
  expect(printed).toEqual(["devbox-1: SSH tunnel active", "devbox-2: SSH tunnel active"]);
  const again = machine("hub", { home });
  await sshTunnels("install", again.deps);
  expect(again.calls.some((call) => call.includes("restart"))).toBe(false);
});

test("the doctor fails when a tunnel is not running", async () => {
  const installed = machine("hub");
  await sshTunnels("install", installed.deps);
  const { deps } = machine("hub", { home: installed.home, run: fakeRun((command) => (command.includes("is-active") ? { code: 3 } : undefined)).run });
  await expect(sshTunnels("doctor", deps)).rejects.toThrow("systemctl --user is-active --quiet hedge-ssh-devbox-1.service failed");
});

test("plan writes nothing and runs nothing", async () => {
  const { deps, home, calls, printed } = machine("hub");
  expect(await sshTunnels("plan", deps)).toBe(0);
  expect(existsSync(join(home, ".config/systemd"))).toBe(false);
  expect(calls).toEqual([]);
  expect(printed).toEqual(["devbox-1: SSH tunnel planned", "devbox-2: SSH tunnel planned"]);
});

test("install keeps a dangling linked unit and a unit Hedge did not write", async () => {
  const home = roleHome(temp.make("hedge-tunnels-"), "hub");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  const target = join(home, "unmanaged");
  symlinkSync(target, unitPath(home, "devbox-1"));
  await expect(sshTunnels("install", machine("hub", { home }).deps)).rejects.toThrow("Keep linked tunnel path");
  expect(existsSync(target)).toBe(false);
  const other = roleHome(temp.make("hedge-tunnels-"), "hub");
  mkdirSync(join(other, ".config/systemd/user"), { recursive: true });
  writeFileSync(unitPath(other, "devbox-2"), "[Service]\nExecStart=/bin/true\n");
  await expect(sshTunnels("install", machine("hub", { home: other }).deps)).rejects.toThrow("Keep unmanaged tunnel file");
  expect(readFileSync(unitPath(other, "devbox-2"), "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
});

test("on a devbox, install maps hub.httpsHost to loopback in the hosts file once, marks the line with this home, and keeps every other entry, and a second install needs no privileged write", async () => {
  const { deps, hosts, read } = devbox();
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(read()).toBe(`${base}${lineOf(deps.home)}\n`);
  const again = devbox({ home: deps.home, hosts }, "refused");
  expect(await sshTunnels("install", again.deps)).toBe(0);
  expect(read()).toBe(`${base}${lineOf(deps.home)}\n`);
  expect(await sshTunnels("doctor", again.deps)).toBe(0);
});

test("a hosts line of another home whose path holds the marker text and then this home's path stays on install and remove", async () => {
  const { deps, read, write } = devbox();
  const lookalike = lineOf(`/x # hedge-hub-tunnel ${deps.home}`);
  write(`${base}${lookalike}\n`);
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(read()).toBe(`${base}${lookalike}\n${lineOf(deps.home)}\n`);
  expect(await sshTunnels("remove", { ...deps, httpsHost: undefined })).toBe(0);
  expect(read()).toBe(`${base}${lookalike}\n`);
  expect(await sshTunnels("left", deps)).toBe(1);
  expect(await sshTunnels("remove", deps)).toBe(0);
  expect(read()).toBe(`${base}${lookalike}\n`);
});

test("install replaces only this home's old line, keeps an old Fleet line and another home's line that map the host to loopback, and the devbox doctor fails until this home's line is there", async () => {
  const { deps, read, write } = devbox();
  const other = `${deps.home}-other`;
  await expect(sshTunnels("doctor", deps)).rejects.toThrow(`does not map ${host}`);
  write(`${base}${lineOf(deps.home, "old.example")}\n${fleetLine}\n${lineOf(other)}\n`);
  await expect(sshTunnels("doctor", deps)).rejects.toThrow(`does not map ${host}`);
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(read()).toBe(`${base}${fleetLine}\n${lineOf(other)}\n${lineOf(deps.home)}\n`);
  expect(await sshTunnels("doctor", deps)).toBe(0);
});

test("install refuses an entry the person wrote, and an old Fleet line or another home's line that maps the host to another address, and changes nothing", async () => {
  for (const line of [`10.1.2.3 ${host}`, `10.1.2.3 ${host} # fleet-hub-tunnel`, `10.1.2.3 ${host} # hedge-hub-tunnel /home/other`]) {
    const { deps, calls, read, write } = devbox();
    write(`${base}${line}\n`);
    await expect(sshTunnels("install", deps)).rejects.toThrow(`Keep unmanaged hosts entry for ${host}`);
    expect(calls).toEqual([]);
    expect(read()).toBe(`${base}${line}\n`);
  }
});

test("on a devbox, a symlinked hosts file stays, and an empty hub.httpsHost needs no entry", async () => {
  const { deps, hosts } = machine("devbox");
  const linked = join(temp.make("hedge-etc-"), "hosts");
  symlinkSync(hosts, linked);
  await expect(sshTunnels("install", { ...deps, hosts: linked })).rejects.toThrow("Keep linked hosts file");
  const off = machine("devbox", { httpsHost: undefined });
  expect(await sshTunnels("install", off.deps)).toBe(0);
  expect(off.calls).toEqual([]);
  expect(off.printed).toEqual(["No hosts entry needed: hub.httpsHost is empty."]);
});

test("ssh-tunnels refuses on a Mac or a plain Linux machine and names the Mac command", async () => {
  await expect(sshTunnels("install", machine("mac").deps)).rejects.toThrow("hedge hub-tunnel");
});

test("install on the hub disables and deletes the tunnel unit of a devbox that left the list, and keeps units Hedge did not write", async () => {
  const home = roleHome(temp.make("hedge-tunnels-"), "hub");
  const elsewhere = join(temp.make("hedge-elsewhere-"), "unit");
  writeFileSync(elsewhere, tunnelUnit("devbox-7", 60002));
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(unitPath(home, "devbox-9"), tunnelUnit("devbox-9", 60002));
  writeFileSync(unitPath(home, "devbox-8"), "[Service]\nExecStart=/bin/true\n");
  symlinkSync(elsewhere, unitPath(home, "devbox-7"));
  writeFileSync(join(home, ".config/systemd/user/other.service"), tunnelUnit("devbox-6", 60002));
  const { deps, calls } = machine("hub", { home });
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(existsSync(unitPath(home, "devbox-9"))).toBe(false);
  expect(calls).toContain("systemctl --user disable --now hedge-ssh-devbox-9.service");
  expect(calls.indexOf("systemctl --user disable --now hedge-ssh-devbox-9.service")).toBeLessThan(calls.indexOf("systemctl --user daemon-reload"));
  expect(readFileSync(unitPath(home, "devbox-8"), "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
  expect(readFileSync(elsewhere, "utf8")).toBe(tunnelUnit("devbox-7", 60002));
  expect(existsSync(join(home, ".config/systemd/user/other.service"))).toBe(true);
  expect(calls.filter((call) => call.includes("disable"))).toEqual(["systemctl --user disable --now hedge-ssh-devbox-9.service"]);
  const plan = machine("hub", { home: roleHome(temp.make("hedge-tunnels-"), "hub") });
  mkdirSync(join(plan.home, ".config/systemd/user"), { recursive: true });
  writeFileSync(unitPath(plan.home, "devbox-9"), tunnelUnit("devbox-9", 60002));
  await sshTunnels("plan", plan.deps);
  expect(existsSync(unitPath(plan.home, "devbox-9"))).toBe(true);
  expect(plan.calls).toEqual([]);
});

test("the hub doctor fails when a wanted unit is missing or differs from what install writes now, or a stale Hedge unit remains", async () => {
  const { deps, home } = machine("hub");
  await sshTunnels("install", deps);
  expect(await sshTunnels("doctor", machine("hub", { home }).deps)).toBe(0);
  await expect(sshTunnels("doctor", machine("hub", { home, relayPort: 60003 }).deps)).rejects.toThrow(`${unitPath(home, "devbox-1")}`);
  await expect(sshTunnels("doctor", machine("hub", { home, devboxes: ["devbox-1", "devbox-2", "devbox-3"] }).deps)).rejects.toThrow(`${unitPath(home, "devbox-3")}`);
  await expect(sshTunnels("doctor", machine("hub", { home, devboxes: ["devbox-1"] }).deps)).rejects.toThrow(`${unitPath(home, "devbox-2")}`);
  await expect(sshTunnels("doctor", machine("hub", { home, devboxes: ["devbox-1"] }).deps)).rejects.toThrow("Run hedge ssh-tunnels install");
  expect(readFileSync(unitPath(home, "devbox-2"), "utf8")).toBe(tunnelUnit("devbox-2", 60002));
});

test("the hub opens no SSH tunnel to a box in the devbox list, says so once, and removes the tunnel an earlier install wrote for it", async () => {
  const home = roleHome(temp.make("hedge-tunnels-"), "hub");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(unitPath(home, "box-lane"), tunnelUnit("box-lane", 60002));
  const { deps, calls, printed } = machine("hub", { home, devboxes: ["devbox-1", "box-lane"] });
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(existsSync(unitPath(home, "box-lane"))).toBe(false);
  expect(calls).toContain("systemctl --user disable --now hedge-ssh-box-lane.service");
  expect(calls.filter((call) => call.includes("box-lane"))).toEqual(["systemctl --user disable --now hedge-ssh-box-lane.service"]);
  expect(printed).toEqual(["box-lane: skipped: a box gets the gateway and relay ports from its own box forward", "devbox-1: SSH tunnel active"]);
  expect(await sshTunnels("doctor", machine("hub", { home, devboxes: ["devbox-1", "box-lane"] }).deps)).toBe(0);
});

test("remove on the hub stops and deletes every tunnel unit Hedge wrote, and left then reports nothing left", async () => {
  const { deps, home } = machine("hub");
  await sshTunnels("install", deps);
  const mine = join(home, ".config/systemd/user/hedge-ssh-mine.service");
  writeFileSync(mine, "[Unit]\nDescription=mine\n");
  expect(await sshTunnels("left", deps)).toBe(0);
  const removing = machine("hub", { home, devboxes: [] });
  expect(await sshTunnels("remove", removing.deps)).toBe(0);
  expect(removing.calls).toEqual(["systemctl --user disable --now hedge-ssh-devbox-1.service", "systemctl --user disable --now hedge-ssh-devbox-2.service", "systemctl --user daemon-reload"]);
  expect([existsSync(unitPath(home, "devbox-1")), existsSync(unitPath(home, "devbox-2")), existsSync(mine)]).toEqual([false, false, true]);
  expect(await sshTunnels("left", removing.deps)).toBe(1);
});

test("on a devbox, install then remove in the same home leaves the hosts file as it was, with the old Fleet line and another home's line kept, left then reports nothing left, and a second removal needs no privileged write", async () => {
  const { deps, hosts, read, write } = devbox();
  const before = `${base}${fleetLine}\n${lineOf(`${deps.home}-other`)}\n`;
  write(before);
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(await sshTunnels("left", deps)).toBe(0);
  const installed = read();
  const refused = devbox({ home: deps.home, hosts, httpsHost: undefined }, "refused");
  await expect(sshTunnels("remove", refused.deps)).rejects.toThrow("a password is required");
  expect(read()).toBe(installed);
  expect(await sshTunnels("remove", devbox({ home: deps.home, hosts, httpsHost: undefined }).deps)).toBe(0);
  expect(read()).toBe(before);
  expect(await sshTunnels("left", refused.deps)).toBe(1);
  expect(await sshTunnels("remove", refused.deps)).toBe(0);
  expect(read()).toBe(before);
});

test("the hub treats every name hedge devbox add keeps for pool boxes as a box, even one listed by hand", async () => {
  const home = roleHome(temp.make("hedge-tunnels-"), "hub");
  const { deps, calls, printed } = machine("hub", { home, devboxes: ["devbox-1", "box-7.old"] });
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(existsSync(unitPath(home, "box-7.old"))).toBe(false);
  expect(calls.filter((call) => call.includes("box-7.old") && !call.includes("disable"))).toEqual([]);
  expect(printed).toContain("box-7.old: skipped: a box gets the gateway and relay ports from its own box forward");
});

test("with no hosts line of this home, remove and left leave the old Fleet line and every other home's line alone and run no sudo", async () => {
  const { deps, calls, read, write } = devbox({ httpsHost: undefined });
  const before = `${base}${fleetLine}\n${lineOf(`${deps.home}-other`)}\n${lineOf(`/x${deps.home}`)}\n${lineOf(deps.home)} extra\n`;
  write(before);
  expect(await sshTunnels("left", deps)).toBe(1);
  expect(await sshTunnels("remove", deps)).toBe(0);
  expect(calls).toEqual([]);
  expect(read()).toBe(before);
});

test("install refuses a home path with a line break, which would split the hosts line, and changes nothing", async () => {
  const home = roleHome(temp.make("hedge-tunnels-\n10.9.9.9 evil.example-"), "devbox");
  const { deps, calls, read } = devbox({ home });
  await expect(sshTunnels("install", deps)).rejects.toThrow("line break");
  expect(calls).toEqual([]);
  expect(read()).toBe(base);
});
