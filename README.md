# <img src="docs/hedge-logo.svg" alt="" width="30" height="30"> PostHog Hedge

<img src="docs/hedge.svg" alt="Your Mac and your phone run only the T3 Code app. It links to your nodes in the cloud, where agent threads work in their own worktrees. Your hub in the cloud links the nodes and keeps your secrets. Every cloud box reads the same private profile repo on GitHub." width="760">

**PostHog Hedge runs your coding agents in the cloud, not on your Mac.**

- **Always on.** Agents keep working when you close your Mac or go to sleep.
- **Secure.** Agents run on isolated cloud boxes. Secrets stay on your hub.
  Your Mac stays clean.
- **With you everywhere.** Read and steer every thread from your Mac or your
  phone.
- **Grows with your work.** Add a node when you need more agents at once.

Hedge sets up one **hub** and one or more **nodes**: Linux boxes in the
cloud, such as Coder workspaces. Each gets T3 Code, Claude Code, Codex, and a
set of agent workflows. You pick the workflows as **packs**. Your answers live
in your own private **profile** repo, so every box gets the same setup. Your
Mac and your phone run only the T3 Code app. Hedge installs nothing on them.

## Getting started

You need a Coder deployment where you can create workspaces, or other Linux
boxes that you reach over SSH.

1. **Download [T3 Code](https://t3.codes)** on your Mac or your phone, and open
   it. Its Welcome page sets up one agent, Claude Code or Codex, and signs you
   in.
2. **Sign in with T3 Connect.** In T3 Code, open **Settings → Sharing &
   access**, sign in, and turn on **T3 Connect**. It shows your hub and your
   nodes in T3 Code on your Mac and your phone.
3. **Paste this prompt** into a new thread in T3 Code, or
   [open it in T3 Code](https://app.t3.codes/new?prompt=Set%20up%20Hedge%20with%20me.%20Read%20https%3A%2F%2Fraw.githubusercontent.com%2FPostHog%2Fhedge%2Fmain%2FSETUP.md%20and%20follow%20it%20step%20by%20step.):

   ```text
   Set up Hedge with me. Read https://raw.githubusercontent.com/PostHog/hedge/main/SETUP.md and follow it step by step.
   ```

From here the agent leads. It creates your hub with the Coder CLI, sets Hedge
up on the hub over SSH, and adds your nodes from the hub. It asks what you
know and what you want, explains each part, and runs the steps itself. You
answer its questions and do your own sign-ins.

## See what it does

Open [the Hedge site](https://posthog.github.io/hedge/) to switch the Pull
requests, Orchestration, and Communication packs on or off. The site builds
the prompt above with your picks in it, so the agent skips those questions.

The [Packs page](https://posthog.github.io/hedge/packs/) shows every
pack, and each pack has its own page. Select packs there, and copy one prompt
that adds them to a Hedge you already run.

`bun scripts/build-page.ts` generates the site from the pack data into
`site/`. To see it, open `site/index.html`.

## Status

Version 0.1.0 is the first public release. It is early. On every pull
request, CI runs the install as a new Linux user, then `hedge setup` and
`hedge doctor`, with a sandbox GitHub account. Other paths are built but not
yet proved end to end, such as the real sign-ins on a new hub. The
[changelog](CHANGELOG.md) lists them under "Known gaps".

## Set it up by hand

Run this on the hub, as your login user, not with `sudo`. It runs on Linux
(x64 or arm64). On a Mac it stops: Hedge runs on cloud boxes, and the Mac
runs only the T3 Code app.

```sh
curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh
```

Read [`get.sh`](get.sh) first if you want to know what runs. It:

- installs what Hedge needs if it is missing: the GitHub CLI, Bun, and T3
  Code. Install `curl`, `git`, `tar`, `sha256sum`, `python3`, and cron first.
  Hedge also needs systemd's user manager, so T3 Code can run as a service.
  To keep it running after you log out, an administrator runs
  `sudo loginctl enable-linger <your user>` once.
- fetches the engine into `~/.local/share/hedge/engine` and puts `hedge` in
  `~/.local/bin`.
- adds one line to your shell's login file, so `~/.local/bin` and
  `~/.bun/bin` are on your `PATH`.
- starts `hedge setup`.

`hedge setup` asks plain-language questions. It asks you to sign in to
GitHub, and to Claude, ChatGPT, or both, depending on the plan you pick. It
then creates the private repo `hedge-profile` in your GitHub account, pushes
your answers there, and applies your packs to this box. Running `get.sh`
again picks up where it stopped.

[Getting started](docs/getting-started.md) walks through it step by step, from
a new Coder workspace to a hub with a linked node, with what each sign-in
asks.

## Develop

```sh
bun install
bun run test
bun run typecheck
```

See [GLOSSARY.md](GLOSSARY.md) for the words Hedge uses.

## License

MIT. See [LICENSE](LICENSE).
