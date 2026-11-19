# Set up Hedge with the person

You are an agent in T3 Code. The person pasted the prompt from the Hedge
README or the Hedge page. Set up Hedge with them, from nothing to a passing
`hedge doctor` on a **hub** and one or more **nodes**: Linux boxes in the
cloud, such as Coder workspaces. Agents run only there.

The machine you run on, usually their Mac, keeps only the T3 Code app and the
Coder CLI. Install nothing from Hedge here: run every `hedge` command, and the
Hedge install, on the hub over SSH.

## How you work

- **Guide.** Before each step, say in one or two plain sentences what it does
  and why. Size it to what they know (step 2).
- **Ask with your question tool.** Every choice goes through it. Each option
  says what the person gets and what they give up, and one option is marked
  as recommended. Put independent questions in one call. When your question
  tool takes fewer questions in one call, ask the rest in a second call right
  after the first.
- **Secrets go through the secret prompt.** Ask for every secret, such as an
  API key, a token, or a code to paste, with the host's secret prompt (in T3
  Code, its `request_secret` tool), delivered as a file. Never ask in chat,
  and never send a paste to a Terminal window. Say in one line what the
  secret is for and where to make it. Then give the file to the command as
  the step shows, on its standard input or in a variable, also over SSH.
  Only when the host has no secret prompt, run the command in a Terminal
  window (see "Terminal only for a terminal screen"), where it asks for the
  secret itself.
- **Say a word before you use it.** The first time you say a Hedge word to the
  person, such as workflow, pack, profile, hub, or node, explain it in one
  plain line.
- **Keep it short.** One or two sentences per explanation.
- **Run every command yourself.** The person answers, approves, and does their
  own sign-ins in their browser. A sign-in on the hub prints a link and often
  a one-time code: give both to the person, and say what the sign-in is for.
- **Show, then tell.** Where a step names a visual, show it as a page in the
  chat when you can (T3 Code shows HTML pages that agents publish). Otherwise
  describe it in three lines of text.
- **One PATH.** Your shell may have started before the Coder CLI was
  installed, and a command over SSH does not read the box's login files.
  Begin every command that runs `hedge`, `gh`, `bun`, `claude`, `codex`, `t3`,
  or `coder`, here or over SSH, with
  `export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";`.
- **When a step fails.** Explain its last lines and fix what they name. When
  it still fails, or the cause is not clear, offer `hedge triage` on the hub.
  It exists after the install makes `~/.local/bin/hedge` there. Run
  `hedge triage --print --note "<the failed step and its last line>"` over SSH
  and show the person the report. It opens a **public** issue for the Hedge
  maintainer, with private details taken out, so ask before you run the same
  command with `--send`. When `gh` is not signed in, `--send` saves the
  report to a file, says where, and exits 1. That exit is not a new failure.
- **Terminal only for a terminal screen.** A command that draws its own
  screen in a terminal and reads the person's keys there, such as
  `claude auth login` on the hub, runs in a Terminal window: write it to a
  file in `~/.cache/hedge-setup` that ends in `.command`, with a `#!/bin/sh`
  line and the `PATH` line above, make it executable, and `open` it. Ask them
  to tell you when it ends. Each step that needs this says so. When you do
  not run on a Mac, give the person the command to run in their own
  terminal instead.

## Picks from the page

The prompt can end with a list that starts with `My picks from the Hedge
page:`. The person chose these on the Hedge page, so do not ask for them
again. When a step uses a line, say the pick back in one sentence and go on.
Ask everything else as the steps say. Without the list, ask every question.

| Line | How to use it |
| --- | --- |
| `Packs on the first setup` | The packs for step 6, picked one by one. `none` means no pack. Still ask the AI plan, and read each pack's setup note. |
| `Packs once the hub runs` | The answer to item 2 of step 9. `none` means no pack, so skip item 2. |

The page names packs only. Each pack's setup note still asks which of its
workflows to turn on and which settings it needs.

A prompt from an earlier page can carry more lines. Use them too:

- `Where Hedge runs`: ignore it. Hedge now always runs on a hub and nodes.
- `Workflows on the first setup` and `Workflows once the hub runs`: add the
  list to the command of that step as `--workflows`, without the spaces. Such
  a line wins over a workflow flag from a setup note.
