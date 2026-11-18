import type { Pack } from "../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "kit",
  summary: "A pack that drives every part of the context.",
  register(hedge) {
    const greeting = hedge.setting({ key: "kit.greeting", type: "string", question: "Which greeting?", default: "hello" });
    hedge.command("kit", {
      summary: "Use the context",
      run: async ([mode, ...rest], ctx) => {
        if (mode === "greet") return ctx.print(`${ctx.get(greeting)} ${rest.join(" ")}`), 0;
        if (mode === "note") return ctx.print(ctx.get(note)), 0;
        if (mode === "stray") return ctx.print(String(ctx.get({} as typeof greeting))), 0;
        if (mode === "save") return await ctx.secrets.write(rest[0]!, rest[1]!), 0;
        if (mode === "show") return ctx.print((await ctx.secrets.read(rest[0]!)) ?? "no secret"), 0;
        if (mode === "fail") throw new Error("kit failed");
        if (mode === "env") return ctx.print(`${process.env.HOME} ${process.env.HEDGE_ENGINE_DIR} ${process.env.HEDGE_SETTINGS}`), 0;
        if (mode === "start") {
          const thread = await ctx.threads.start({ key: rest[0]!, title: "Kit", prompt: "Say hello.", modelRole: "implementation" });
          return ctx.print(thread.url ?? thread.id), 0;
        }
        return 2;
      },
    });
    hedge.service({
      id: "kit-ticker",
      run: async (ctx) => {
        for (let tick = 1; tick <= 3; tick++) {
          ctx.log(`tick ${tick}`);
          await ctx.sleep(60_000);
        }
        await Bun.write(`${ctx.stateDir}/ticked`, String(ctx.now()));
      },
    });
    const note = hedge.setting({ key: "kit.note", type: "string", question: "Which note?" });
    const extra = hedge.workflow({ id: "kit-extra", name: "Kit extra", sentence: "The kit runs one more service.", default: false, settings: [note] });
    hedge.service({ id: "kit-extra-run", when: extra, run: async (ctx) => ctx.print("ran") });
    const saved = hedge.check({ id: "kit-saved", say: "Save the token.", test: async (ctx) => (await ctx.secrets.read("token")) !== undefined });
    hedge.service({ id: "kit-sender", after: saved, run: async (ctx) => ctx.print(`sent at ${new Date(ctx.now()).toISOString()}`) });
  },
} satisfies Pack;
