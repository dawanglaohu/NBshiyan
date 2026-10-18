#!/usr/bin/env bash
# Tests for deploy/env-check.sh (env_prod_ok, compose_hostname_ok). Run: bash deploy/tests/env-check.test.sh
# Uses only fake, non-secret env files in a private temp dir.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/env-check.sh
. "$here/../env-check.sh"
log() { :; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; chmod 700 "$tmp"
ENVF="$tmp/app.env"; COMPOSE_FILE="$here/../docker-compose.yml"
pass=0; fail=0
t() { if "$@"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $*"; fi; }
not() { ! "$@"; }
BASE=$'APP_ENV=production\nNODE_ENV=production\nAPP_ORIGIN=https://geiom.com\nNEXT_PUBLIC_SITE_URL=https://geiom.com\nSMTP_PORT=465'
envf() { printf '%s\n' "$@" > "$ENVF"; }
ok()  { envf "$@"; env_prod_ok; }
bad() { envf "$@"; ! env_prod_ok; }
# --- baseline (real compose file) ---
t ok "$BASE"
t compose_hostname_ok "$COMPOSE_FILE"
# --- APP_ENV / NODE_ENV ---
t bad "${BASE/APP_ENV=production/APP_ENV=staging}"
t bad "${BASE/NODE_ENV=production/}"
t bad "$BASE" 'APP_ENV=production'
t bad "${BASE/APP_ENV=production/APP_ENV=production }"
# --- APP_ORIGIN / NEXT_PUBLIC_SITE_URL ---
t bad "${BASE/APP_ORIGIN=https:\/\/geiom.com/}"
t bad "${BASE/APP_ORIGIN=https:\/\/geiom.com/APP_ORIGIN=http://geiom.com}"
t bad "${BASE/APP_ORIGIN=https:\/\/geiom.com/APP_ORIGIN=https://geiom.com/}"
t bad "$BASE" 'APP_ORIGIN=https://geiom.com'
t bad "${BASE/NEXT_PUBLIC_SITE_URL=https:\/\/geiom.com/NEXT_PUBLIC_SITE_URL=https://www.geiom.com}"
t bad "${BASE/NEXT_PUBLIC_SITE_URL=https:\/\/geiom.com/}"
# --- HOSTNAME in the env file: absent or exactly 0.0.0.0 once ---
t ok  "$BASE" 'HOSTNAME=0.0.0.0'
t bad "$BASE" 'HOSTNAME=127.0.0.1'
t bad "$BASE" 'HOSTNAME=localhost'
t bad "$BASE" 'HOSTNAME='
t bad "$BASE" 'HOSTNAME="0.0.0.0"'
t bad "$BASE" 'HOSTNAME=0.0.0.0 '
t bad "$BASE" 'HOSTNAME=::'
t bad "$BASE" 'HOSTNAME=0.0.0.0' 'HOSTNAME=0.0.0.0'
t bad "$BASE" 'HOSTNAME=0.0.0.0' 'HOSTNAME=127.0.0.1'
t bad "$BASE" ' HOSTNAME=127.0.0.1'
t bad "$BASE" 'export HOSTNAME=127.0.0.1'
t ok  "$BASE" '# HOSTNAME=127.0.0.1'
t ok  "$BASE" 'MY_HOSTNAME=whatever'
# --- compose: app service must hardcode HOSTNAME 0.0.0.0 exactly once ---
mk() { sed "$1" "$here/../docker-compose.yml" > "$tmp/c.yml"; COMPOSE_FILE="$tmp/c.yml"; }
envf "$BASE"
mk 's/HOSTNAME: "0.0.0.0"/HOSTNAME: 0.0.0.0/';                         t env_prod_ok
mk 's/HOSTNAME: "0.0.0.0"/HOSTNAME: "127.0.0.1"/';                     t not env_prod_ok
mk 's/HOSTNAME: "0.0.0.0"/HOSTNAME: localhost/';                       t not env_prod_ok
mk '/HOSTNAME: "0.0.0.0"/d';                                           t not env_prod_ok
mk 's/^\(      HOSTNAME: "0.0.0.0".*\)$/\1\n      HOSTNAME: "127.0.0.1"/'; t not env_prod_ok
mk 's/^      HOSTNAME: "0.0.0.0"/      # HOSTNAME: "0.0.0.0"/';      t not env_prod_ok
# HOSTNAME only on another service does not count
mk '/^      HOSTNAME: "0.0.0.0"/d; s/^\(  postgres:\)$/\1\n    environment:\n      HOSTNAME: "0.0.0.0"/'; t not env_prod_ok
# list syntax under app is not accepted (must be the map form, checked exactly)
mk 's/^      HOSTNAME: "0.0.0.0".*$/      - HOSTNAME=127.0.0.1/';      t not env_prod_ok
COMPOSE_FILE="$tmp/missing.yml";                                       t not env_prod_ok
COMPOSE_FILE="$here/../docker-compose.yml"
echo "env-check: $pass passed, $fail failed"; (( fail == 0 ))