- `Setting`: add `--set <key>=<value>` to the setup command in step 7, once
  for each line.

## While something runs

Steps 5, 7, and 9 start commands that take minutes. While one runs in the
background, explain one of these, in two or three lines, and do not repeat
one. Skip a topic that does not fit their picks:

- **T3 Code's inbox.** A thread that finishes or waits for them shows up in
  the inbox. They answer it there, on the Mac or the phone.
- **The Slack trigger.** With the Slack pack, their own Slack message with
  `:t3code:` starts a thread about it.
- **Threads on nodes.** T3 Code starts each new thread on a node. The thread
  keeps working while the Mac sleeps or is closed.
- **What runs each night.** The hub and each node run `hedge update` every
  night, so they take the newest engine and their profile by themselves. The
  last screen of setup lists the other jobs under "Runs by itself".

Say whether the step runs once or again later. The install and each sign-in
run once per box. `hedge update` runs again every night by itself.

## 1. Check this machine and Coder

Run `uname -s` and `id -u`. Go on when the user ID is not `0`. Hedge needs
nothing else here but the Coder CLI.

**Coder CLI.** When `command -v coder` finds nothing, download
`https://coder.com/install.sh` to `~/.cache/hedge-setup/coder-install.sh`,
read it, and run it. It needs no Homebrew and no password:

```sh
sh ~/.cache/hedge-setup/coder-install.sh --method standalone --prefix "$HOME/.local"
```

When `coder whoami` fails, sign in. Read their Coder address from the `url`
file in Coder's settings folder: `~/Library/Application Support/coderv2` on a
Mac, `~/.config/coderv2` on Linux. Ask for the address only when that file is
missing. Coder needs a session token: it lets this machine act as them in
Coder, and they make one at `<coder address>/cli-auth`. Ask for it with the
secret prompt, delivered as a file, and sign in with it:

```sh
CODER_SESSION_TOKEN="$(cat <file>)" coder login <coder address>
```

Without a secret prompt, run `coder login <coder address>` in a Terminal
window, where it asks for the token itself. Coder is done when `coder whoami`
passes. When they have no Coder deployment, stop: this setup needs Coder
today. Plain Linux boxes over SSH are not supported yet. "Set it up by hand"
in the README installs Hedge on one Linux box.

**An earlier setup.** Run `coder list`. For each workspace that runs, check
whether Hedge runs there and whether it is the hub. Their boxes can have any
name, so do not skip one whose name does not start with `hedge-`:

```sh
ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge hub status'
```

Run `coder config-ssh --yes` first when `ssh coder.<name>` finds no host.
When a hub answers, show its packs with `hedge packs` there, and ask:

- **Change only what they name** (recommended): run `hedge packs` on the hub
  with `--add`, `--remove`, and `--workflows` for each change, and follow the
  setup note of each pack they add. Then check the hub as in step 8, and end
  there. Skip step 9: its command sets first-install defaults, such as
  `mcp-gateway=off`, that would change what they did not name. Everything
  else stays as it is.
- **Run setup again**: setup reuses their profile repo and starts from its
  packs, workflows, and settings. In the step 7 command, leave out
  `--preset`, and name only what changes with `--add`, `--remove`, and
  `--workflows`. Everything else stays as it is. Files they changed by hand
  are kept, and step 8 shows them. Skip step 5 for the hub.

An earlier Hedge or Fleet that runs on this Mac stays as it is until the hub
works. Then offer to stop it. On a Mac, `get.sh` installs nothing: it only
stops and turns off the launchd jobs of an earlier Fleet or Hedge, and keeps
their files. Download it to `~/.cache/hedge-setup/get.sh`, read it, and run
`sh ~/.cache/hedge-setup/get.sh` here. Tell them they can delete
`~/.local/share/hedge` or `~/.local/share/fleet` by hand afterwards.

## 2. Ask everything in one call

Ask these questions now, in one call of your question tool. Then the
creation and the setup do not wait for the person. Setup notes can add
questions later (step 6). Leave out each question that the picks from the
page already answer. On a rerun of setup (step 1), leave out the Packs
question: setup starts from the packs in their profile.

