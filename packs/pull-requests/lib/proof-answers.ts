import { readThreadWords, t3UserData, withT3Session, type ThreadWord } from "../../t3/lib/client/index.ts";
import { t3StatePath } from "../../base/lib/prune.ts";
import { readRuntimeRecord } from "../../../src/runtime/active.ts";
import { defaultRuntime } from "../../../src/runtime/load.ts";

export type { ThreadWord };
export type HeardAnswer = { thread: string; message: string; words: string; answered: string; at: string; source: ThreadWord["source"] };
export type ThreadWords = (thread: string) => Promise<ThreadWord[]>;

export const normalized = (text: string) => text.toLowerCase().replace(/[`*_"“”‘’']/g, "").replace(/\s+/g, " ").trim();

export const answerRuntime = "t3";

export const t3ThreadWords = (home: string, runtime = readRuntimeRecord(Bun.env, home)?.name ?? defaultRuntime): ThreadWords => async (thread) => {
  if (runtime !== answerRuntime) throw new Error(`Only T3 Code records which answers a person gave in its app, and base.runtime is ${runtime}. Record this decision as an agent decision, or run the thread in T3 Code.`);
  return withT3Session((client) => readThreadWords(client, thread, t3StatePath(t3UserData(home))), { home })
    .catch((error: Error) => { throw new Error(`Cannot read T3 thread ${thread} (${error.message})`); });
};
