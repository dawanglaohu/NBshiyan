#!/usr/bin/env bash
# Tests for the build-args checks of deploy/build-offbox.sh (run: bash deploy/tests/build-offbox.test.sh). No docker or
# network: git is replaced by a stub that fails, so a file that passes step 1 stops at the clone ("fresh clone … failed").
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); S="$here/../build-offbox.sh"; pass=0; fail=0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; mkdir -p "$T/bin"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/git"; chmod 755 "$T/bin/git"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/zstd"; chmod 755 "$T/bin/zstd"
KEY=0x4AAAAAAATestSiteKey0123
run() {  # run <name> <file content (printf format, %s = key)> <regex>
  local f="$T/ba.env" out rc
  # shellcheck disable=SC2059  # the content is the format on purpose
  printf "$2" "$KEY" > "$f"; chmod 600 "$f"
  out=$(PATH="$T/bin:$PATH" PIN_SHA=$(printf 'a%.0s' {1..40}) PLATFORM=linux/amd64 BUILD_ARGS_FILE="$f" OUT_DIR="$T/out" bash "$S" 2>&1); rc=$?
  if [ "$rc" = 1 ] && grep -qE "$3" <<<"$out" && ! grep -qF -- "$KEY" <<<"$out"; then pass=$((pass+1)); echo "PASS $1"
  else fail=$((fail+1)); echo "FAIL $1 (exit $rc)"; printf '    | %s\n' "$out"; fi
}
run good_server_file        'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\n'                        'ABORT: fresh clone of a{12} failed'
run double_quoted           'NEXT_PUBLIC_TURNSTILE_SITE_KEY="%s"\n'                      'ABORT: build-args: NEXT_PUBLIC_TURNSTILE_SITE_KEY must be unquoted, LF only'
run single_quoted           "NEXT_PUBLIC_TURNSTILE_SITE_KEY='%s'\n"                      'ABORT: build-args: NEXT_PUBLIC_TURNSTILE_SITE_KEY must be unquoted, LF only'
run crlf                    'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\r\n'                      'ABORT: build-args: NEXT_PUBLIC_TURNSTILE_SITE_KEY must be unquoted, LF only'
run crlf_other_key          'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\nSANITY_DATASET=production\r\n' 'ABORT: build-args: SANITY_DATASET must be unquoted, LF only'
run not_allowed             'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\nAUTH_SECRET=x\n'         'ABORT: build-args: key AUTH_SECRET is not an allowed PUBLIC build arg'
run missing_site_key        'SANITY_DATASET=production\n%.0s'                            'ABORT: build-args: NEXT_PUBLIC_TURNSTILE_SITE_KEY missing'
run app_env_conflict        'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\nAPP_ENV=development\n'   'ABORT: build-args: APP_ENV must be production'
run site_url_conflict       'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\nNEXT_PUBLIC_SITE_URL=https://geiom.com/\n' 'ABORT: build-args: NEXT_PUBLIC_SITE_URL must be exactly'
run forced_values_ok        'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\nAPP_ENV=production\nNEXT_PUBLIC_SITE_URL=https://geiom.com\n' 'ABORT: fresh clone of a{12} failed'
run test_site_key           'NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA\n%.0s' 'ABORT: build-args: NEXT_PUBLIC_TURNSTILE_SITE_KEY is a Cloudflare test key'
secret_env_denied() {
  local name="$1" f="$T/secret-guard.env" out rc value='synthetic-webhook-guard-value'
  printf 'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\n' "$KEY" > "$f"; chmod 600 "$f"
  out=$(env -i PATH="$T/bin:$PATH" "$name=$value" PIN_SHA=$(printf 'a%.0s' {1..40}) PLATFORM=linux/amd64 BUILD_ARGS_FILE="$f" OUT_DIR="$T/out" bash "$S" 2>&1); rc=$?
  if [ "$rc" = 1 ] && grep -qF "production secret variable is set in this shell: $name" <<<"$out" && ! grep -qF "$value" <<<"$out"; then
    pass=$((pass+1)); echo "PASS secret_env_$name"
  else
    fail=$((fail+1)); echo "FAIL secret_env_$name (exit $rc)"; printf '    | %s\n' "$out"
  fi
}
secret_env_denied SANITY_WEBHOOK_SECRET
secret_env_denied SANITY_REVALIDATE_SECRET

if grep -q '^SANITY_WEBHOOK_SECRET=$' "$here/../env.template" &&
   ! grep -q '^SANITY_REVALIDATE_SECRET=' "$here/../env.template" &&
   ! grep -q 'SANITY_WEBHOOK_SECRET.*not a variable' "$here/../env.template"; then
  pass=$((pass+1)); echo 'PASS webhook_runtime_catalog'
else
  fail=$((fail+1)); echo 'FAIL webhook_runtime_catalog'
fi

echo "build-offbox: $pass passed, $fail failed"; [ "$fail" = 0 ]
