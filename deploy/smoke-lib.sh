#!/usr/bin/env bash
# Redirect / header smoke helpers. Sourced by deploy.sh and deploy/tests/smoke.test.sh (pure functions, no network).

# loc_bad <Location value> → 0 (bad) unless the Location provably stays on https://geiom.com. Allow-list, fail closed:
#   ok:  empty (no Location), a same-site path `/x…` (second char not / or \, or just `/`),
#        or `https://geiom.com` optionally followed by such a path.
#   bad: everything else — any backslash, any whitespace/control char (browsers strip tab/CR/LF: "/\t/evil.com" → "//evil.com"),
#        `//` or `/\` prefixes (also after https://geiom.com), other schemes/hosts/ports, userinfo, bare hosts, relative paths.
loc_bad() {
  local loc="$1"
  [ -z "$loc" ] && return 1
  [[ "$loc" == *\\* || "$loc" =~ [[:space:][:cntrl:]] ]] && return 0
  if [[ "$loc" =~ ^https://geiom\.com(/.*)?$ ]]; then loc="${loc#https://geiom.com}"; [ -z "$loc" ] && return 1; fi
  [[ "$loc" =~ ^/([^/]|$) ]] && return 1
  return 0
}

# hdr_leak <raw curl -sI output> → 0 when any response header mentions the internal origin
#   (localhost, 127.0.0.1, 0.0.0.0), e.g. x-middleware-rewrite: http://localhost:3000/... when HOSTNAME=127.0.0.1.
hdr_leak() { grep -qiE 'localhost|(^|[^0-9])127\.0\.0\.1|(^|[^0-9])0\.0\.0\.0' <<<"$1"; }

# robots_noindex <raw curl -sI output> → 0 when an x-robots-tag header carries noindex
robots_noindex() { grep -qiE '^x-robots-tag:.*noindex' <<<"$1"; }
# canonical_ok <html> → 0 when the page has the production canonical for /en. Takes the body as a value: never
#   `curl | grep -q` (pages > 64 KB: grep -q exits early, curl gets SIGPIPE, pipefail turns a match into a FAIL).
canonical_ok() { grep -qF '<link rel="canonical" href="https://geiom.com/en"' <<<"$1"; }

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
