#!/bin/sh
# Hedge bootstrap. Installs what Hedge needs, fetches the engine at a pinned
# ref, installs its packages, puts hedge on the login PATH, then runs
# hedge setup, or hedge apply when --profile names a profile.
#
#   curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh
#   sh get.sh [--ref <ref>] [--profile <dir> | --install-only] [-- <flags for hedge>]
#
# Running it again picks up where it stopped: every step skips what is done.
set -eu

say() { printf 'Hedge: %s\n' "$*" >&2; }
fail() {
  say "$*"
  [ "$(sed -n 2p "$HOME/.local/bin/hedge" 2>/dev/null)" != "# Hedge" ] || say "Stuck? Run hedge triage. It shows a report of this setup that you can send to the Hedge maintainer."
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

profile=
install_only=
ref_flag=
ref_given=
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] && [ -n "$2" ] && [ "${2#-}" = "$2" ] || fail "--ref needs a value. Put flags for hedge after --."; ref_flag=$2; ref_given=1; shift 2 ;;
    --profile) [ $# -ge 2 ] && [ -n "$2" ] && [ "${2#-}" = "$2" ] || fail "--profile needs a directory. Put flags for hedge after --."; profile=$2; shift 2 ;;
    --install-only) install_only=1; shift ;;
    --) shift; break ;;
    *) fail "unknown option $1. Put flags for hedge after --." ;;
  esac
done

preview=
for arg in "$@"; do [ "$arg" != --dry-run ] || preview=1; done

[ "$(id -u)" -ne 0 ] || fail "run this as your login user, without sudo."