1. **New to you.** A multi-select question: "Which of these are new to you?"
   with T3 Code (the app you are talking in), Hedge (what it sets up),
   Cloud boxes (Linux machines in the cloud, such as Coder workspaces, where
   agents keep working while the Mac sleeps), and "None, I know all three".
2. **Nodes**, with the options of step 4.
3. **Packs**, with the options of step 6.
4. **AI plan**, with the options of step 6.

Also find their GitHub login: run `gh api user --jq .login` when `gh` works
here, and otherwise add it as a fifth question. Step 5 needs it.

Each pick in question 1 adds an explainer to a later step:

| New to | Add |
| --- | --- |
| T3 Code | In step 3: a **thread** is one agent conversation with its own task. A **worktree** is a separate checkout of the same repo, so several threads change code at once without touching each other. T3 Code shows every box's threads on the Mac and the phone. |
| Hedge | In step 3: the picture, and one pack from step 6 with one of its workflows as an example. |
| Cloud boxes | In step 4: what a hub and a node are, and why agents run there. |

When the packs are "One by one", ask the multi-select of step 6 right after.

## 3. Show what Hedge is

Fetch the picture from
`https://raw.githubusercontent.com/PostHog/hedge/main/docs/hedge.svg`
and show it. Then say: Hedge runs your agents in the cloud, not on your Mac.
It installs agent rules, skills, and workflows on your hub and your nodes. A
**workflow** is one way of working that agents follow, such as a draft pull
request for every fix. A **pack** is a set of workflows that you turn on as
a whole. Your answers go to your **profile**, a private GitHub repo named
`hedge-profile`, so every box you add gets the same setup. A team pack can
keep its members' profiles in the team's GitHub org instead, as
`hedge-profile-<login>`, so teammates can read each other's setup.

## 4. The hub and the nodes

Hedge sets up one **hub** with a 200 GB disk and one **node** with a 500 GB
disk, both Linux boxes in the cloud that stay on while the Mac sleeps. The
hub links the boxes, watches their disks, and keeps the pack secrets, such
as the Slack, incident.io, and MCP gateway sign-ins. The nodes
are where threads do the work. Step 2 asks how many nodes, with these
options:

- **One node** (recommended): enough for a few threads at once. Add more
  later, when the load grows.
- **Two nodes**: twice as many threads at once. The hub, two nodes, and the
  Mac use 4 machines of T3 Connect, so this needs a paid T3 Chat plan.

They can name more nodes in their own answer. Below, "the nodes" means as
many as they chose.

**T3 Connect's limit.** A free T3 Connect account links up to 3 machines.
The hub, each node, and the Mac each use one, and so does every other
machine already on their account, such as an old hub that they keep until
its replacement works. Before step 5 creates anything, count the machines on
their account, from the T3 Connect page in T3 Code's account menu, plus the
new ones. When the count is over 3, say so and let them choose: fewer nodes,
removing a machine they no longer use from that page, or a paid T3 Chat
plan, which they link in T3 Code's account menu under **T3 Chat** → **Link
T3 Chat** (up to 10 machines with Pro).

## 5. Create the hub and the nodes

Create every workspace now, at once, and go on to step 6 while they start.
Show each command as you start it. Put only values that are not secret on a
command line: every program on the Mac can read the arguments of a running
command. A private value that is not a secret, such as an email address,
shows as `<private>` in a command you show, and you never print it back. A
secret, such as a token or a key, never goes on a command line. Item 4 says
how a secret reaches a workspace.

1. **Names.** Use `hedge-hub` and `hedge-node-1`, `hedge-node-2`, and so on.
   When `coder list` already has a workspace by that name that they do not
   reuse, add the next free number instead, such as `hedge-hub-2`, so the
   new box and the one it replaces never share a name. Ask for a name only
   when they want another. Below, `<hub>` and `<node>` stand for them, and
   `<name>` for any of them.
