#!/usr/bin/env bash
# Redirect / header smoke helpers. Sourced by deploy.sh and deploy/tests/smoke.test.sh (pure functions, no network).

# loc_bad <Location value> → 0 (bad) when the Location could leave the site:
#   starts with two slashes/backslashes in any mix (// /\ \/ \\), starts with a backslash,
#   or mentions evil.com without being a plain same-site relative path (/x…, second char not / or \).
loc_bad() {
  local loc="$1"
  [[ "$loc" =~ ^[/\\][/\\] || "$loc" == \\* || ( "$loc" == *evil.com* && ! "$loc" =~ ^/[^/\\] ) ]]
}

# resp_code <raw curl -sI output> → HTTP status code of the first status line
resp_code() { sed -n '1s/^HTTP\/[0-9.]*[[:space:]]\{1,\}\([0-9]\{3\}\).*/\1/p' <<<"$1" | tr -d '\r'; }
# resp_loc <raw curl -sI output> → Location header value (CR stripped)
resp_loc() { tr -d '\r' <<<"$1" | sed -n 's/^[Ll]ocation:[[:space:]]*//p' | head -n 1; }
# root_redirect_ok <code> <loc> <mode>   mode=app: exactly relative /en;  mode=public: /en or https://geiom.com/en
root_redirect_ok() {
  [[ "$1" =~ ^3[0-9][0-9]$ ]] || return 1
  case "$3" in
    app)    [ "$2" = /en ] ;;
    public) [ "$2" = /en ] || [ "$2" = https://geiom.com/en ] ;;
    *)      return 1 ;;
  esac
}