retire_mac_jobs() {
  uid=$(id -u)
  old_jobs=$({
    for plist in "$HOME"/Library/LaunchAgents/*.plist; do [ -e "$plist" ] && basename "$plist" .plist; done
    launchctl list 2>/dev/null | sed 's/.*[[:space:]]//'
  } | grep -E '^(dev[.]fleet|com[.]fleet|dev[.]hedge)[.]' | sort -u)
  if [ -n "$preview" ]; then
    for label in $old_jobs; do say "This is a preview, so Hedge did not stop or turn off the launchd job $label of an earlier Fleet or Hedge. Without --dry-run, get.sh stops it and turns it off."; done
    return
  fi
  not_off=
  for label in $old_jobs; do
    target="gui/$uid/$label"
    launchctl bootout "$target" >/dev/null 2>&1 || :
    launchctl disable "$target" >/dev/null 2>&1 || :
    off=yes
    loaded=0
    launchctl print "$target" >/dev/null 2>&1 || loaded=$?
    if [ "$loaded" -ne 113 ]; then
      say "the launchd job $label of an earlier Fleet or Hedge still runs. Stop it with: launchctl bootout $target"
      off=
    fi
    listed=$(launchctl print-disabled "gui/$uid" 2>/dev/null) && listed_ok=yes || listed_ok=
    if [ -z "$listed_ok" ] || ! printf '%s\n' "$listed" | grep -F "\"$label\" =>" | grep -Eq '=> (disabled|true)$'; then
      say "launchd still has the job $label of an earlier Fleet or Hedge turned on, so it starts again at the next login. Turn it off with: launchctl disable $target"
      off=
    fi
    if [ -n "$off" ]; then
      say "stopped and turned off the launchd job $label of an earlier Fleet or Hedge, and kept its files."
    else
      not_off="$not_off${not_off:+, }$label"
    fi
  done
  if [ -n "$not_off" ]; then
    say "these launchd jobs of an earlier Fleet or Hedge are not off yet: $not_off. Run the commands above, then run get.sh again."
    exit 1
  fi
}

if [ "$(uname -s)" = Darwin ]; then
  for arg in "$@"; do [ "$arg" = --dry-run ] || fail "on a Mac, get.sh takes only --dry-run after --, not $arg."; done
  retire_mac_jobs
  say "Hedge runs on cloud boxes, not on a Mac. Your Mac only runs the T3 Code app. To set up your hub, follow https://posthog.github.io/hedge/#start"
  [ -n "$old_jobs" ] || exit 1
  exit 0
fi

engine_slug=PostHog/hedge
default_engine_dir=$HOME/.local/share/hedge/engine
bun_version=1.4.4

setting() {
  value=$2
  from=
  if eval "[ -n \"\${HEDGE_$1+set}\" ]"; then from=HEDGE_$1; elif eval "[ -n \"\${FLEET_$1+set}\" ]"; then from=FLEET_$1; fi
  [ -z "$from" ] || eval "value=\$$from"
  [ -z "$from" ] || [ -n "$value" ] || fail "$from is set but empty. Unset it or give it a value."
}

in_fleet_path() {
  for home in "$HOME" "$(CDPATH='' cd -- "$HOME" && pwd -P)"; do
    for old in .config/fleet .local/state/fleet .local/share/fleet .local/share/fleet-cli-proxy .local/share/fleet-hub-https .local/share/fleet-mcphub; do
      case "$1/" in "$home/$old/"*) return 0 ;; esac
    done
  done
  return 1
}

real_path() {
  rest=
  path=$1
  while [ ! -d "$path" ]; do
    rest="/${path##*/}$rest"
    path=${path%/*}
    [ -n "$path" ] || path=/
  done
  printf '%s%s\n' "$(CDPATH='' cd -- "$path" && pwd -P)" "$rest"
}

leads_into_fleet() { in_fleet_path "$1" || in_fleet_path "$(real_path "$1")"; }

fleet_link() {
  path=$1
  while [ "$path" != "$HOME" ] && [ -n "$path" ]; do
    if [ -L "$path" ] && leads_into_fleet "$path"; then first=$path; fi
    path=${path%/*}
  done
  printf '%s\n' "${first:-$1}"
}

refuse_fleet() {
  first=
  ! leads_into_fleet "$1" || fail "$(fleet_link "$1") leads into a Fleet path from before the rename. Move that link away, then run get.sh again."
}

old_launcher() { sed -n "s|^exec sh '\\(.*\\)/fleet' \"\\\$@\"\$|\\1|p" "$HOME/.local/bin/fleet" 2>/dev/null; }

fleet_checkout() {
  [ -d "$1" ] || return 1
  { [ -e "$1/fleet" ] && [ ! -e "$1/hedge" ]; } && return 0
  case "$(git -C "$1" remote get-url origin 2>/dev/null)" in */fleet-engine|*/fleet-engine.git) return 0 ;; esac
  recorded=$(old_launcher)
  [ -n "$recorded" ] && [ -d "$recorded" ] && [ "$(real_path "$recorded")" = "$(real_path "$1")" ]
}

setting ENGINE_REPO "https://github.com/$engine_slug.git"
engine_repo=$value
setting ENGINE_REF main
ref=$value
[ -z "$ref_given" ] || ref=$ref_flag
setting ENGINE_DIR "$default_engine_dir"
engine_dir=$value
case "$engine_dir" in /*) ;; *) engine_dir="$PWD/$engine_dir" ;; esac
if [ -n "$from" ] && leads_into_fleet "$engine_dir"; then
  say "$from points into a Fleet path from before the rename, so the engine goes to $default_engine_dir."
  engine_dir=$default_engine_dir
elif [ -n "$from" ] && fleet_checkout "$engine_dir"; then
  say "$engine_dir is the engine from before the rename, so the engine goes to $default_engine_dir."
  engine_dir=$default_engine_dir
fi
for destination in "$engine_dir" "$HOME/.local/state/hedge"; do refuse_fleet "$destination"; done

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

# hedge setup reads this log to time the whole install, from this line on.
install_log="$HOME/.local/state/hedge/logs/install-timings"
mkdir -p "${install_log%/*}"
printf 'start %s\n' "$(date +%s)" >"$install_log"
ended() { printf '%s %s%s\n' "$1" "$(date +%s)" "${2:+ $2}" >>"$install_log"; }

retry() {
  tries=1
  until "$@"; do
    [ "$tries" -lt 3 ] || return 1
    sleep "$tries"
    tries=$((tries + 1))
  done
}

fetch_once() {
  out=$(curl -fsSL --connect-timeout 20 --speed-limit 1024 --speed-time 60 "$@") && printf '%s' "$out"
}

fetch() { retry fetch_once "$@"; }

download() {
  file=$(mktemp)
  fetch "$1" -o "$file" || fail "could not download $1."
  printf '%s\n' "$file"
}

sha256() {
  sha256sum "$1" | cut -c1-64
}

unzip_to() {
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2"
}

linux_gh() {
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64 ;;
    x86_64|amd64) arch=amd64 ;;
    *) fail "no gh build for $(uname -m). Install gh from https://cli.github.com." ;;
  esac
  latest=$(fetch -I -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest) || fail "could not find the latest gh release."
  version=${latest##*/v}
  name="gh_${version}_linux_${arch}"
  work=$(mktemp -d)
  fetch "https://github.com/cli/cli/releases/download/v$version/$name.tar.gz" -o "$work/gh.tar.gz" || fail "could not download gh."
  fetch "https://github.com/cli/cli/releases/download/v$version/gh_${version}_checksums.txt" -o "$work/sums" || fail "could not download gh checksums."
  (cd "$work" && grep " $name.tar.gz\$" sums | sed "s/$name.tar.gz/gh.tar.gz/" | sha256sum -c --status -) || fail "gh checksum mismatch."
  tar -xzf "$work/gh.tar.gz" -C "$work"
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$work/$name/bin/gh" "$HOME/.local/bin/gh"
  rm -rf "$work"
}

