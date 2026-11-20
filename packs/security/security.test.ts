import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseUpstream } from "../mcp-gateway/lib/apps.ts";

const pack = await Bun.file(join(import.meta.dir, "pack.json")).json();

test("the Wiz upstream signs in by hand and asks Wiz for read access only", async () => {
  const upstream = parseUpstream(await Bun.file(join(import.meta.dir, "mcp-upstreams/wiz.json")).json());
  expect(upstream).toMatchObject({ kind: "oauth", name: "wiz", url: "https://mcp.app.wiz.io/", loopback: true });
  expect(upstream.kind === "oauth" && upstream.scopes).toEqual(["read:all", "offline_access"]);
});

test("the Wiz upstream reaches the hub's gateway only while the wiz workflow is on", () => {
  expect(pack.workflows.find((workflow: { id: string }) => workflow.id === "wiz")).toMatchObject({ default: false, requires: ["mcp-gateway"] });
  expect(pack.files).toEqual([
    { path: "mcp-upstreams/wiz.json", target: ".config/hedge/mcp-gateway/upstreams/wiz.json", roles: ["hub", "solo"], workflow: "wiz" },
  ]);
});
