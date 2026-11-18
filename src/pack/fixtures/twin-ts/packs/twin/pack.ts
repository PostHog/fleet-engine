import type { Pack } from "../../../../../sdk/index.ts";

export default {
  sdk: 1,
  name: "twin",
  title: "Twin",
  summary: "The hub greets you once you pick a greeting.",
  risk: "None.",
  instructions: "instructions.md",
  register(hedge) {
    const greeting = hedge.setting({ key: "twin.greeting", type: "string", question: "Which greeting?" });
    const hello = hedge.workflow({ id: "twin-hello", name: "Greet", sentence: "The hub greets you.", default: false, settings: [greeting] });
    const picked = hedge.check({
      on: "hub", when: hello, id: "twin-picked", say: "Pick a greeting.",
      test: async (ctx) => ctx.get(greeting) !== "",
      repair: { ask: "Run this command.", command: "hedge twin-hello setup", interactive: true },
    });
    hedge.command("twin-hello", { summary: "Pick a greeting", run: async () => 0 });
    hedge.service({ on: "hub", when: hello, after: picked, id: "twin-greeter", run: async () => {} });
    hedge.service({ os: "linux", plans: ["claude"], id: "twin-linux", run: async () => {} });
  },
} satisfies Pack;