direct_bun() {
  case "$(uname -m)" in
    aarch64|arm64) target=linux-aarch64; sum=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
    x86_64|amd64) target=linux-x64; sum=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c ;;
    *) fail "no Bun build for $(uname -m). Install Bun from https://bun.sh." ;;
  esac
  work=$(mktemp -d)
  fetch "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-$target.zip" -o "$work/bun.zip" || fail "could not download Bun."
  [ "$(sha256 "$work/bun.zip")" = "$sum" ] || fail "Bun checksum mismatch."
  unzip_to "$work/bun.zip" "$work"
  mkdir -p "$HOME/.bun/bin"
  install -m 755 "$work/bun-$target/bun" "$HOME/.bun/bin/bun"
  rm -rf "$work"
}

t3_nightly() {
  feed=$(fetch https://github.com/pingdotgg/t3code/releases.atom) || return 0
  printf '%s\n' "$feed" | sed -n 's|.*/releases/tag/v\([0-9][0-9.]*-nightly\.[0-9]*\.[0-9]*\)".*|\1|p' | head -n 1
}

t3_cli() {
  has t3 && return 0
  installer=$(download https://t3.codes/install.sh)
  version=$(t3_nightly)
  limited=$(mktemp -d)
  quoted=$(command -v curl | sed "s/'/'\\\\''/g")
  printf "#!/bin/sh\nexec '%s' --connect-timeout 20 --speed-limit 1024 --speed-time 60 \"\$@\"\n" "$quoted" >"$limited/curl"
  chmod 755 "$limited/curl"
  installed=
  retry env PATH="$limited:$PATH" T3CODE_CHANNEL=nightly T3CODE_VERSION="$version" sh "$installer" && installed=1
  rm -rf "$limited"
  [ -n "$installed" ] || fail "T3 Code did not install."
}

fetch_engine() {
  if [ -d "$engine_dir" ] && [ ! -d "$engine_dir/.git" ] && [ -n "$(ls -A "$engine_dir")" ]; then
    fail "$engine_dir holds files that are not a Hedge engine. Move them away, or set HEDGE_ENGINE_DIR."
  fi
  mkdir -p "$engine_dir"
  engine_dir=$(CDPATH='' cd -- "$engine_dir" && pwd)
  [ -d "$engine_dir/.git" ] || git -C "$engine_dir" init -q
  [ -z "$(git -C "$engine_dir" status --porcelain)" ] || fail "$engine_dir has local changes. Save them elsewhere and remove them, then run this again."
  if ! origin=$(git -C "$engine_dir" remote get-url origin 2>/dev/null); then
    git -C "$engine_dir" remote add origin "$engine_repo"
  elif [ "$origin" != "$engine_repo" ]; then
    say "The engine now comes from $engine_repo instead of $origin."
    git -C "$engine_dir" remote set-url origin "$engine_repo"
  fi
  git -C "$engine_dir" fetch -q --depth 1 --tags origin "$ref" || fail "could not fetch the engine at $ref from $engine_repo."
  git -C "$engine_dir" checkout -q --force --detach FETCH_HEAD
}

install_packages() {
  log=$(mktemp)
  if ! (cd "$engine_dir" && bun install --frozen-lockfile --production) >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    fail "could not install the engine's packages in $engine_dir."
  fi
  rm -f "$log"
}

ours() {
  ! { [ -e "$1" ] || [ -L "$1" ]; } || [ "$(sed -n 2p "$1" 2>/dev/null)" = "# Hedge" ] || [ "$(sed -n 2p "$1" 2>/dev/null)" = "# Fleet" ]
}

link_command() {
  [ "$1" = hedge ] || [ -e "$bin_dir/$1" ] || return 0
  if ! ours "$bin_dir/$1"; then
    [ "$1" != hedge ] || say "$bin_dir/hedge is not Hedge's, so it stays as it is. Run Hedge with sh $engine_dir/hedge."
    return 0
  fi
  wrapper=$(mktemp "$bin_dir/$1.XXXXXX")
  printf "#!/bin/sh\n# Hedge\nexec sh '%s' \"\$@\"\n" "$quoted" >"$wrapper"
  chmod 755 "$wrapper"
  mv -f "$wrapper" "$bin_dir/$1"
}

link_hedge() {
  bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"
  quoted=$(printf '%s' "$launcher" | sed "s/'/'\\\\''/g")
  link_command hedge
  link_command fleet
}

add_login_line() {
  [ ! -s "$1" ] || [ -z "$(tail -c 1 "$1")" ] || printf '\n' >>"$1"
  printf '%s\n' "$2" >>"$1"
}

login_path() {
  dirs="\$HOME/.local/bin \$HOME/.bun/bin"
  shell=${SHELL:-}
  case "${shell##*/}" in
    zsh) file=.zprofile ;;
    bash) file=.profile; [ ! -f "$HOME/.bash_login" ] || file=.bash_login; [ ! -f "$HOME/.bash_profile" ] || file=.bash_profile ;;
    fish) file=.config/fish/conf.d/hedge.fish ;;
    *) file=.profile ;;
  esac
  if [ "$file" = .config/fish/conf.d/hedge.fish ]; then
    line="fish_add_path --global $dirs"
    [ "$(cat "$HOME/$file" 2>/dev/null)" != "$line" ] || return 0
    mkdir -p "$HOME/.config/fish/conf.d"
    printf '%s\n' "$line" >"$HOME/$file"
  else
    line="export PATH=\"$(printf '%s' "$dirs" | tr ' ' ':'):\$PATH\" # Added by Hedge"
    ! grep -qxF "$line" "$HOME/$file" 2>/dev/null || return 0
    add_login_line "$HOME/$file" "$line"
  fi
  say "Open a new terminal to use hedge. ~/$file now puts ~/.local/bin and ~/.bun/bin on your PATH."
}

