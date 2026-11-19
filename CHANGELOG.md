# Changelog

## Unreleased

### Hedge is cloud only

- Hedge runs your agents on a hub and one or more nodes in the cloud. The
  Mac and the phone run only the T3 Code app. The "Mac only" setup is gone
  from the site, `SETUP.md`, the presets, and the docs.
- On a Mac, `get.sh` stops before it installs anything, and points at the
  setup page.
- The setup agent creates the hub and the nodes with one `coder create`
  each, with every template parameter given and the profile repo as
  dotfiles, and reads the build's parameters back. It sets Hedge up on the
  hub over SSH, and adds the nodes from the hub.
- On a box without a browser, ChatGPT signs in with a device code, and
  Claude in a terminal.

### Fleet is now Hedge

- The product and its command are now Hedge and `hedge`. `get.sh` points
  `fleet` at the same command, so the habit from before the rename keeps
  working.
- To upgrade, run
  `curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh`
  once. It makes a fresh checkout of the engine in
  `~/.local/share/hedge/engine`. It never reuses the old checkout. It ignores
  a `FLEET_ENGINE_DIR` or `HEDGE_ENGINE_DIR` that leads into a Fleet path, by
  its real path, or that is the Fleet checkout: its launcher is `fleet`, its
  remote is `fleet-engine`, or the old `fleet` command runs it. It stops when
  a Hedge folder is a link into a Fleet path.
- On the first run, `get.sh` copies the setup from before the rename: the
  profile checkout, the machine file, `~/.config/fleet` with the secret store,
  the SSH key, the step ledger, and the credential folders of the hub proxy,
  the MCP hub, and the hub's HTTPS share. It points the machine file at the
  profile copy only when the copy is the same repository at the same commit
  and loads as a profile. It never copies the engine, locks, logs, run state,
  caches, or `node_modules`. It copies each file on its own with its mode,
  skips links, and stops when a link is on the way to a new path. It never
  replaces a file, and it leaves a new path that was there before as it is.
  An import that stopped part way copies the rest on the next run.
- Then `get.sh` runs `hedge retire-fleet`, and then `hedge apply`.
  `hedge retire-fleet` finds the launchd agents `dev.fleet.*` and
  `com.fleet.*`, the systemd user units `fleet-*`, the `fleet-mcphub`
  container, and the T3 tasks `fleet:*`. It stops and turns off each one,
  keeps its files, and checks that each one is stopped. When it cannot show
  that one is stopped, it names it and exits 1, and `get.sh` stops before
  apply. Stop what it names by hand, then run `get.sh` again. A retry after a
  failed apply runs apply again.
- `hedge apply` starts nothing while a piece of Fleet still runs, or while it
  cannot tell. It names each piece and says to run `hedge retire-fleet`.
  There is no handoff and no rollback: Fleet stops first, then Hedge starts.
- An engine that runs from a Fleet path, such as `~/.local/share/fleet/engine`
  after the old updater pulled this release, changes nothing. It prints
  `Fleet is now Hedge. Run: curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh`.
  Its scheduled jobs and hooks exit 0, so they raise no alert. Every other
  command exits 1. It checks the path as written and with its links resolved.
- Hedge never writes, owns, or removes a file under an old name. It never
  uses or writes a profile in a Fleet path: `hedge apply --profile` uses the
  Hedge copy or refuses, and `hedge set` writes only to the copy. `hedge
  prune` never touches a worktree in a Fleet path, or one whose Git folder is
  in a Fleet path. Delete the old paths when you no longer need them.
- Crontab lines and T3 worktree scripts from before the rename are replaced
  by the new ones.
- A profile with `fleet.json` and no `hedge.json` still works. Each `FLEET_`
  variable still works while its `HEDGE_` variable is unset. A `HEDGE_`
  variable that is set, even to an empty string, wins. Setup reuses a
  `fleet-profile` or `fleet-memory` repo.
- The repository is now `PostHog/hedge`, and the site is
  https://posthog.github.io/hedge/. GitHub sends the old repository address
  to the new one, so git, `get.sh` links and profiles that name
  `PostHog/fleet-engine` keep working. The old site address no longer works.

## v0.1.0

The first public release. Fleet sets up T3 Code, Claude Code, Codex, and a set
of agent workflows on a Mac and on Linux devboxes. You pick the workflows as
packs, and your answers live in your own private profile repo.

### The command

- `get.sh` installs what Fleet needs, fetches the engine (`main`, or the tag
  or commit you give with `--ref`), puts `fleet` on the login PATH, and starts
  `fleet setup`. Running it again picks up where it stopped. It tries each
  download up to three times, and stops a download that cannot connect in 20
  seconds or stalls for a minute. It finds the newest T3 Code nightly in the
  releases feed, so the T3 Code installer does not use the GitHub API quota
  that shared networks run out of.
