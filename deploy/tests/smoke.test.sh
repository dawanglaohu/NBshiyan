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
# --- allow-list: anything not provably on https://geiom.com is bad ---
t bad 'https://attacker.net/'
t bad 'https://geiom.com.evil.com/'
t bad 'https://geiom.com@evil.com/'
t bad 'https://geiom.com:8443/en'
t bad 'https://geiom.comevil.com'
t bad 'http://geiom.com/en'
t bad 'https://geiom.com//evil.com'
t bad 'https://geiom.com/\evil.com'
t bad 'https://geiom.com\evil.com'
t bad '//geiom.com/en'
t bad '/en\evil'
t bad $'/\t/evil.com'
t bad $'/\n/evil.com'
t bad '/ /evil.com'
t bad 'javascript:alert(1)'
t bad 'en'
t bad 'http://localhost:3000/en'
t bad 'http://0.0.0.0:3000/en'
# --- backend #328 expected Locations (// and /\ probes → 308 on-site), relative or absolute geiom.com ---
t good '/'
t good 'https://geiom.com'
t good 'https://geiom.com/'
t good 'https://geiom.com/evil.com'
t good 'https://geiom.com/evil.com/'
t good '/en/products?x=1'
t good '/%2F%2Fevil.com'      # encoded slashes in a path stay on site
# --- header leak scan (x-middleware-rewrite included) ---
leak() { hdr_leak "$1"; }
t leak $'HTTP/1.1 200 OK\r\nx-middleware-rewrite: http://localhost:3000/s/abc\r\n'
t leak $'HTTP/1.1 200 OK\r\nx-middleware-rewrite: http://127.0.0.1:3000/s/abc\r\n'
t leak $'HTTP/1.1 307 Temporary Redirect\r\nlocation: http://0.0.0.0:3000/en\r\n'
t leak $'HTTP/1.1 200 OK\r\nX-Foo: LOCALHOST\r\n'
t not leak $'HTTP/1.1 200 OK\r\nx-middleware-rewrite: /s/abc\r\ncontent-type: text/html\r\n'
t not leak $'HTTP/1.1 308 Permanent Redirect\r\nlocation: /evil.com/\r\n'
t not leak $'HTTP/1.1 200 OK\r\nx-version: 10.0.0.0\r\n'
# --- status / Location parsing ---
r=$'HTTP/1.1 307 Temporary Redirect\r\nlocation: /en\r\nx: y\r\n'
t [ "$(resp_code "$r")" = 307 ]
t [ "$(resp_loc "$r")" = /en ]
t [ "$(resp_code $'HTTP/2 500 \r\n')" = 500 ]
r=$'HTTP/1.1 308 Permanent Redirect\r\nLocation: /evil.com/\r\n'
t [ "$(resp_code "$r")" = 308 ]
t good "$(resp_loc "$r")"
r=$'HTTP/1.1 404 Not Found\r\ncontent-type: text/html\r\n'
t [ "$(resp_code "$r")" = 404 ]
t [ -z "$(resp_loc "$r")" ]
t good "$(resp_loc "$r")" 
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
