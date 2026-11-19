# Getting started

This guide sets up Hedge by hand, from two new Coder workspaces to a hub and
a linked node that run the same Hedge setup. Your Mac and your phone run only
the T3 Code app. The setup agent of the [README](../README.md) runs the same
steps for you; this guide shows what it does.

You need:

- the T3 Code app on your Mac or your phone, signed in with T3 Connect;
- a GitHub account;
- a Claude plan, a ChatGPT plan, or both;
- a Coder deployment where you can create workspaces, and the Coder CLI on
  your Mac. Each workspace needs the Linux prerequisites in the
  [README](../README.md#set-it-up-by-hand): `curl`, `git`, `tar`,
  `sha256sum`, `python3`, cron, and systemd's user manager, with lingering
  on so T3 Code keeps running after you log out.

## 1. Create the hub and a node

On your Mac, sign in to Coder and create two workspaces: a hub with a 200 GB
disk and a node with a 500 GB disk. Give every template parameter with its
own `--parameter`, so you see each value Coder uses. Set the dotfiles
parameter to your profile repo, `https://github.com/<login>/hedge-profile`.
`hedge setup` makes that repo in step 2 when it does not exist yet.

```sh
coder login <your Coder URL>
coder create hedge-hub --template <template> --preset none --parameter <disk parameter>=200 --parameter <dotfiles parameter>=https://github.com/<login>/hedge-profile --yes
coder create hedge-node-1 --template <template> --preset none --parameter <disk parameter>=500 --parameter <dotfiles parameter>=https://github.com/<login>/hedge-profile --yes
coder schedule stop hedge-hub manual
coder schedule stop hedge-node-1 manual
coder config-ssh --yes
```

Add one `--parameter` for each other parameter of the template. Do not use
`--copy-parameters-from`: Coder then takes the copied workspace's values
over every `--parameter` you pass.

Check that SSH works. With the default prefix, the workspace `hedge-hub` is
the host `coder.hedge-hub`:

```sh
ssh coder.hedge-hub true
```

## 2. Run the install line on the hub

Open a shell on the hub with `ssh coder.hedge-hub`, and run this as yourself,
not with `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh
```

`get.sh` installs the GitHub CLI, Bun, and the `t3` command when they are
missing. Then it starts `hedge setup`. Setup asks plain-language questions.
Where it shows a default, press ↵ to take it. On a Mac, `get.sh` stops:
Hedge runs on cloud boxes.

Setup asks you to sign in. A sign-in prints a link, and often a code. Open
the link on your Mac or your phone:

| Sign-in | What it asks |
| --- | --- |
| GitHub | The code from the terminal on `github.com/login/device`, then your approval. Hedge asks for `repo`, `read:org`, `admin:public_key`, `admin:ssh_signing_key`, and `workflow` once, so it can make your profile repo, add your keys, and push to large repos, where GitHub can ask for `workflow` even when a push changes no workflow file. |
| Claude | Your Claude account in the browser. Paste the code it shows back into the terminal. Only when your plan includes Claude. |
| ChatGPT | The code from the terminal, on the page it prints. Only when your plan includes Codex. Setup checks the sign-in with a real request, because a stale sign-in still looks signed in. |

Setup creates the private repo `hedge-profile` in your GitHub account and saves
your answers there. When a team pack you picked names a profile org, setup
creates `hedge-profile-<login>` in that org instead, private to the org, where
teammates may read it. If you already have a personal profile, setup keeps it
and prints the two commands that move it to the org. Then it applies your
packs to the hub and checks the result with `hedge doctor`. It ends with a
screen that lists your packs and what runs by itself.

If you stop, or a step fails, run the same line again. Every step skips what is
done.

## 3. Turn on T3 Connect on the hub

Still on the hub:

```sh
t3 up --connect
```

It prints a link to sign in to T3 Connect. Open it on your Mac or your phone,
and sign in with the account that the T3 Code app uses.

## 4. Name the hub and add the node

Still on the hub, sign it in to Coder, so it reaches the node over SSH. Then
name it the hub, turn on the Hub pack, and add the node:

```sh
coder login <your Coder URL>
coder config-ssh --yes
hedge hub here
hedge packs --add hub
hedge devbox add coder.hedge-node-1
```

`hedge devbox add` runs these steps on the node, in this order. It shows each
one as it starts:

| Step | What it asks |
| --- | --- |
| Install Hedge | Nothing. It runs `get.sh` on the node at the engine ref your profile pins. |
| Sign in to Coder | Nothing. It makes a token on the hub and signs the node in with it. |
| Sign in to GitHub | Type the code that the node prints on `github.com/login/device`. |
| Apply your profile | Nothing. It clones your `hedge-profile` repo on the node and applies it. |
| Sign in to Claude | Open the link it prints, sign in, and paste the code back into the terminal. |
| Sign in to ChatGPT | Open the link it prints and type the code it shows. |
| Link T3 Connect | Open the link that `t3 up --connect` prints on the node and sign in. |
| Link T3 Code | Nothing. It pairs T3 Code on the hub and the node. |

When it ends, it prints that the host is your devbox now, and that the hub
took it. If a step stops, run `hedge devbox add coder.hedge-node-1` again. It
picks up where it stopped.

`hedge devbox` lists your nodes. When a new node replaces an old one,
`hedge devbox remove <ssh host>` on the hub takes the old one out of your
profile and unlinks it in T3 Code.

## 5. Start threads on the nodes

In the T3 Code app, open **Settings → Environments**. The hub and the node
show there through T3 Connect. Then open **Load balancing**, turn it on, and
set the hub and your Mac to **Manual only**. New threads then start on the
node.

## Change things later

Run these on the hub, or on a node:

- `hedge packs` lists your packs. `hedge packs --add <pack>` and
  `--remove <pack>` turn one on or off.
- `hedge settings` lists your settings. `hedge set <pack.key>=<value>` changes
  one.
- `hedge doctor` checks a box against your profile without changing it.
- `hedge update` moves the engine and your profile forward. Each box also
  runs it every night.
- `hedge refresh` asks each pack source that follows a branch, such as a
  skills repository, whether it moved. When it moved forward, it updates the
  files your packs place, such as skills, guides, and instructions, and leaves
  steps, settings, and jobs to the nightly update. Each box runs it every
  five minutes. Your skills are links into Hedge's copy of each source, so an
  edit to a skill is an edit in that copy. Hedge keeps it: `hedge refresh`,
  `hedge apply`, and `hedge update` leave that source where it is and name the
  edited files until you commit or undo them. `hedge refresh` also takes no
  rewritten branch; `hedge update` does.

## When setup goes wrong

`hedge triage` collects what the Hedge maintainer needs to fix a setup
problem: the versions of Hedge, T3 Code, Claude Code, Codex, gh, Bun and your
OS, the `hedge doctor` output, the step that failed and its error, the setup
timings, and the setup transcript. It removes tokens, keys, email addresses,
hostnames and home paths, and shows you the report. Then you pick: open a
public issue on `PostHog/hedge` with it, save it to a file to send
yourself, or neither.

An agent can run `hedge triage --print` to show you the report in the chat,
and `hedge triage --send` once you say yes. `--save <file>` writes it to a
file, and `--note <text>` says what went wrong.

[The Hedge page](https://posthog.github.io/hedge/) shows what each
pack does, and builds the setup prompt with your picks.