2. **Template.** List them with `coder templates list`. When there is one,
   use it; ask only when there are more. Read its parameters, the
   `coder_parameter` blocks in its files:

   ```sh
   coder templates pull <template> ~/.cache/hedge-setup/template-<template>
   ```

   When `coder templates pull` fails, open the template's page in the Coder
   web app, `<coder address>/templates/<template>`, and ask the person to
   read you the parameters and their allowed values from it.

   Find the disk size, the region, and the dotfiles parameters. Ask for the
   region and for each other parameter without a default, in one call.
3. **Profile repo.** The dotfiles parameter is their profile repo, so each
   start of a workspace applies their profile. Find it before you create:
   when `gh` works here, run
   `gh repo view <repo> --json nameWithOwner --jq .nameWithOwner` for
   `<login>/hedge-profile`, then for `<login>/fleet-profile`, its name from
   before the rename, and use the first that answers. Otherwise use
   `<login>/hedge-profile`: `hedge setup` makes it in step 7. Until then,
   the workspace's dotfiles script finds no repo and says so in its start
   log. That is expected. A team pack can keep the profile in its GitHub org
   instead; step 7 checks the repo again. Below, `<profile repo>` is the
   `owner/name` you found.
4. **Create.** Pass every parameter of the template that is not a secret
   with its own `--parameter`, also those where the default is right, so you
   see each value Coder uses. Give the hub a 200 GB disk and each node a 500 GB disk.
   `--preset none` stops the preset question that `--yes` does not skip:

   ```sh
   coder create <name> --template <template> --preset none --parameter <disk parameter>=<200 or 500> --parameter <region parameter>=<region> --parameter <dotfiles parameter>=https://github.com/<profile repo> --parameter <other parameter>=<value> --yes
   ```

   Write one `--parameter` for each parameter the template has, except a
   secret one. Never use `--copy-parameters-from`: Coder then takes the
   copied workspace's values over every `--parameter` you pass.

   Never give a secret, such as a token or a key, with `--parameter`. Coder
   also keeps each parameter value with the workspace's build, where anyone
   who can see the workspace reads it. When a template parameter asks for a
   secret, do not create that workspace with `coder create`, and do not ask
   for the secret. Ask the person to create it in the Coder web UI instead:
   they open the template's create form, give the workspace the name from
   item 1, type the secret in the form, and fill in the other values you
   give them. Tell the person that Coder still keeps the secret with the
   build. When they tell you the workspace name, go on with item 5.

   Start the hub and the nodes at once, each in the background. They take
   minutes; use the wait (see "While something runs").
5. **Keep them running.** Agents work there while the Mac sleeps:
   `coder schedule stop <name> manual`.
6. **Check them.** When a create ends, check that the workspace runs, that
   no stop time ends it, and that the parameters this guide sets have the
   values you passed: the disk size, the region, the instance type, and the
   dotfiles repo. Never pass a private value to the check. The check never
   takes or prints a private value: it reads the build's parameter list from
   Coder, compares only the parameters you pass, and prints only parameter
   names, never a value or the Coder session token. Download the check once,
   and read it:

   ```sh
   mkdir -p ~/.cache/hedge-setup && curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/scripts/check-workspace.sh -o ~/.cache/hedge-setup/check-workspace.sh && cat ~/.cache/hedge-setup/check-workspace.sh
   ```

   Then run it for each workspace, with those parameters of its create:

   ```sh
   sh ~/.cache/hedge-setup/check-workspace.sh <name> <parameter>=<value> <parameter>=<value>
   ```

   The step is done when every line starts with `ok`. Do what each `x` line
   says, and run the check again. To change a parameter that the template
   lets change, restart the workspace from this Mac with the new value:
   `coder restart <name> --parameter <parameter>=<value> --yes`.
   `coder update` changes nothing while the workspace uses the template's
   active version. A parameter that the template does not let change, such
   as the disk size or the region, needs a new workspace: ask, then
   `coder delete <name>` and create it again, before setup touches it.
7. **SSH.** Run `coder config-ssh --yes`. The step is done when
   `ssh coder.<name> true` passes for each workspace.

## 6. What they want

Step 2 asks these. Skip the packs question when the picks from the page name
the packs:

