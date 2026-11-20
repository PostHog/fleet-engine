# Build lab

Experiments for the `build` skill: one entry skill with a sizing **judge** that picks the size of new work and loads only that size's file. The lab is not part of the pack: no `pack.json` names it, and Hedge installs nothing from it.

- `drafts/build/` is the draft skill: `SKILL.md` holds the judge and the one-off path, `ISSUE.md` the issue path, and `MAP.md` the map path, which hands over to `orchestration-wayfinder`.
- `requests.json` holds the sample requests and the size each one should get. Requests with `before` and `then` test the judge again after the thread grows.
- `lab.ts` runs the experiments and prints ratings. `score.ts` scores them.

## Run

The lab reads `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`. It reads installed skills from `~/.claude/skills`; pass `--skills <dir>` for another folder.

```sh
bun packs/orchestration/build-lab/lab.ts measure
bun packs/orchestration/build-lab/lab.ts judge layered
bun packs/orchestration/build-lab/lab.ts judge flat
bun packs/orchestration/build-lab/lab.ts trigger today
bun packs/orchestration/build-lab/lab.ts trigger description
bun packs/orchestration/build-lab/lab.ts trigger instruction
```

- `measure` counts the tokens of each file and of each path, from the judge alone to a map's first act.
- `judge <layered|flat>` sends each request to the model with the skill as the system prompt and scores the verdict line. `layered` sends `SKILL.md` alone; `flat` sends one file with the judge, the issue path, and the whole conductor.
- `trigger <today|description|instruction>` runs Claude Code under a temporary `HOME` with the skills of the Pull requests, Orchestration, and Communication packs, in a small fake repository, with read tools only. It records the first skill each request loads. `today` has no `build` skill, `description` adds it, and `instruction` also adds one line to `CLAUDE.md` that says to start every build with it.

Options: `--model <id>` (default `claude-haiku-5-5`), `--reps <n>` runs per judge request (default 3), `--only <id prefix>`, `--jobs <n>`, `--verbose`.