- `fleet setup` asks plain-language questions and offers a default wherever a
  pack has one. A devbox it sets up is listed in your profile, taken by
  your hub and linked from it, as `fleet devbox add` does; it refuses the
  same names. `--preset` starts from a preset's packs.
  `--non-interactive` asks nothing and lists what it still needs, such as
  sign-ins.
- `fleet apply` puts your profile's packs onto the machine. `fleet doctor`
  checks the machine against the same plan without changing it. `fleet update`
  moves the engine and your profile forward, then applies.
  When `fleet apply` installs T3 Code on Linux, it finds the nightly the same
  way `get.sh` does and runs the installer up to three times.
- `fleet packs`, `fleet settings`, and `fleet set` turn packs and workflows on
  and off and change their settings. `fleet devbox add` makes an SSH host one
  of your devboxes.

### Packs

- **Base** (always on): safety rules, the model table, T3 Code defaults written
  before its first start, linked machines, worktree cleanup, a disk guard, and
  nightly updates. A Claude Agent call that names no model is sent back with
  the model table. A prompt that asks to review a pull request, commit, or
  diff gets the table and a reminder that the reviewer is a worker that did
  not write the code. With Codex, a rules file lets Codex run these commands
  outside its sandbox without asking: Git fetches, pulls, and pushes; `gh`
  commands that read pull requests, runs, issues, and repos, and
  `gh pr create`, `edit`, and `ready`, which change pull requests; `bun` and
  `pnpm` installs, which run package scripts; `fleet heavy` and `fleet proof`,
  which run any command they are given; and `fleet doctor`,
  `fleet apply --dry-run`, and other `fleet` commands that read. A pack ships
  its own Codex rules with `codexRules`;
  Fleet writes them as `~/.codex/rules/fleet-<pack>.rules` and keeps a rules
  file you changed.
- **Pull requests** (on): every fix or feature ends as a proven, reviewed draft
  pull request. Ship words take it to merged.
- **Orchestration** (on): big work becomes a map of tickets that a conductor
  thread works through, and side work gets its own thread. The quality loop,
  the signal loop, and the PR digest are opt-in.
- **Communication** (on): agents write in your voice, give short updates, and
  share plans and previews as links.
- **Integrations** (off): Claude Code and Codex get the official GitHub,
  Context7, and Convex plugins, and with both AI plans Claude hands work to
  Codex through OpenAI's Codex plugin. Convex is opt-in. Fleet installs and
  removes only the plugins it installed, through each provider's own CLI, and
  `fleet doctor` lists each sign-in the plugins still need.
- **Memory** (off): agents on all your machines share what they learn through
  your own private memory repo.
- **Context library** (off): a prompt about a topic of your private notes repo
  gets links to its documents. `fleet context` searches the notes, saves a link
  as a condensed note, and keeps a catalog and topic hubs. Every machine pulls
  the repo every five minutes, keeps local changes, and fails the sync while
  they block it. With the MCP gateway, the hub serves a read-only
  `context_search` tool over the same notes.
- **Hub** (off): one always-on devbox manages the others. It signs in to your
  MCP servers once, keeps your devboxes linked, and watches their disks. The
  Slack bridge and the Google apps turn off the native Codex app they replace. A
  pack can run its own small MCP server in the gateway, with folders mounted
  read-only. The nightly Dream task and own-account balancing are opt-in.
  Own-account balancing routes Claude Code across several of your own
  subscriptions. It is off by default, and the page shows the Anthropic terms
  it touches.
- **Slack** (off): your own message, reaction, or mention in Slack starts a T3
  thread about it. With the Context library on, your `:brain:` reaction saves
  the thread and its canvases to your notes.
- **incident.io** (off): an agent that watches a risky change pages you, and
  only you, through your own incident.io alert source with `fleet page`. With
  a hub, the token lives on the hub and every other machine pages through it.

Team packs plug in as pack sources. The presets are Starter, Everyday, and
Everything.

### The site

[The Fleet site](https://posthog.github.io/hedge/) says what Fleet is
and offers two setups side by side: Mac only, and Mac plus a hub and a node.
Each setup has a switch for Pull requests, Orchestration, and Communication.
The Getting started prompt sits under the two setups and changes with each
choice. Copy it, or open it in T3 Code.

[The Packs page](https://posthog.github.io/hedge/packs/) shows every
pack, and each pack has its own page with its workflows, its cost, and its
settings. For a Fleet that already runs, select packs, and the page builds an
install prompt that adds them with `fleet packs --add`.

### Known gaps

CI proves the Linux first-run path on every pull request: a new Linux user
runs `get.sh` from the pull request's tree, then `fleet setup --non-interactive
--preset everyday` and `fleet doctor`, with a sandbox GitHub account. A second
user installs from the profile repo that setup made, the way a devbox does.
Setup leaves only the real sign-ins open, and `fleet doctor` finds nothing
open for either user.

These paths are built but not yet proved end to end, because each needs a
person's sign-in or machine: a run on a clean Mac user, real GitHub, Claude,
and ChatGPT sign-ins, `t3 up --connect`, and a live Coder devbox.
