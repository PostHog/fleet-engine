import type { RuntimeThread, RuntimeThreads, Where } from "../../../src/sdk/runtime.ts";
import { runActivity } from "./activity.ts";
import { pickMachine, readEachMachine, readMachines } from "./machines.ts";

export type ThreadIo = { host: string; print(line: string): void; readStdin(): Promise<string>; threads(): Promise<RuntimeThreads> };

const usage = `Usage: hedge thread list [host] [--limit count] [--json]
       hedge thread find <id>
       hedge thread read [--host host] <id> [--words]
       hedge thread send [--host host] <id> [message]
Without --host, Hedge finds the machine that has the thread. find names that machine and reads nothing of the thread.
--words prints only the messages a person typed, where the runtime can tell who typed them.
The message comes from stdin when you leave it out.`;
const threadIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9:/._%-]{0,511}$/;

export async function runThread(args: string[], io: ThreadIo): Promise<number> {
  const [action, ...rest] = args;
  if (action === "list") return runActivity(rest, io);
  if (action !== "find" && action !== "read" && action !== "send") throw new Error(usage);
  const { host, threadId, words, typed } = parseTarget(rest, action);
  const text = action === "send" ? await readMessage(words, io) : "";
  const threads = await io.threads();
  const { machine, where, thread } = await placeThread(threads, io.host, threadId, host, action);
  const result = action === "find"
    ? { host: machine, threadId: thread.id }
    : action === "read"
      ? { host: machine, ...(typed ? { words: await personWords(threads, thread.id, where) } : { thread, read: await threads.read(thread.id, where) }) }
      : { host: machine, threadId: thread.id, sent: await threads.send({ id: thread.id, text, ...where }) };
  io.print(JSON.stringify(result, null, 2));
  return 0;
}

async function personWords(threads: RuntimeThreads, id: string, where: Where) {
  const read = await threads.read(id, where);
  if ("screen" in read) throw new Error("This runtime shows a thread as its screen, so it cannot tell which words a person typed. Read the thread without --words.");
  return read.messages.filter((message) => message.role === "user" && message.from === "person");
}

function parseTarget(args: string[], action: "find" | "read" | "send") {
  let host: string | undefined;
  const rest = [...args];
  while (rest[0] === "--host" && action !== "find") {
    rest.shift();
    host = rest.shift();
    if (!host) throw new Error(usage);
  }
  const [threadId, ...words] = rest;
  const typed = action === "read" && words.length === 1 && words[0] === "--words";
  if (!threadId || threadId.startsWith("-") || (action !== "send" && words.length && !typed)) throw new Error(usage);
  if (!threadIdPattern.test(threadId)) throw new Error("Invalid thread id.");
  return { host, threadId, words, typed };
}

async function readMessage(words: string[], io: ThreadIo): Promise<string> {
  const text = (words.length ? words.join(" ") : await io.readStdin()).trim();
  if (!text) throw new Error("The message is empty.");
  return text;
}

async function placeThread(threads: RuntimeThreads, thisHost: string, value: string, host: string | undefined, action: "find" | "read" | "send"): Promise<{ machine: string; where: Where; thread: RuntimeThread }> {
  const machines = await readMachines(threads, thisHost);
  const chosen = host ? [pickMachine(machines, host)] : machines;
  const reports = await readEachMachine(chosen, async (where) => ({ where, thread: await findOne(threads, value, where) }));
  const found = reports.flatMap((report) => (report.error === undefined && report.thread ? [{ machine: report.host, where: report.where, thread: report.thread }] : []));
  const silent = reports.flatMap((report) => (report.error === undefined ? [] : [`${report.host} could not be checked (${report.error})`]));
  if (found.length > 1) throw new Error(`Thread ${value} is on ${found.map((each) => each.machine).join(", ")}. Choose one with --host.`);
  if (found.length === 1 && action === "send" && !host && silent.length) {
    throw new Error(`Thread ${value} is on ${found[0]!.machine}, but ${silent.join("; ")}. Choose the machine with --host.`);
  }
  if (found.length === 1) return found[0]!;
  throw new Error([`No machine has thread ${value}.`, ...reports.flatMap((report) => (report.error === undefined ? [] : [`${report.host}: ${report.error}`]))].join("\n"));
}

async function findOne(threads: RuntimeThreads, value: string, where: Where): Promise<RuntimeThread | undefined> {
  const exact = await threads.find(value, where);
  if (exact) return exact;
  const fits = (await threads.list({ ...where, includeClosed: true })).filter((thread) => thread.closed !== "deleted" && (thread.id.endsWith(`:${value}`) || thread.id.endsWith(`/${value}`)));
  if (fits.length > 1) throw new Error(`${value} fits ${fits.map((thread) => thread.id).join(", ")}. Give the full id.`);
  return fits[0];
}
