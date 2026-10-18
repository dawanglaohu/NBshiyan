#!/usr/bin/env bash
# App env file / compose checks for deploy.sh (pure functions, no network, never prints values).
# Sourced by deploy.sh and deploy/tests/env-check.test.sh. Needs: ENVF, COMPOSE_FILE, log().

# compose_hostname_ok <compose file> → 0 only when the `app` service sets HOSTNAME exactly once, to 0.0.0.0.
# Compose `environment:` wins over env_file, so this is what the container really gets. With HOSTNAME=127.0.0.1 the
# /s/* rewrite leaks localhost in the x-middleware-rewrite response header (and Next emits absolute localhost Locations).
compose_hostname_ok() {
  awk '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_app = ($1 == "app:") ; next }
    /^[^[:space:]#]/                  { in_app = 0 }
    in_app && /^[[:space:]]+-?[[:space:]]*"?HOSTNAME[:=]/ {
      n++
      if ($0 ~ /^      HOSTNAME:[[:space:]]+("0\.0\.0\.0"|0\.0\.0\.0)[[:space:]]*(#.*)?$/) ok++
    }
    END { exit !(n == 1 && ok == 1) }
  ' "$1" 2>/dev/null
}

# APP_ENV and NODE_ENV must each appear exactly once in the env file, as "production". Only those lines are read.
env_prod_ok() {
  local k n
  for k in APP_ENV NODE_ENV; do
    if [ "$(grep -c "^$k=" "$ENVF" || true)" != 1 ] || ! grep -qx "$k=production" "$ENVF"; then
      log "FAIL $k must be exactly 'production' (once) in the app env file"; return 1
    fi
  done
  # APP_ORIGIN: standalone sees its own URL as http://0.0.0.0:3000, so admin same-origin checks (assertSameOrigin)
  # reject every real POST with 403 unless APP_ORIGIN is the public origin.
  if [ "$(grep -c '^APP_ORIGIN=' "$ENVF" || true)" != 1 ] || ! grep -qx 'APP_ORIGIN=https://geiom.com' "$ENVF"; then
    log "FAIL APP_ORIGIN must be exactly 'https://geiom.com' (once) in the app env file"; return 1
  fi
  # ...and must equal the NEXT_PUBLIC_SITE_URL origin in the same file (backend's startup check exits 1 otherwise).
  if [ "$(grep -c '^NEXT_PUBLIC_SITE_URL=' "$ENVF" || true)" != 1 ] || ! grep -qx 'NEXT_PUBLIC_SITE_URL=https://geiom.com' "$ENVF"; then
    log "FAIL NEXT_PUBLIC_SITE_URL must be exactly 'https://geiom.com' (once) so it matches APP_ORIGIN"; return 1
  fi
  # HOSTNAME: effective value must be 0.0.0.0. Compose hardcodes it (and wins); the env file may omit it, but if it sets
  # HOSTNAME at all it must be exactly once and exactly 0.0.0.0 — anything else is a misconfiguration waiting to bite.
  n=$(grep -cE '^[[:space:]]*(export[[:space:]]+)?HOSTNAME[[:space:]]*=' "$ENVF" || true)
  if [ "$n" != 0 ] && { [ "$n" != 1 ] || ! grep -qx 'HOSTNAME=0.0.0.0' "$ENVF"; }; then
    log "FAIL HOSTNAME in the app env file must be absent or exactly '0.0.0.0' (once)"; return 1
  fi
  compose_hostname_ok "$COMPOSE_FILE" || { log "FAIL compose app service must set HOSTNAME: \"0.0.0.0\" exactly once"; return 1; }
}
