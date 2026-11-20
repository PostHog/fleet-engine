import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  isRegrade,
  parseVerdict,
  renderJudgeSummary,
  renderTriggerSummary,
  showExpected,
  showVerdict,
  sizeHit,
  summarizeJudge,
  summarizeTrigger,
  type Run,
  type Sample,
  type TriggerRun,
} from "./score.ts";

const here = import.meta.dir;
const draft = join(here, "drafts", "build");
const repoRoot = resolve(here, "..", "..", "..");

const { values: options, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    skills: { type: "string", default: join(homedir(), ".claude", "skills") },
    model: { type: "string", default: "claude-haiku-5-5" },
    "count-model": { type: "string", default: "claude-opus-5-5" },
    reps: { type: "string", default: "3" },
    jobs: { type: "string", default: "6" },
    only: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
});

const samples: Sample[] = (JSON.parse(await readFile(join(here, "requests.json"), "utf8")) as Sample[]).filter(
  (sample) => !options.only || sample.id.startsWith(options.only),
);

const apiBase = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const apiHeaders: Record<string, string> = {
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  ...(process.env.ANTHROPIC_API_KEY ? { "x-api-key": process.env.ANTHROPIC_API_KEY } : { authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN ?? ""}` }),
};

async function api<T>(path: string, body: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${apiBase}${path}`, { method: "POST", headers: apiHeaders, body: JSON.stringify(body) });
    if (response.ok) return (await response.json()) as T;
    if (attempt >= 4 || ![429, 500, 529].includes(response.status)) throw new Error(`${path} ${response.status}: ${(await response.text()).slice(0, 300)}`);
    await Bun.sleep(2000 * attempt);
  }
}

const countTokens = async (text: string) =>
  (await api<{ input_tokens: number }>("/v1/messages/count_tokens", { model: options["count-model"], messages: [{ role: "user", content: text }] })).input_tokens;

async function pool<T, R>(items: T[], jobs: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!);
      }
    }),
  );
  return results;
}

const read = (path: string) => readFile(path, "utf8").catch(() => "");
const skillFile = (name: string, file = "SKILL.md") => read(join(options.skills!, name, file));
const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, "");
const description = (text: string) => text.match(/^description:\s*(.*)$/m)?.[1] ?? "";

type Part = { name: string; text: string };

async function parts(): Promise<Record<string, Part>> {
  const entries: [string, Promise<string>][] = [
    ["build/SKILL.md", read(join(draft, "SKILL.md"))],
    ["build/ISSUE.md", read(join(draft, "ISSUE.md"))],
    ["build/MAP.md", read(join(draft, "MAP.md"))],
    ["orchestration-wayfinder/SKILL.md", skillFile("orchestration-wayfinder")],
    ["orchestration-wayfinder/CLAUDE.md", skillFile("orchestration-wayfinder", "CLAUDE.md")],
    ["orchestration-wayfinder/T3.md", skillFile("orchestration-wayfinder", "T3.md")],
    ["orchestration-wayfinder/LANE.md", skillFile("orchestration-wayfinder", "LANE.md")],
    ["orchestration-wayfinder/SHIP.md", skillFile("orchestration-wayfinder", "SHIP.md")],
    ["wayfinder/SKILL.md", skillFile("wayfinder")],
    ["impact/SKILL.md", skillFile("impact")],
    ["grilling/SKILL.md", skillFile("grilling")],
    ["domain-modeling/SKILL.md", skillFile("domain-modeling")],
    ["lessons/SKILL.md", skillFile("lessons")],
    ["t3-kickoff/SKILL.md", skillFile("t3-kickoff")],
    ["full-stop/SKILL.md", skillFile("full-stop")],
    ["full-stop/INTAKE.md", skillFile("full-stop", "INTAKE.md")],
    ["full-send/SKILL.md", skillFile("full-send")],
    ["research/SKILL.md", skillFile("research")],
    ["prototype/SKILL.md", skillFile("prototype")],
    ["architecture/SKILL.md", skillFile("architecture")],
    ["orchestration AGENTS.md", read(join(repoRoot, "packs", "orchestration", "AGENTS.md"))],
  ];
  const loaded = await Promise.all(entries.map(async ([name, text]) => ({ name, text: await text })));
  return Object.fromEntries(loaded.map((part) => [part.name, part]));
}

const flatSkill = (all: Record<string, Part>) =>
  [all["build/SKILL.md"]!.text, body(all["build/ISSUE.md"]!.text), "# Build: map\n", body(all["orchestration-wayfinder/SKILL.md"]!.text)].join("\n");

