#!/bin/sh
# Runs every hook that a pack put in ~/.config/hedge/hooks/<event>/.
# Usage: run.sh claude|codex <event>
# It starts from the hooks directory, so a repository's bunfig.toml never loads.
set -eu
in_fleet_path() {
  for home in "$HOME" "$(CDPATH='' cd -- "$HOME" && pwd -P)"; do
    for old in .config/fleet .local/state/fleet .local/share/fleet .local/share/fleet-cli-proxy .local/share/fleet-hub-https .local/share/fleet-mcphub; do
      case "$1/" in "$home/$old/"*) return 0 ;; esac
    done
  done
  return 1
}
runner=$0
while [ -L "$runner" ]; do
  link=$(readlink -- "$runner")
  case "$link" in /*) runner=$link ;; *) runner=$(dirname -- "$runner")/$link ;; esac
done
if in_fleet_path "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -L)" || in_fleet_path "$(CDPATH='' cd -- "$(dirname -- "$runner")" && pwd -P)"; then
  echo "Fleet is now Hedge. Run: curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh" >&2
  exit 0
fi
hooks="$HOME/.config/hedge/hooks"
for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ -x "$candidate" ] && bun_binary=$candidate && break
done
bun_binary=${bun_binary:-$(command -v bun || true)}
if [ -z "$bun_binary" ]; then
  echo "Hedge hooks need Bun, and it is not installed. Install it from https://bun.sh, then try again." >&2
  exit 2
fi
cd "$hooks"
exec "$bun_binary" "$hooks/run.ts" "$@"
