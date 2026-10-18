#!/usr/bin/env bash
# Regression guard for deploy/*.sh (run: bash deploy/tests/pipefail-lint.test.sh).
# 1. No `producer | grep -q…` in code: under pipefail, grep -q exits on the first match, the producer gets SIGPIPE and the
#    pipeline returns non-zero (a match reads as "no match"). Capture into a variable and use `grep -q … <<<"$var"`.
# 2. canonical_ok / robots_noindex (smoke-lib.sh) on a > 64 KB page with the canonical in <head>, under the real options.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); pass=0; fail=0
ok()  { pass=$((pass+1)); }
want() { if grep -qx "$1" <<<"$out"; then ok; else bad "$2"; fi; }
bad() { fail=$((fail+1)); echo "FAIL: $*"; }
# --- 1. lint (comment lines ignored; a pipe into grep whose options contain q, in any position) ---
hits=$(grep -nHE '\|[[:space:]]*grep([[:space:]]+-[A-Za-z]+)*[[:space:]]+-[A-Za-z]*q' "$here"/../*.sh | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
if [ -z "$hits" ]; then ok; else bad "pipe into grep -q (SIGPIPE under pipefail):"; printf '  %s\n' "$hits"; fi
# the lint itself must catch the known-bad forms
for s in 'curl -s x | grep -q y' 'ss | awk 1 | grep -vqE z' 'docker history i | grep -Eiq k' 'dc ps | grep -i -q a'; do
  if grep -qE '\|[[:space:]]*grep([[:space:]]+-[A-Za-z]+)*[[:space:]]+-[A-Za-z]*q' <<<"$s"; then ok; else bad "lint misses: $s"; fi
done
# shellcheck disable=SC2016  # literal sample line, must not expand
hs='grep -q y <<<"$v"'
if grep -qE '\|[[:space:]]*grep([[:space:]]+-[A-Za-z]+)*[[:space:]]+-[A-Za-z]*q' <<<"$hs"; then bad "lint flags a here-string"; else ok; fi
# --- 2. big page under the deploy.sh shell options ---
out=$(bash -c '
  set -Eeuo pipefail
  . "$1/../smoke-lib.sh"
  pad=$(yes "<p>filler line</p>" | head -c 2000000 || true)
  page="<html><head><link rel=\"canonical\" href=\"https://geiom.com/en\"></head><body>$pad</body></html>"
  wrong="<html><head><link rel=\"canonical\" href=\"https://example.com/en\"></head><body>$pad</body></html>"
  r=0
  for _ in $(seq 1 20); do canonical_ok "$page" || r=1; done; echo "big_ok=$r"
  canonical_ok "$wrong" && echo wrong_ok=1 || echo wrong_ok=0
  # demonstrate the old form fails under pipefail (documentation of the bug; not required to fail on every kernel)
  f=$(mktemp); printf "%s" "$page" > "$f"
  n=0; for _ in $(seq 1 20); do cat "$f" | grep -q "rel=\"canonical\"" || n=$((n+1)); done; rm -f "$f"; echo "old_false_fail=$n/20"
  robots_noindex $'"'"'HTTP/1.1 200 OK\r\nx-robots-tag: noindex\r\n'"'"' && echo noidx=1 || echo noidx=0
  robots_noindex $'"'"'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n'"'"' && echo clean=1 || echo clean=0
' _ "$here")
want 'big_ok=0' "canonical_ok misses the canonical on a 2 MB page"
want 'wrong_ok=0' "canonical_ok accepts a wrong canonical"
want 'noidx=1' "robots_noindex misses noindex"
want 'clean=0' "robots_noindex flags a clean header"
echo "info: $(grep old_false_fail <<<"$out")"
echo "pipefail-lint: $pass passed, $fail failed"; [ "$fail" = 0 ]
