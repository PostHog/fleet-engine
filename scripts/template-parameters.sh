#!/bin/sh
# shellcheck disable=SC2016
set -eu

[ $# -eq 1 ] || { echo "usage: template-parameters.sh <template>" >&2; exit 2; }
template=$1
command -v perl >/dev/null 2>&1 || { echo "template-parameters.sh needs perl." >&2; exit 2; }

json() {
  script=$1
  shift
  perl -CAO -MJSON::PP -e "$script" -- "$@"
}

templates=$(coder templates list -o json) || { echo "coder templates list failed. Sign in with coder login first." >&2; exit 1; }
version=$(printf '%s' "$templates" | NAME=$template json '
  for my $entry (@{ decode_json(join "", <STDIN>) }) {
    my $found = $entry->{Template} // $entry;
    next unless $found->{name} eq $ENV{NAME};
    print $found->{active_version_id};
    exit 0;
  }
  exit 3;
') || { echo "No template named $template." >&2; exit 1; }
url=$(coder whoami -o json | json 'my $me = decode_json(join "", <STDIN>); $me = $me->[0] if ref $me eq "ARRAY"; print $me->{url}')

token() { if [ -n "${CODER_SESSION_TOKEN:-}" ]; then printf '%s\n' "$CODER_SESSION_TOKEN"; else coder login token; fi; }
parameters=$({ printf 'Coder-Session-Token: '; token; } | curl -q -fsS -H @- "$url/api/v2/templateversions/$version/rich-parameters") || { echo "Coder did not return the parameters of $template." >&2; exit 1; }

printf '%s' "$parameters" | json '
  my $secret = qr/token|secret|passw|credential|api[_ -]?key|private[_ -]?key|\bkey\b|auth|cookie|session|\bpat\b/i;
  for my $parameter (@{ decode_json(join "", <STDIN>) }) {
    my $words = join " ", map { $_ // "" } @{$parameter}{qw(name display_name description description_plaintext)};
    my $hidden = $words =~ $secret || ($parameter->{styling} && $parameter->{styling}{mask_input}) || ($parameter->{form_type} // "") eq "password";
    my @facts = ($parameter->{type} // "string");
    push @facts, "mutable" if $parameter->{mutable};
    push @facts, "ephemeral" if $parameter->{ephemeral};
    push @facts, "secret" if $hidden;
    my $default = $parameter->{default_value} // "";
    if ($parameter->{required} || $default eq "") { push @facts, "no default" }
    elsif ($hidden) { push @facts, "has a default" }
    else { $default =~ s/\n/\\n/g; push @facts, "default $default" }
    my @options = map { $_->{value} } @{ $parameter->{options} // [] };
    push @facts, "options " . join(" | ", @options) if @options && !$hidden;
    my $shown = $parameter->{display_name} && $parameter->{display_name} ne $parameter->{name} ? " ($parameter->{display_name})" : "";
    print "$parameter->{name}$shown: ", join(", ", @facts), "\n";
  }
'
