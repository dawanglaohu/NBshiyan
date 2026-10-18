#!/usr/bin/env bash
# Tests for deploy/mem-check.sh (run: bash deploy/tests/mem-check.test.sh). No docker needed: svc_running / mem_avail_mb
# are replaced after sourcing.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); C="$here/../docker-compose.yml"; pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $*"; }
log() { printf '%s\n' "$*"; }
# shellcheck source=deploy/mem-check.sh
. "$here/../mem-check.sh"
RUNNING=""; AVAIL=0
svc_running() { [[ " $RUNNING " == *" $1 "* ]]; }
mem_avail_mb() { echo "$AVAIL"; }
eq() { if [ "$1" = "$2" ]; then ok; else bad "$3: got '$1', want '$2'"; fi; }
# limits from the real compose file
eq "$(mem_limit_mb "$C" app)" 768 "app limit"; eq "$(mem_limit_mb "$C" postgres)" 384 "postgres limit"
eq "$(mem_limit_mb "$C" srh-tls)" 32 "srh-tls limit"; eq "$(mem_limit_mb "$C" migrate)" 384 "migrate limit"
if mem_limit_mb "$C" nosuch >/dev/null 2>&1; then bad "unknown service must fail"; else ok; fi
# cold start: 384+96+192+32+768 + 256 reserve
RUNNING=""; eq "$(mem_need_mb "$C")" 1728 "cold need"
# today's server state: postgres redis srh up, srh-tls exited, no app → 32+768+256
RUNNING="postgres redis srh"; eq "$(mem_need_mb "$C")" 1056 "partial need"
# redeploy: everything up → only migrate next to the running app + reserve
RUNNING="postgres redis srh srh-tls app"; eq "$(mem_need_mb "$C")" 640 "redeploy need"
RUNNING=""; AVAIL=1727; out=$(mem_ok "$C"); rc=$?; eq "$rc" 1 "cold, 1 MiB short → FAIL"; if grep -q '^FAIL memory' <<<"$out"; then ok; else bad "no FAIL line"; fi
AVAIL=1728; out=$(mem_ok "$C"); rc=$?; eq "$rc" 0 "cold, exact → PASS"; if grep -q '^PASS memory' <<<"$out"; then ok; else bad "no PASS line"; fi
AVAIL=abc; out=$(mem_ok "$C"); rc=$?; eq "$rc" 1 "unreadable MemAvailable → FAIL"
T=$(mktemp); trap 'rm -f "$T"' EXIT; printf 'services:\n  app:\n    image: x\n  postgres:\n    mem_limit: 1g\n' > "$T"
AVAIL=99999; out=$(mem_ok "$T"); rc=$?; eq "$rc" 1 "compose without app mem_limit → FAIL (fail closed)"
printf 'services:\n  app:\n    mem_limit: 1g\n  postgres:\n    mem_limit: 512m\n  redis:\n    mem_limit: 64m\n  srh:\n    mem_limit: 64m\n  srh-tls:\n    mem_limit: 32m\n  migrate:\n    mem_limit: 256m\n' > "$T"
RUNNING=""; eq "$(mem_need_mb "$T")" $((1024+512+64+64+32+256)) "g / m units"
# deploy.sh calls mem_ok before anything is started
d="$here/../deploy.sh"
# shellcheck disable=SC2016  # literal $COMPOSE_FILE in deploy.sh
ln_mem=$(grep -n 'mem_ok "\$COMPOSE_FILE"' "$d" | cut -d: -f1); ln_up=$(grep -n 'dc up -d --wait postgres' "$d" | cut -d: -f1); ln_cenv=$(grep -n '^    write_cenv candidate' "$d" | cut -d: -f1)
if [ -n "$ln_mem" ] && [ -n "$ln_up" ] && (( ln_mem < ln_cenv && ln_cenv < ln_up )); then ok; else bad "deploy.sh must call mem_ok before write_cenv / dc up"; fi
echo "mem-check: $pass passed, $fail failed"; [ "$fail" = 0 ]
