#!/usr/bin/env bash
# Tests for deploy/smoke-lib.sh. Run: bash deploy/tests/smoke.test.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/smoke-lib.sh
. "$here/../smoke-lib.sh"
pass=0; fail=0
t() { if "$@"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $*"; fi; }
bad()  { loc_bad "$1"; }
good() { ! loc_bad "$1"; }
not()  { ! "$@"; }
# --- bad Locations ---
t bad '//evil.com/'
t bad '/\evil.com'
t bad '\/evil.com'
t bad '\\evil.com'
t bad '\evil.com'
t bad 'https://evil.com/'
t bad 'http://evil.com'
t bad 'evil.com'
t bad '//geiom.com.evil.com/'
# --- good Locations ---
t good '/en'
t good 'https://geiom.com/en'
t good '/evil.com/'          # same-site relative path (what Next returns for //evil.com/ → /evil.com/)
t good '/evil.com'
t good '/ru'
t good ''                    # no Location (e.g. 200/404)
# --- status / Location parsing ---
r=$'HTTP/1.1 307 Temporary Redirect\r\nlocation: /en\r\nx: y\r\n'
t [ "$(resp_code "$r")" = 307 ]
t [ "$(resp_loc "$r")" = /en ]
t [ "$(resp_code $'HTTP/2 500 \r\n')" = 500 ]
# --- root redirect rule ---
t root_redirect_ok 307 /en app
t root_redirect_ok 308 /en app
t root_redirect_ok 307 https://geiom.com/en public
t root_redirect_ok 307 /en public
t not root_redirect_ok 307 https://geiom.com/en app
t not root_redirect_ok 200 /en app
t not root_redirect_ok 307 https://localhost:3000/en public
t not root_redirect_ok 307 /en/ app
echo "smoke: $pass passed, $fail failed"; (( fail == 0 ))
