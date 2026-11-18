import type { Pack } from "../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "placed",
  summary: "A service that runs on the hub only.",
  register(hedge) {
    hedge.service({ on: "hub", id: "placed-worker", run: async (ctx) => ctx.print("placed-worker ran") });
  },
} satisfies Pack;
