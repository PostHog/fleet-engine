import type { Pack } from "../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "served",
  summary: "A service on the hub that every node reaches at one port.",
  register(hedge) {
    const extra = hedge.workflow({ id: "served-extra", name: "Served extra", sentence: "The hub serves one more service.", default: false });
    hedge.command("served", {
      summary: "Install the served service",
      run: async ([mode], ctx) => (mode === "install" ? (await ctx.secrets.write("installed", "yes"), 0) : 2),
    });
    const installed = hedge.check({ on: "hub", id: "served-installed", say: "The served service is not installed.", test: async (ctx) => (await ctx.secrets.read("installed")) === "yes", repair: { ask: "Install it.", command: "hedge served install" } });
    hedge.service({ on: "hub", id: "served-api", after: installed, serve: { port: 4555, health: "/health", credential: async (_ctx, node) => `key-for-${node}` } });
    hedge.service({ on: "hub", id: "served-extra-api", when: extra, serve: { port: 4556, health: "/health", credential: async () => "extra" } });
    hedge.service({ on: "hub", id: "served-codex-api", os: "linux", plans: ["codex"], serve: { port: 4557, health: "/ready", credential: async () => "codex" } });
    hedge.config({ on: "hub", provider: "codex", key: "mcp_servers.served-admin", value: { command: "hedge", args: ["served", "admin"] }, after: installed });
    hedge.config({ provider: "codex", key: "mcp_servers.served", value: { command: "hedge", args: ["served", "connect"] } });
  },
} satisfies Pack;