- **Packs.** One option per preset in
  `https://raw.githubusercontent.com/PostHog/hedge/main/presets.json`, with
  its `blurb`, and "One by one". For one by one, ask a multi-select question
  with the packs below whose row says "Always". A pack whose row says
  "Step 9" needs a hub that runs, so step 9 offers it. Base is always on.
  [The Hedge page](https://posthog.github.io/hedge/) shows what each pack
  does.
- **AI plan.** Claude, ChatGPT, or both: it decides the sign-ins and the
  model defaults. Recommend the agent they set up in T3 Code.

For each pack they pick whose row names a setup note, read that note from
the engine repo, such as
`https://raw.githubusercontent.com/PostHog/hedge/main/packs/slack/SETUP.md`
for the Slack pack, and follow it in step 7. Read only the notes of the
packs they picked. Ask the questions of all the notes together, in one call,
before step 7. A `hedge` command in a note runs on the hub over SSH, with the
`PATH` line, as in step 7. Run the steps that a note puts after the setup
command only once step 7 has named the hub.

| Pack | What it does | Offer it | Setup note |
| --- | --- | --- | --- |
| `pull-requests` | Every fix or feature ends as a proven, reviewed draft pull request, and ship words take it to merged. | Always | None |
| `orchestration` | Big work becomes a map of tickets that a conductor thread works through, and side work gets its own thread. | Always | `packs/orchestration/SETUP.md` |
| `communication` | Agents write in your voice, give short updates, and share plans and previews as links. | Always | None |
| `integrations` | Claude Code and Codex get the official GitHub, Context7, and Convex plugins, and Claude can hand work to Codex. | Always | None |
| `memory` | Agents on all your machines share what they learn through your own private memory repo. | Always | `packs/memory/SETUP.md` |
| `context-library` | Agents find your plans, research, decisions and saved threads in a private notes repo, and you save new ones with one command. | Always | `packs/context-library/SETUP.md` |
| `recovery` | Threads that stop on a usage limit or a provider outage continue once the provider answers again, and hedge providers says which provider has capacity. | Step 9 | `packs/recovery/SETUP.md` |
| `guards` | Hooks stop an agent's shell commands from running network code, using GitHub outside your owners, pushing past review, or polling in loops. | Always | `packs/guards/SETUP.md` |
| `slack` | Your own message, reaction, or mention in Slack starts a T3 thread about it. | Always | `packs/slack/SETUP.md` |
| `incident-io` | An agent that watches a risky change pages you, and only you, through incident.io when it goes wrong. | Always | `packs/incident-io/SETUP.md` |
| `hub` | One always-on devbox manages the others. It keeps your devboxes linked and watches their disks. | Step 9 | `packs/hub/SETUP.md` |
| `mcp-gateway` | The hub signs in to your MCP servers once, and agents on every machine reach them through it. | Step 9 | `packs/mcp-gateway/SETUP.md` |

## 7. Set up Hedge on the hub

Every command in this step runs on the hub over SSH. Wait until
`ssh coder.<hub> true` passes.

1. **Sign the hub in to Coder.** The hub reaches the nodes over SSH through
   Coder, so it needs its own Coder session. Make a token here and send it on
   standard input, so it never shows in the chat:

   ```sh
   coder tokens create | ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; { command -v coder >/dev/null || { case $(uname -m) in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) exit 1;; esac; mkdir -p "$HOME/.local/bin" && curl -fsSL "<coder address>/bin/coder-linux-$a" -o "$HOME/.local/bin/coder" && chmod +x "$HOME/.local/bin/coder"; }; } && IFS= read -r token && CODER_SESSION_TOKEN="$token" coder login --use-token-as-session <coder address> && coder config-ssh --yes'
   ```

2. **Install.** Download the install script on the hub and read it. Keep it
   in view, because a pipe into `sh` hides what runs:

   ```sh
   ssh coder.<hub> 'mkdir -p ~/.cache/hedge-setup && curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh -o ~/.cache/hedge-setup/get.sh && cat ~/.cache/hedge-setup/get.sh'
   ```

   Tell the person in two lines what it adds on the hub when missing: the
   GitHub CLI, Bun, and the `t3` command, the engine in
   `~/.local/share/hedge/engine`, `hedge` in `~/.local/bin`, and one `PATH`
   line in its login file. When the script does more than this, tell them
   what, and ask before you start it. Then start it in the background:

   ```sh
   ssh coder.<hub> 'sh ~/.cache/hedge-setup/get.sh --install-only'
   ```

   It is done when `~/.local/bin/hedge help` on the hub prints the list of
   commands. When it stops with an error, explain its last lines, fix what
   they name, and run it again: it continues from where it stopped.
3. **Setup.** Build the command from the answers, so setup asks nothing
   twice:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge setup --chat --preset <id> --plan <claude|codex|both>'
   ```

   For one by one, use `--preset starter`, add `--remove pull-requests` when
   they did not pick it, and add `--add <pack>` once per other pack they
   picked.

   Start it in the background and read its output as it comes. It waits for
   each sign-in that ends in the browser. While it runs:

   - **A sign-in starts** (`▶ Sign in to …`). Say what it is for, from the
     table below, and give the person the link and any one-time code the
     output shows. They open the link on the Mac or the phone. Setup goes on
     by itself once they finish in the browser.
   - **`✓ Ready to use.`** The hub is set up. The steps it names go on in the
     background; say what each one does.

   When it ends with code `2`, it lists what it still needs:

   - **A line `--set <pack.key>=<value>   <question>`.** Ask the question with
     your question tool, then add `--set <pack.key>=<answer>` to the command.
   - **A line `Needs you: <sign-in>`, then `In a terminal, run: <command>`.**
     Say what it is for. When the pack's setup note says how to give the
     command its secrets, such as `hedge slack-trigger setup` in the Slack
     note, follow the note: ask with the secret prompt and give the files to
     the command over SSH. Only a command that draws its own terminal screen
     runs in a Terminal window (see "Terminal only for a terminal screen").
     Claude's sign-in is one: it prints a link, and the person pastes the
     code from the browser back into the terminal. Run it as:

     ```sh
     ssh -t coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; claude auth login'
     ```

   Then run the same setup command again. Every step skips what is done. On
   any other stop, read the last lines, explain them, and fix what they
   name. Use each wait (see "While something runs").

   Setup prints the profile repo it uses, in a line
   `✓ Created the private repo <repo>` or `✓ Reusing your repo <repo>`. When
   that is not `<profile repo>` from step 5, such as a profile in a team's
   GitHub org, change the dotfiles parameter of each workspace. Run it here
   on the Mac, never on the hub over SSH, because the restart stops the hub:
   `coder restart <name> --parameter <dotfiles parameter>=https://github.com/<repo> --yes`.
   Then run the check of step 5 again, and wait until
   `ssh coder.<name> true` passes. When the template does not let the
   parameter change, the box still works: its nightly `hedge update` keeps
   it on their profile.

   | Sign-in | What it is for |
   | --- | --- |
   | GitHub | Once, with every permission Hedge needs: it creates their private `hedge-profile` repo, adds the hub's SSH key, and reads their org's packs. A code to type at a GitHub page. |
   | Claude | Claude Code on the hub uses their Claude plan. In a Terminal window, as above. |
   | ChatGPT | Codex on the hub uses their ChatGPT plan. A code to type at a ChatGPT page. Setup checks it with a real request. When it fails, setup says how to turn on device code sign-in, or how to sign in in the browser of this machine over an SSH port forward instead. |

4. **Name the hub.** Run this right after setup ends, before any step that a
   pack's setup note puts after the setup command. The Slack and incident.io
   notes run commands that work only on the hub:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge hub here'
   ```

   It saves `coder.<hub>` as the hub in their profile. Then do the steps that
   each note puts after the setup command.

5. **T3 Connect on the hub.** It lets T3 Code on the Mac and the phone reach
   the hub. Start it in the background, and give the person the link it
   prints to sign in to T3 Connect:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; t3 up --connect --yes --headless'
   ```

### Another Hedge keeps the files

When setup stops with a `To do:` line that starts with `Another Hedge setup
keeps`, the files it names belong to another Hedge on the hub, such as an
earlier Fleet. Say how many files that is, and that they are the same kind
of rules and guides Hedge installs. Ask:

- **Take them over** (recommended): run the `hedge apply --adopt-from <name>`
  that the line names on the hub, then the setup command again. Hedge copies
  the other Hedge's state and every file or linked folder it replaces to
  `~/.local/state/hedge/backups/`. A linked folder moves whole, with
  everything in it, so say which ones move. The other Hedge's files that
  this profile does not write stay where they are, except those inside a
  linked folder that moves, and the old Codex rules file
  `~/.codex/rules/fleet.rules`. Hedge removes that file while it is unchanged,
  because the base pack's rules replace it, and keeps it when it changed.
- **Stop here**: nothing changes, and setup cannot finish while the other
  Hedge keeps the files.

## 8. Check the hub

```sh
ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge doctor'
```

Run it with the hub's name. The step is done when every line is explained to
the person:

- `Fix:` Hedge can repair it. Run `hedge apply` there, then `hedge doctor`
  again.
- `To do:` the person does it. Say exactly what and where. When it names a
  command that takes a token or a code, ask for it with the secret prompt
  and give the file to the command over SSH, as its pack's setup note shows.
- `Note:` information only.
- `Everything matches your profile.` The box is set up.

### When Hedge kept something of theirs

A line that starts with `Kept your` names a file or a setting that was on the
box before Hedge, which Hedge left as it was. Never show the raw key alone.
Say in plain words what it controls, what Hedge's value does instead, and
whether `hedge doctor` passes while it stays. Then ask:

- **Take Hedge's version**: run the `hedge apply --adopt <path>` that the
  line names. A line that says `Removed item changed locally` names a file
  that Hedge no longer installs, so there is nothing to take: keep it, or
  move it away by hand. Hedge keeps the new file up to date, and their old
  file stays in `~/.local/state/hedge/backups/`. When the old file holds their own
  skills or rules, agents stop reading them. Say which ones they lose, and
  offer to move the ones they still want to the "About me" file in their
  profile, which agents read after the packs' rules.
- **Keep theirs**: nothing changes, and the line stays in `hedge doctor`. This
  makes sense when they set the value on purpose, such as a model proxy their
  company needs.

Recommend taking Hedge's version, unless they set the value on purpose.

## 9. Add the hub packs and the nodes

Run each item on the hub over SSH. `hedge devbox add` takes minutes; use each
wait (see "While something runs").

When cloud boxes were new to them, explain the hub first: it is the one box that
looks after the others. It keeps an SSH tunnel and a T3 link to every node,
and cleans a node's disk before it fills. The node is where threads do the
work. Each node keeps working when the hub is down.

When step 7 printed that a team pack is ticked, such as `✓ You are in the
<org> org, so the <pack> pack is ticked`, read that pack's setup note on the
hub first, when it has one:

```sh
ssh coder.<hub> 'cat ~/.local/share/hedge/sources/<source>/packs/<pack>/SETUP.md'
```

`<source>` is the folder in `~/.local/share/hedge/sources` on the hub that
holds the pack. Its note can name another template, parameters, or a box the
pack makes itself. Where it differs from the items below, follow the note.
When it names another template than step 5 used, replace the nodes: see
"Clean up what you replace".

Item 2 runs only on a first setup, because its command sets first-install
defaults. On a rerun of setup (step 1), skip item 2, and run items 1, 3, and
4 for each node that step 5 created. A change to an earlier setup that
creates no node ends at step 8 (see step 1).

1. **The hub.** Item 4 of step 7 named it. Check that this prints
   `The hub: coder.<hub>`:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge hub status'
   ```

2. **Hub packs.** Ask with a multi-select question which of these to turn
   on, unless the picks from the page name the packs for once the hub runs.
   Recommend the `hubPacks` of the preset they chose in step 6, from
   `presets.json`, or Hub alone for one by one. Read the setup note of each
   one they pick, now:

   - **Hub**: the hub links the boxes and watches their disks.
     `packs/hub/SETUP.md`
   - **MCP gateway**: the hub signs in to their MCP servers once.
     `packs/mcp-gateway/SETUP.md`
   - **Recovery**: threads that stop on a usage limit go on by themselves.
     `packs/recovery/SETUP.md`

   Start from this command, add `--add <pack>` for each other pack they
   picked, and change or add the flags their notes name. With picks from the
   page, leave out `--add hub` when the line does not name `hub`:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge packs --add hub --workflows mcp-gateway=off'
   ```

3. **Each node.** Run `hedge devbox add` on the hub, for each node, one after
   the other. It installs Hedge on the node, signs it in to Coder, GitHub,
   Claude, and ChatGPT, applies their profile, turns on T3 Connect there, and
   links T3 Code on the hub and the node. Its Claude sign-in draws its own
   terminal screen, so run it in a Terminal window:

   ```sh
   ssh -t coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge devbox add coder.<node>'
   ```

   Before it opens, explain its sign-ins from the table in step 7, and the T3
   Connect link: the person opens it and signs in, as for the hub. Ask them
   to tell you when it prints that the host is their devbox now.

   It lists the node in their profile and has the hub take it before the
   node applies, so the hub's tunnels, disk watch, and credentials include
   it. It prints two lines that start with `✓ The hub` when both worked.
   When it says the hub did not answer, run `hedge update` on the hub. When
   it says the hub has not linked the node yet, run
   `hedge peers link coder.<node>` on the hub.
4. **Check.** Run the `hedge doctor` of step 8 on each node, and on the hub
   again. Explain each line as in step 8.

To add a node later, when the load grows, create it as in step 5 with the
next node name and a 500 GB disk, then run item 3 above for it, and its
`hedge doctor`.

**Clean up what you replace.** When a new hub or node replaces an old
workspace, clean up only after item 4 passes on the new one, and ask before
you remove anything. A workspace from step 5 that `hedge devbox add` never
touched is not a devbox yet. It needs only the `coder delete`, after the
person says yes, and it can go at once.

1. Take the old box out of their profile, on the hub:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge devbox remove coder.<old name>'
   ```

   It takes the old host out of their profile and unlinks it in T3 Code on
   the hub. The hub stops its tunnel, disk watch, and link to that host at
   its next `hedge update`. An old hub can go only after `hedge hub here`
   named the new one. When it stops with an error, fix what it names and run
   it again.
2. Delete the old workspace with `coder delete <old name>`, and remove it in
   T3 Code's Settings → Environments on the Mac.

## 10. Start threads on the nodes

T3 Code on the Mac and the phone reaches the hub and the nodes through T3
Connect. Ask the person to open T3 Code's **Settings → Environments** and
check that the hub and each node are listed. When one is missing, pair it
through its T3 Connect address, as `hedge devbox add` links the boxes. Print
the address on that box:

```sh
ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge devbox address'
```

It asks the T3 Code server that runs on that box, so it finds the address
also when `t3 connect status` does not print it. When it says that T3
Connect is off, start it on that box as in item 5 of step 7, give the person
its sign-in link, and run it again. When it says that T3 Code gives no
tunnel address, stop, and make no token. Tell the person that this box does
not report its address yet, and pair it later. Make a pairing token
only once you have the address:

```sh
ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; t3 pair --ttl 10m --label t3-app'
```

Give the person the address and the token after `Token:`. Never give the
`Pairing URL` it prints: it names the box's own loopback address, which the
Mac and the phone cannot reach. They add the box in **Settings →
Environments** with that address and token.

Then make new threads start on the nodes. This setting lives in the T3 Code
app on each device, so the person sets it: in **Settings → Environments →
Load balancing**, turn it on, and set the hub and this Mac to **Manual
only**. The nodes then take every new thread. Ask them to tell you when it
is done, and to start one test thread to see it open on a node.

## 11. Hand over

Add their profile as a T3 Code project named `hedge-profile` on the hub, so
they can open a thread there. Skip it when T3 Code already lists that
project:

```sh
ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; t3 project add --title hedge-profile ~/.local/share/hedge/profile'
```

Then give them these habits, one line each:

- When something does not fit how you work, open a thread in the
  `hedge-profile` project and say what to change. Every box takes the
  change.
- Hedge keeps itself up to date: each box runs `hedge update` every night.
- **Side fix.** When an agent finds an unrelated problem, it hands the fix to
  a new thread with its own pull request, and stays on its task.
- **Conductor.** For big work, one thread writes a map of tickets and starts
  one worker thread per ticket.

Leave out a habit whose pack they did not pick: the last two need the
Orchestration pack.
