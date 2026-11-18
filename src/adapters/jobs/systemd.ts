export const unitsFolder = ".config/systemd/user";
export const unitName = (id: string) => `hedge-${id}.service`;
export const legacyUnitPrefix = "fleet-";
export const unitTarget = (id: string) => `${unitsFolder}/${unitName(id)}`;

export const systemdSafe = (path: string) => !/[\n\r]/.test(path);

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;

export function unit(id: string, script: string) {
  return [
    "[Unit]",
    `Description=Hedge: ${id}`,
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=/bin/sh ${quote(script)}`,
    "Restart=always",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