async function measure() {
  const all = await parts();
  const missing = Object.values(all).filter((part) => !part.text).map((part) => part.name);
  if (missing.length) console.log(`missing, counted as 0: ${missing.join(", ")}`);
  const tokens: Record<string, number> = {};
  await pool(Object.values(all), 6, async (part) => (tokens[part.name] = part.text ? await countTokens(body(part.text)) : 0));
  tokens["flat build/SKILL.md"] = await countTokens(body(flatSkill(all)));
  tokens["build description"] = await countTokens(description(all["build/SKILL.md"]!.text));
  tokens["orchestration-wayfinder description"] = await countTokens(description(all["orchestration-wayfinder/SKILL.md"]!.text));

  console.log("\nTokens per file, counted with", options["count-model"]);
  for (const [name, count] of Object.entries(tokens).sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(7)}  ${name}`);

  const sum = (names: string[]) => names.reduce((total, name) => total + (tokens[name] ?? 0), 0);
  const conductor = ["orchestration-wayfinder/SKILL.md", "wayfinder/SKILL.md", "orchestration-wayfinder/CLAUDE.md"];
  const conductorInT3 = [...conductor, "orchestration-wayfinder/T3.md"];
  const charting = ["impact/SKILL.md", "grilling/SKILL.md", "domain-modeling/SKILL.md", "lessons/SKILL.md"];
  const pullRequest = ["full-stop/SKILL.md", "full-send/SKILL.md", "full-stop/INTAKE.md"];
  const paths: [string, string[]][] = [
    ["today: /orchestration-wayfinder, before its first act", conductor],
    ["today: the same in T3 Code", conductorInT3],
    ["today: a map until its first ticket", [...conductorInT3, ...charting]],
    ["today: a one-off with a pull request, no orchestration", ["impact/SKILL.md", ...pullRequest]],
    ["layered: the judge only (a question)", ["build/SKILL.md"]],
    ["layered: one-off up to its draft pull request", ["build/SKILL.md", "impact/SKILL.md", ...pullRequest]],
    ["layered: issue up to its plan question", ["build/SKILL.md", "build/ISSUE.md", "impact/SKILL.md"]],
    ["layered: map before its first act, in T3 Code", ["build/SKILL.md", "build/MAP.md", ...conductorInT3]],
    ["flat: the judge only (a question)", ["flat build/SKILL.md"]],
    ["flat: one-off up to its draft pull request", ["flat build/SKILL.md", "impact/SKILL.md", ...pullRequest]],
    ["flat: issue up to its plan question", ["flat build/SKILL.md", "impact/SKILL.md"]],
    ["flat: map before its first act, in T3 Code", ["flat build/SKILL.md", "wayfinder/SKILL.md", "orchestration-wayfinder/CLAUDE.md", "orchestration-wayfinder/T3.md"]],
  ];
  console.log("\nTokens each path loads, beyond what every session loads");
  for (const [name, names] of paths) console.log(`${String(sum(names)).padStart(7)}  ${name}`);

  console.log("\nTokens per section of orchestration-wayfinder/SKILL.md");
  const sections = body(all["orchestration-wayfinder/SKILL.md"]!.text).split(/\n(?=## )/);
  const counts = await pool(sections, 6, async (section) => ({ title: section.split("\n")[0]!, count: await countTokens(section) }));
  for (const { title, count } of counts) console.log(`${String(count).padStart(7)}  ${title}`);
}

const judgeSystem = (skill: string) =>
  [
    "You are a coding agent in a repository. The user sent a request, and you loaded the skill below.",
    "Run only its judge now: the Judge section for a new request, or the Judge again section when the thread already has a verdict.",
    "Your whole reply is the verdict line the skill asks for, and nothing else. You cannot read files in this run; judge from the request.",
    "",
    "<skill>",
    skill,
    "</skill>",
  ].join("\n");

type Message = { role: "user" | "assistant"; content: string };

const judgeMessages = (sample: Sample): Message[] =>
  isRegrade(sample)
    ? [
        { role: "user", content: sample.text },
        { role: "assistant", content: `Build: ${sample.before}. Judged from the request.` },
        { role: "user", content: sample.then! },
      ]
    : [{ role: "user", content: sample.text }];

type Reply = { content: { type: string; text?: string }[]; usage: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };

async function judge(variant: string) {
  const all = await parts();
  const skill = variant === "flat" ? flatSkill(all) : all["build/SKILL.md"]!.text;
  const reps = Number(options.reps);
  const system = [{ type: "text", text: judgeSystem(skill), cache_control: { type: "ephemeral" } }];
  const runs: Run[] = await pool(samples, Number(options.jobs), async (sample) => {
    const replies = await Promise.all(
      Array.from({ length: reps }, () => api<Reply>("/v1/messages", { model: options.model, max_tokens: 4000, system, messages: judgeMessages(sample) })),
    );
    const usage = replies[0]!.usage;
    const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const texts = replies.map((reply) => reply.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
    if (options.verbose) for (const text of texts) console.log(`  ${sample.id}: ${text.trim().split("\n")[0]}`);
    return { sample, verdicts: texts.map(parseVerdict), inputTokens };
  });

  console.log(`\nJudge: ${variant} skill, ${options.model}, ${reps} runs per request`);
  console.log(`${"request".padEnd(18)} ${"expected".padEnd(24)} got`);
  for (const run of runs) {
    const mark = run.verdicts.every((verdict) => sizeHit(verdict, run.sample)) ? "ok " : "MISS";
    console.log(`${mark} ${run.sample.id.padEnd(16)} ${showExpected(run.sample).padEnd(24)} ${run.verdicts.map(showVerdict).join("  ")}`);
  }
  console.log(`\n${renderJudgeSummary(`${variant} skill, ${options.model}`, summarizeJudge(runs))}`);
}

const instructionLine = "- Start every task that builds, fixes, or changes something with the `build` skill.";

const packSkills = async () => {
  const names = new Set<string>();
  for (const pack of ["pull-requests", "orchestration", "communication"]) {
    const manifest = JSON.parse(await readFile(join(repoRoot, "packs", pack, "pack.json"), "utf8")) as { skills?: string[] };
    for (const ref of manifest.skills ?? []) names.add(ref.split("/").pop()!);
  }
  return [...names];
};

const fakeApp: Record<string, string> = {
  "README.md": "# Shop\n\nThe shop app. Payments recieve webhooks from Stripe.\n",
  "package.json": JSON.stringify({ name: "shop", dependencies: { "smol-toml": "^1.0.0" } }, null, 2),
  "src/jobs/retry.ts": "export const defaultRetries = 3;\n",
  "src/cart.test.ts": "import { test } from 'bun:test';\ntest('adds an item', () => {});\n",
  "src/status.ts": "export function status() { return 'ok'; }\n",
};

async function trigger(variant: string) {
  const root = await mkdtemp(join(tmpdir(), "build-lab-"));
  try {
    const home = join(root, "home");
    const skillsDir = join(home, ".claude", "skills");
    await mkdir(skillsDir, { recursive: true });
    const names = await packSkills();
    const copied = await Promise.all(
      names.map(async (name) => {
        const source = join(options.skills!, name);
        if (!(await Bun.file(join(source, "SKILL.md")).exists())) return undefined;
        await cp(source, join(skillsDir, name), { recursive: true, dereference: true });
        return name;
      }),
    );
    if (variant !== "today") await cp(draft, join(skillsDir, "build"), { recursive: true });
    const instructions = await read(join(repoRoot, "packs", "orchestration", "AGENTS.md"));
    await writeFile(join(home, ".claude", "CLAUDE.md"), variant === "instruction" ? `${instructions.trimEnd()}\n${instructionLine}\n` : instructions);
    const work = join(root, "work");
    for (const [path, text] of Object.entries(fakeApp)) {
      await mkdir(join(work, path, ".."), { recursive: true });
      await writeFile(join(work, path), text);
    }
    await Bun.$`git init -q`.cwd(work).quiet();
    console.log(`\nTrigger: ${variant}, ${options.model}, ${copied.filter(Boolean).length} pack skills${variant === "today" ? "" : " plus build"}`);

    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) if (process.env[key]) env[key] = process.env[key]!;
    const runs: TriggerRun[] = await pool(
      samples.filter((sample) => !isRegrade(sample)),
      Number(options.jobs),
      async (sample) => {
        const child = Bun.spawn(
          ["claude", "-p", "--model", options.model!, "--output-format", "stream-json", "--verbose", "--max-turns", "8", "--tools", "Skill", "Read", "Glob", "Grep", "--", sample.text],
          { cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        const output = await new Response(child.stdout).text();
        await child.exited;
        let skill: string | undefined;
        let costUsd = 0;
        for (const line of output.split("\n").filter(Boolean)) {
          const event = JSON.parse(line) as { type: string; total_cost_usd?: number; message?: { content?: { type: string; name?: string; input?: { skill?: string } }[] } };
          if (event.type === "result") costUsd = event.total_cost_usd ?? 0;
          if (event.type !== "assistant" || skill) continue;
          skill = event.message?.content?.find((part) => part.type === "tool_use" && part.name === "Skill")?.input?.skill;
        }
        if (options.verbose) console.log(`  ${sample.id}: ${skill ?? "-"}`);
        return { sample, skill, costUsd };
      },
    );
    console.log(`${"request".padEnd(18)} ${"expected".padEnd(10)} first skill`);
    for (const run of runs) console.log(`${run.sample.id.padEnd(18)} ${run.sample.size.padEnd(10)} ${run.skill ?? "-"}`);
    console.log(`\n${renderTriggerSummary(`${variant}, ${options.model}`, variant === "today" ? "orchestration-wayfinder" : "build", summarizeTrigger(runs, variant === "today" ? "orchestration-wayfinder" : "build"))}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const [command, variant] = positionals;
if (command === "measure") await measure();
else if (command === "judge" && (variant === "layered" || variant === "flat")) await judge(variant);
else if (command === "trigger" && (variant === "today" || variant === "description" || variant === "instruction")) await trigger(variant);
else {
  console.log("usage: bun packs/orchestration/build-lab/lab.ts measure | judge <layered|flat> | trigger <today|description|instruction> [--model <id>] [--reps <n>] [--only <id prefix>] [--skills <dir>] [--verbose]");
  process.exit(2);
}
