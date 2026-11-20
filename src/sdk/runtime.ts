import type { AgentTask, ModelRow, Plan, TimerSchedule } from "../pack/types.ts";
import type { AdapterContext, AdapterResult } from "../reconciler/apply.ts";
import type { StartedThread, ThreadStart } from "./index.ts";
import type { Machine } from "../setup/commands.ts";

export type ScheduledTask = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: TimerSchedule;
  project: string;
  modelRole: string;
  workspaceStrategy: AgentTask["workspaceStrategy"];
  runtimeMode: AgentTask["runtimeMode"];
};

export type AgentTasks = { list(): Promise<ScheduledTask[]>; upsert(task: ScheduledTask): Promise<void>; setEnabled(id: string, enabled: boolean): Promise<void> };

/** A machine whose threads this runtime reaches. self is this machine. problem says why the runtime cannot reach it now. */
export type RuntimeMachine = { name: string; id: string; self: boolean; problem?: string };

export type ThreadState = "working" | "waiting" | "blocked" | "idle" | "done" | "error";

export type RuntimePullRequest = { url: string; repository?: string; number?: number; state?: string };

export type RuntimeThread = {
  id: string;
  /** The machine's name in machines(), or undefined for this machine. */
  machine?: string;
  title: string;
  state: ThreadState;
  /** What the thread waits on a person for: a question or a permission, and a key that changes with each new ask. */
  blocked?: { kind: "question" | "permission" | "auth"; key: string };
  closed?: "archived" | "deleted" | "settled";
  parentId?: string;
  cwd?: string;
  branch?: string;
  updatedAt?: string;
  latestText?: string;
  model?: string;
  error?: string;
  url?: string;
  /** Set only by a runtime with the prLinks capability. */
  pullRequests?: RuntimePullRequest[];
};

/** from: who wrote a user message, a person in the runtime's app or an agent, when the runtime can tell. */
export type RuntimeMessage = { id: string; role: "user" | "assistant"; text: string; at: string; from?: "person" | "agent" };

export type ThreadRead = { messages: RuntimeMessage[] } | { screen: string };

/** What a runtime can tell beyond the shared operations. A pack checks a capability before it relies on one. */
export type RuntimeCapabilities = { machines: boolean; prLinks: boolean; transcript: boolean };

export type Where = { machine?: string };

export type RuntimeThreads = {
  start(def: ThreadStart & Where): Promise<StartedThread>;
  send(def: { id: string; text: string } & Where): Promise<boolean>;
  list(options?: Where & { includeClosed?: boolean }): Promise<RuntimeThread[]>;
  find(id: string, options?: Where): Promise<RuntimeThread | undefined>;
  read(id: string, options?: Where & { since?: string; tail?: number }): Promise<ThreadRead>;
  machines(): Promise<RuntimeMachine[]>;
};

export type RuntimeOptions = { home: string; models: ModelRow[] };

export type RuntimeAdapter = {
  /** The files that hedge apply --adopt may name for this runtime. */
  targets?(plan: Plan): string[];
  apply(plan: Plan, context: AdapterContext): Promise<AdapterResult>;
  /** The runtime's scheduled tasks after its apply, or undefined while the runtime does not answer. */
  tasks?(): Promise<AgentTasks | undefined>;
};

/** A start whose answer was lost: the thread may exist, so the caller retries with the same key on the same machine. */
export class MaybeStarted extends Error {
  override name = "MaybeStarted";
}

/** True for a MaybeStarted from any copy of this module, since a runtime loads from its own pack path. */
export const isMaybeStarted = (error: unknown): error is MaybeStarted => error instanceof Error && error.name === "MaybeStarted";

export type AgentRuntime = {
  name: string;
  /** The name a person reads, such as T3 Code or Herdr. */
  title: string;
  capabilities: RuntimeCapabilities;
  threads(options: RuntimeOptions): RuntimeThreads;
  /** The variable that the runtime sets in its agents' environment to the id of the thread they run in. */
  threadVariable: string;
  adapter?(): RuntimeAdapter;
  onboarding?(): RuntimeOnboarding;
};

export type OnboardingContext = { here: Machine; on(host: string): Machine; print(line: string): void; rerun: string };

export type NodeIds = Record<string, string>;

export type NodeSignIn = { id: string; title: string; why: string; command: string[]; probe(): Promise<boolean> };

export type FleetTasks = { list(): Promise<Array<{ id: string; enabled: boolean }>>; setEnabled(id: string, enabled: boolean): Promise<void>; saved?: true };

export type RuntimeOnboarding = {
  tool?: string;
  nodeSignIn?(host: string, node: Machine): NodeSignIn;
  link(host: string, context: OnboardingContext): Promise<void>;
  linkFromHub(host: string, hub: string, context: OnboardingContext & { hubIsHere: boolean; hubTook: boolean }): Promise<void>;
  unlink(host: string, context: OnboardingContext & { home: string; ids: NodeIds }): Promise<{ unlinked: boolean; hint?: string }>;
  address?(here: Machine): Promise<string>;
  balance?(context: OnboardingContext & { home: string; hub?: string; nodes: string[]; ids: NodeIds; remember(ids: NodeIds): Promise<void> }): Promise<void>;
  fleetTasks?(home: string): Promise<FleetTasks | undefined>;
};
