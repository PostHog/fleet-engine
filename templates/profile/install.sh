#!/bin/sh
# Installs Hedge from this profile: runs the engine's get.sh at the engine ref
# pinned in hedge.json, then applies this profile.
set -eu
dir=$(cd "$(dirname "$0")" && pwd -P)
file=hedge.json
[ -f "$dir/$file" ] || [ ! -f "$dir/fleet.json" ] || file=fleet.json
engine_slug=PostHog/fleet-engine
ref=$(tr -d '\r\n' <"$dir/$file" |
  sed -n 's/.*"engine"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p' |
  sed -n 's/.*"ref"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case "$ref" in
  "" | *[!A-Za-z0-9._/-]*) echo "Hedge: $file needs an engine ref, such as v0.1.0." >&2; exit 1 ;;
esac
script=$(mktemp)
trap 'rm -f "$script"' EXIT
url="https://raw.githubusercontent.com/$engine_slug/$ref/get.sh"
if ! curl -fsSL "$url" -o "$script"; then
  # While the engine repository is private, a signed-in gh can still fetch it.
  if ! command -v gh >/dev/null 2>&1 || ! gh api -H "Accept: application/vnd.github.raw" "repos/$engine_slug/contents/get.sh?ref=$ref" >"$script"; then
    echo "Hedge: could not download $url." >&2
    exit 1
  fi
fi
sh "$script" --ref "$ref" --profile "$dir"