[ "$(uname -s)" = Linux ] || fail "Hedge runs on Linux cloud boxes."
for tool in curl git tar sha256sum python3; do has "$tool" || fail "install $tool first."; done
has gh || linux_gh
has bun || direct_bun
ended tools
t3_cli
ended t3
has git || fail "git is missing."
fetch_engine
ended engine
install_packages
ended packages
launcher="$engine_dir/hedge"
[ -e "$launcher" ] || launcher="$engine_dir/fleet"
link_hedge
login_path
say "Engine ready at $ref in $engine_dir."

machine="$HOME/.config/hedge/machine.json"
pending="$HOME/.local/state/hedge/fleet-apply-pending"
renamed=
[ "${launcher##*/}" != hedge ] || [ -n "$preview" ] || renamed=1
if [ -n "$renamed" ]; then
  sh "$launcher" retire-fleet || fail "Fleet may still run, so Hedge copied and applied nothing. Stop each piece named above by hand, then run get.sh again."
  [ -e "$machine" ] || : >"$pending"
  sh "$launcher" import-fleet || fail "could not copy the setup from before the rename."
  grep -q '"profileDir"' "$machine" 2>/dev/null || rm -f "$pending"
fi

[ -z "$install_only" ] || exit 0

if [ -n "$preview" ]; then
  say "This is a preview, so Hedge did not copy or stop the setup from before the rename. Without --dry-run, get.sh stops each piece of Fleet named below before it applies."
  if [ "${launcher##*/}" != hedge ]; then :
  elif grep -qF 'retire-fleet [--dry-run]' "$engine_dir/src/cli.ts"; then sh "$launcher" retire-fleet --dry-run || exit $?
  else say "The engine at $ref cannot list Fleet without stopping it, so this preview does not name what still runs."
  fi
  if [ -z "$profile" ]; then
    say "A preview without --profile runs no setup. Run get.sh without --dry-run to set up, or add --profile <dir> to preview the apply."
    exit 0
  fi
fi
if [ -n "$profile" ]; then
  sh "$launcher" apply --profile "$profile" "$@" || exit $?
  [ -n "$preview" ] || rm -f "$pending"
  exit 0
fi
if [ -e "$pending" ] && [ $# -eq 0 ]; then
  sh "$launcher" apply || exit $?
  rm -f "$pending"
  exit 0
fi
if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
  exec sh "$launcher" setup "$@" </dev/tty
fi
exec sh "$launcher" setup "$@"
