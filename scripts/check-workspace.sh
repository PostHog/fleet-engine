#!/bin/sh
set -eu

[ $# -ge 1 ] || { echo "usage: check-workspace.sh <workspace> [<parameter>=<value>]... with no private value" >&2; exit 2; }
name=$1
shift
command -v perl >/dev/null 2>&1 || { echo "check-workspace.sh needs perl." >&2; exit 2; }

json() {
  script=$1
  shift
  perl -CAO -MJSON::PP -e "$script" -- "$@"
}

workspace=$(coder list -o json --search "owner:me name:$name") || { echo "coder list failed. Sign in with coder login first." >&2; exit 1; }
fields=$(printf '%s' "$workspace" | NAME=$name json '
  my ($found) = grep { $_->{name} eq $ENV{NAME} } @{ decode_json(join "", <STDIN>) };
  exit 3 unless $found;
  my $build = $found->{latest_build};
  my $deadline = $build->{deadline} // "";
  $deadline = "" if $deadline =~ /^0001-/;
  print join(" ", $build->{id}, $build->{template_version_id}, $build->{transition}, $build->{status}, $deadline || "-", defined $found->{ttl_ms} ? "scheduled" : "manual"), "\n";
') || { echo "No workspace named $name." >&2; exit 1; }
read -r build version transition state deadline schedule <<FIELDS
$fields
FIELDS
case $state in pending | starting | stopping | canceling | deleting)
  echo "x $name is not ready: its latest build is a $transition that is $state. Wait until it ends, then run this check again."
  exit 1 ;;
esac
url=$(coder whoami -o json | json 'my $me = decode_json(join "", <STDIN>); $me = $me->[0] if ref $me eq "ARRAY"; print $me->{url}')

token() { if [ -n "${CODER_SESSION_TOKEN:-}" ]; then printf '%s\n' "$CODER_SESSION_TOKEN"; else coder login token; fi; }
api() { { printf 'Coder-Session-Token: '; token; } | curl -q -fsS -H @- "$url/api/v2/$1"; }

parameters=$(api "workspacebuilds/$build/parameters") || { echo "Coder did not return the parameters of the build of $name." >&2; exit 1; }
template=$(api "templateversions/$version/rich-parameters") || { echo "Coder did not return the parameters of the template of $name." >&2; exit 1; }

restart="From this Mac, run: coder restart $name --parameter"
status=0
printf '%s' "$parameters" | TEMPLATE=$template RESTART=$restart json '
  my %got = map { $_->{name} => $_->{value} } @{ decode_json(join "", <STDIN>) };
  my %mutable = map { $_->{name} => $_->{mutable} } @{ decode_json($ENV{TEMPLATE}) };
  my $bad = 0;
  for my $pair (@ARGV) {
    my ($key, $value) = split /=/, $pair, 2;
    if (!exists $got{$key}) { print "x $key is not a parameter of this build.\n"; $bad = 1 }
    elsif ($got{$key} eq $value) { print "ok $key\n" }
    elsif ($mutable{$key}) { print "x $key is not the value you passed. $ENV{RESTART} $key=<value> --yes\n"; $bad = 1 }
    else { print "x $key is not the value you passed, and the template does not let it change. Delete the workspace and create it again before setup.\n"; $bad = 1 }
  }
  exit $bad;
' "$@" || status=1

if [ "$transition $state" != "start running" ]; then
  echo "x $name does not run: its latest build is a $transition that is $state. $restart <parameter>=<value> --yes, with each parameter you passed, and check again."
  status=1
elif [ "$schedule" = scheduled ]; then
  echo "x $name has a stop schedule. Run: coder schedule stop $name manual"
  status=1
elif [ "$deadline" != - ]; then
  echo "x $name still stops at $deadline. Run coder schedule stop $name manual again. When the time stays, the template sets it: ask the Coder admin, and run coder schedule extend $name <hours>h before then."
  status=1
else
  echo "ok $name runs and stays on"
fi
exit "$status"
