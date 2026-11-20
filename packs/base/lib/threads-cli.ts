import type { ActiveRuntime } from "../../../src/runtime/active.ts";
import type { RuntimeThread } from "../../../src/sdk/runtime.ts";

export type ThreadsIo = { runtime(): Promise<ActiveRuntime>; print(line: string): void; readStdin(): Promise<string>; now?(): number };

export const threadsUsage = `Usage:
  hedge threads list [--machine <name>] [--all]
  hedge threads read <id> [--machine <name>] [--tail <n>]
  hedge threads send <id> [--machine <name>] < message
  hedge threads start --key <key> --title <title> [--role <model role>] [--machine <name>] [--cwd <folder>] [--each-run] [--prompt <text> | < prompt]
  hedge threads machines`;

function options(args: string[]) {
  const flags: Record<string, string | true> = {};
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "all" || name === "each-run") flags[name] = true;
    else {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.\n${threadsUsage}`);
      flags[name] = value;
    }
  }
  return { flags, words };
}

const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);

export const threadLine = (thread: RuntimeThread) =>
  [thread.machine ? `${thread.machine}/${thread.id}` : thread.id, thread.state + (thread.blocked ? ` (${thread.blocked.kind})` : ""), thread.title, thread.url ?? ""].filter(Boolean).join("\t");

export async function threadsCommand(args: string[], io: ThreadsIo): Promise<number> {
  const [verb, ...rest] = args;
  const { flags, words } = options(rest);
  const machine = text(flags.machine);
  const { threads, runtime } = await io.runtime();
  switch (verb) {
    case "list": {
      for (const thread of await threads.list({ ...(machine ? { machine } : {}), includeClosed: flags.all === true })) io.print(threadLine(thread));
      return 0;
    }
    case "read": {
      const id = words[0];
      if (!id) throw new Error(threadsUsage);
      const tail = text(flags.tail);
      const read = await threads.read(id, { ...(machine ? { machine } : {}), ...(tail ? { tail: Number(tail) } : {}) });
      if ("screen" in read) io.print(read.screen.trimEnd());
      else for (const message of read.messages) io.print(`[${message.at}] ${message.role}: ${message.text}`);
      return 0;
    }
    case "send": {
      const id = words[0];
      if (!id) throw new Error(threadsUsage);
      const message = (await io.readStdin()).trim();
      if (!message) throw new Error("hedge threads send reads the message from standard input, and it was empty.");
      if (await threads.send({ id, text: message, ...(machine ? { machine } : {}) })) return 0;
      io.print(`${runtime.title} has no open thread ${id}.`);
      return 1;
    }
    case "start": {
      const base = text(flags.key);
      const title = text(flags.title);
      if (!base || !title) throw new Error(threadsUsage);
      const key = flags["each-run"] === true ? `${base}:${new Date(io.now?.() ?? Date.now()).toISOString().slice(0, 16)}` : base;
      const cwd = text(flags.cwd);
      const prompt = (text(flags.prompt) ?? (await io.readStdin())).trim();
      if (!prompt) throw new Error("hedge threads start reads the prompt from standard input, and it was empty.");
      const started = await threads.start({ key, title, prompt, modelRole: text(flags.role) ?? "implementation", ...(machine ? { machine } : {}), ...(cwd ? { cwd } : {}) });
      io.print(JSON.stringify(started));
      return 0;
    }
    case "machines": {
      for (const item of await threads.machines()) io.print([item.name, item.self ? "this machine" : item.id, item.problem ?? "reachable"].join("\t"));
      return 0;
    }
    default:
      throw new Error(threadsUsage);
  }
}
