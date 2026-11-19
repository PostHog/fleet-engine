# The Mac in Hedge

Hedge runs on cloud boxes: one hub and one or more nodes. The Mac and the
phone run only the T3 Code app. This document says what still touches the
Mac, how each part is tested, and which Mac code is still in the engine.

A test name is written as `file › describe › test`.

## What runs on the Mac

| Part | Who | Test |
| --- | --- | --- |
| The T3 Code app, signed in with T3 Connect | The person installs it and signs in. | None. It is not Hedge code. |
| The setup agent's thread in T3 Code | The agent follows `SETUP.md`. It runs the Coder CLI here, to create the hub and the nodes, and SSH. Every `hedge` command and the Hedge install run on the hub. | `scripts/setup-guide.test.ts › the agent setup guide › installs nothing from Hedge on the Mac: every hedge command runs over SSH on a cloud box` |
| The Coder CLI | The agent installs it to `~/.local/bin` with Coder's own script when it is missing. | None. It is not Hedge code. |
| Load balancing in T3 Code | The person turns it on in **Settings → Environments → Load balancing**, with the hub and the Mac set to **Manual only**. The setting lives in the app on each device, and no T3 Connect command writes it. | None. A person step. |

## `get.sh` on macOS

`get.sh` stops at once on `Darwin`, before it installs or writes anything. It
says that Hedge runs on cloud boxes and points at the setup page.

**Code.** `get.sh`: the `uname -s` check after `set -eu`.

**Test.** `src/get-macos.test.ts › get.sh on macOS › stops before it installs or writes anything, says that Hedge runs on cloud boxes, and points at the setup page`

## Mac code left for a later prune

The engine still holds code that runs only on a Mac. Nothing in the setup
path reaches it now. A later change removes it, with its tests.

| Code | What it did on the Mac |
| --- | --- |
| `src/adapters/jobs/launchd.ts`, `reconcileLaunchd` in `src/adapters/jobs/adapter.ts`, `launchdTimer` in `src/adapters/jobs/schedule.ts` | Ran Hedge's jobs as launchd agents. |
| The `mac` role: `thisMachine` in `src/profile/profile.ts`, the roles in `src/pack/manifest.ts` and `src/pack/types.ts`, the `os` from the role in `src/reconciler/resolve.ts`, and the "Set up this Mac" title and devbox question in `src/setup/setup.ts` | Made a Mac its own kind of machine, with `darwin` items. |
| `balanceThreads` in `src/setup/devbox-balance.ts` | Wrote T3 Code's load balancing weights on the Mac after `hedge devbox add`. |
| `accountHome` with `dscacheutil` in `src/adapters/run.ts` | Looked up the account's home folder. |
| `desktopTarget` and `desktopFields` in `src/adapters/t3/settings.ts`, `serverCli` in `src/adapters/t3/session.ts`, `darwinServerCommand` in `src/integrations/t3/server.ts` | Seeded the T3 Code app's settings, and found its server. |
| The 1Password signer path in `src/adapters/identity/signers.ts` | Signed commits with 1Password's Mac app. |
| `open` in `realMachine.openUrl` in `src/setup/commands.ts` | Opened sign-in pages in the Mac's browser. |
| `packs/hub/lib/hub-tunnel.ts` | Kept the Mac's own tunnel to the hub as a launchd agent. |
| The `darwin` branches in `packs/base/lib/prune.ts`, `packs/guards/lib/package-age.ts`, `src/lock.ts`, and `src/commands/triage.ts` | Used `lsof`, `rm -x`, `~/Library/Preferences`, `libSystem`, and `sw_vers`. |
| The Mac lock in `packs/base/lib/install-codex.sh` | Took the install lock with Python's `fcntl.flock`, because a Mac has no `flock`. |
| The human steps for the `mac` role in `packs/hub/pack.json`, such as trusting the hub's certificate in Keychain Access | Asked the person to do Mac-only steps. |
| The launchd pieces in `src/adapters/fleet/adapter.ts` | Retired an old Fleet's launchd agents. |
| The `needed-you` phases in `src/setup/timings.ts` | Read the Mac install's waits for the person. `get.sh` no longer writes them. |
