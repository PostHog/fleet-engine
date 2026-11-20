import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { changedFiles, ownedBy, readIfThere, removeUnits, requireInstalled, writeFiles } from "./managed.ts";
import { peersOf, readRole } from "./machine.ts";
import { gatewayPort, refuseLinks } from "../../mcp-gateway/lib/client.ts";
import type { Run } from "../../mcp-gateway/lib/hub.ts";
import { isKeptForBoxes, sshName } from "../../../src/hub/names.ts";
import { hostPattern, must, proxyPort, relayPortOf } from "./run.ts";

export type TunnelMode = "plan" | "install" | "doctor" | "remove" | "left";
/** dialsHub: the devboxes that the profile names, which reach the hub's served ports through their own forward. */
export type TunnelMachine = { home: string; devboxes: string[]; dialsHub: string[]; relayPort: number; httpsHost?: string; proxy?: boolean; hosts: string; run: Run; print(line: string): void };

const marker = "# Managed by Hedge hub SSH tunnels.";
const tunnelAddress = "127.0.0.1";
const hostsMarker = (home: string) => ` # hedge-hub-tunnel ${home}`;
const hostsOwner = (line: string) => /^[^#]* # hedge-hub-tunnel ([^\n]*)$/.exec(line)?.[1];
const ownedHostsLine = (home: string) => (line: string) => hostsOwner(line) === home;
const markedHostsLine = (line: string) => line.endsWith(" # fleet-hub-tunnel") || line.includes(" # hedge-hub-tunnel ");
const unitName = (alias: string) => `hedge-ssh-${alias}.service`;
const loopback = (port: number) => `-R 127.0.0.1:${port}:127.0.0.1:${port}`;

export function tunnelTargets(hub: string, devboxes: string[], self: string): string[] {
  return peersOf(hub, devboxes, self).filter((alias) => alias !== hub);
}

export function tunnelUnit(alias: string, relayPort: number, proxy = false, gateway = false): string {
  return `${marker}
[Unit]
Description=Hedge hub SSH tunnel for ${sshName(alias)}

[Service]
Environment=CODER_SSH_DISABLE_AUTOSTART=true
ExecStart=/usr/bin/ssh -NT -o BatchMode=yes -o ConnectTimeout=30 -o ExitOnForwardFailure=yes -o ForwardAgent=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ${gateway ? `${loopback(gatewayPort)} ` : ""}${loopback(relayPortOf(relayPort, proxy))}${proxy ? ` ${loopback(proxyPort)}` : ""} ${alias}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function hostsWith(previous: string, host: string, home: string): string {
  if (/[\r\n]/.test(home)) throw new Error("Keep the hosts file: the home path holds a line break.");
  const lines = previous.split("\n").filter((line) => !ownedHostsLine(home)(line));
  while (lines.at(-1) === "") lines.pop();
  const conflicts = (line: string) => {
    const [address, ...names] = line.split("#", 1)[0]!.trim().split(/\s+/);
    return names.includes(host) && !(markedHostsLine(line) && address === tunnelAddress);
  };
  if (lines.some(conflicts)) throw new Error(`Keep unmanaged hosts entry for ${host}.`);
  return [...lines, `${tunnelAddress} ${host}${hostsMarker(home)}`, ""].join("\n");
}

export async function sshTunnels(mode: TunnelMode, machine: TunnelMachine): Promise<number> {
  if (mode === "remove" || mode === "left") return withoutTunnels(mode, machine);
  const role = readRole(machine.home);
  if (role === "hub") return hubTunnels(mode, machine);
  if (role === "devbox") return devboxHosts(mode, machine);
  throw new Error(`hedge ssh-tunnels runs on the hub or a devbox, not on a ${role ?? "machine without a role"}. On a Mac, run hedge hub-tunnel.`);
}

async function hubTunnels(mode: TunnelMode, machine: TunnelMachine) {
  const directory = join(machine.home, ".config/systemd/user");
  for (const box of machine.devboxes.filter(isKeptForBoxes)) machine.print(`${box}: skipped: a box gets the gateway and relay ports from its own box forward`);
  const units = machine.devboxes.filter((alias) => !isKeptForBoxes(alias)).map((alias) => ({ alias, name: unitName(alias), path: join(directory, unitName(alias)), content: tunnelUnit(alias, machine.relayPort, machine.proxy, !machine.dialsHub.includes(alias)) }));
  const changed = await changedFiles(machine.home, units, marker, "tunnel");
  const systemctl = (...args: string[]) => must(machine.run, ["systemctl", "--user", ...args]);
  const stale = mode === "plan" ? [] : await staleUnits(machine.home, directory, units.map((unit) => unit.name));
  if (mode === "doctor") await requireInstalled(machine.home, units, marker, "tunnel", "hedge ssh-tunnels install", stale.map((name) => join(directory, name)));
  if (mode === "install") {
    for (const name of stale) {
      await systemctl("disable", "--now", name);
      await rm(join(directory, name));
    }
    await writeFiles(changed);
    await systemctl("daemon-reload");
    for (const unit of units) {
      if (changed.includes(unit)) await systemctl("restart", unit.name);
      await systemctl("enable", "--now", unit.name);
    }
  }
  for (const unit of units) {
    if (mode !== "plan") {
      await systemctl("is-enabled", "--quiet", unit.name);
      await systemctl("is-active", "--quiet", unit.name);
    }
    machine.print(`${unit.alias}: SSH tunnel ${mode === "plan" ? "planned" : "active"}`);
  }
  return 0;
}

async function withoutTunnels(mode: "remove" | "left", machine: TunnelMachine) {
  const directory = join(machine.home, ".config/systemd/user");
  const units = (await staleUnits(machine.home, directory, [])).sort().map((name) => join(directory, name));
  const owned = ownedHostsLine(machine.home);
  const hosts = (await readIfThere(machine.hosts)) ?? "";
  const entry = hosts.split("\n").some(owned);
  if (mode === "left") return machine.print(units.length || entry ? "Hub SSH tunnels: still here." : "Hub SSH tunnels: nothing left."), units.length || entry ? 0 : 1;
  await removeUnits(machine.home, units, marker, "tunnel", machine.run);
  if (entry) {
    if ((await lstat(machine.hosts)).isSymbolicLink()) throw new Error(`Keep linked hosts file: ${machine.hosts}`);
    await must(machine.run, ["sudo", "-n", "tee", machine.hosts], hosts.split("\n").filter((line) => !owned(line)).join("\n"));
  }
  machine.print("Hub SSH tunnels: removed.");
  return 0;
}

async function staleUnits(home: string, directory: string, wanted: string[]): Promise<string[]> {
  await refuseLinks(home, directory, "tunnel path");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const stale: string[] = [];
  for (const name of names.filter((file) => /^hedge-ssh-.+\.service$/.test(file) && !wanted.includes(file))) {
    const path = join(directory, name);
    if ((await lstat(path)).isFile() && ownedBy((await readIfThere(path)) ?? "", marker)) stale.push(name);
  }
  return stale;
}

async function devboxHosts(mode: TunnelMode, machine: TunnelMachine) {
  const host = machine.httpsHost;
  if (!host) return machine.print("No hosts entry needed: hub.httpsHost is empty."), 0;
  if (!hostPattern.test(host)) throw new Error(`hub.httpsHost is not a host name: ${JSON.stringify(host)}`);
  if ((await lstat(machine.hosts)).isSymbolicLink()) throw new Error(`Keep linked hosts file: ${machine.hosts}`);
  const previous = await readFile(machine.hosts, "utf8");
  const wanted = hostsWith(previous, host, machine.home);
  if (mode === "doctor" && previous !== wanted) throw new Error(`${machine.hosts} does not map ${host} to the hub tunnel. Run hedge ssh-tunnels install.`);
  if (mode === "install" && previous !== wanted) await must(machine.run, ["sudo", "-n", "tee", machine.hosts], wanted);
  machine.print(`${host}: hosts entry ${mode === "plan" ? "planned" : "present"}`);
  return 0;
}
