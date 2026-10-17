#!/usr/bin/env bash
# Promote the :candidate images built by build-on-server.sh. DRAFT (plan §11 v1.6).
#   deploy.sh up        pg_dump → schema plan (destructive check) → prisma db push → drift check (--exit-code) → start → checks
#                       auto-rollback of the app on failed checks. prisma/sql/*.sql (incl. 74-mail-backend.sql) is never executed.
#   APPROVED_PLAN_SHA256=<sha256 of the reviewed plan file> deploy.sh up   continue past the review gate for exactly that plan
#   deploy.sh rollback  switch back to :previous (no schema rollback; schema changes are additive-only)
set -Eeuo pipefail; umask 077
: "${NBSHIYAN_DATA_DIR:?}"; D="$NBSHIYAN_DATA_DIR"
ENVF="${NBSHIYAN_APP_ENV_FILE:-$D/.env}"
EDGE_INC="${EDGE_INC:?path of the reverse-proxy include holding X-Edge-Auth}"
COMPOSE_FILE="${COMPOSE_FILE:-$D/src/deploy/docker-compose.yml}"
CENV="$D/compose.env"     # non-secret: NBSHIYAN_DATA_DIR, NBSHIYAN_APP_ENV_FILE, APP_TAG
log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[deploy] ABORT: %s\n' "$*" >&2; exit 1; }
dc() { docker compose -p nbshiyan -f "$COMPOSE_FILE" --env-file "$CENV" "$@"; }
# Run the one-off migrate container. DATABASE_URL comes only from its env_file; output is redacted and kept in a local 600 log.
redact() { sed -E 's#(postgres(ql)?://)[^[:space:]"]*#\1<redacted>#Ig; s#(database|schema) "[^"]*"#\1 "<db>"#g; s#at "[^"]*"#at "<db-host>"#g'; }
migrate() { APP_TAG=candidate MIGRATE_TAG=candidate dc --profile tools run --rm -T --no-deps migrate "$@"; }
write_cenv() { printf 'NBSHIYAN_DATA_DIR=%s\nNBSHIYAN_APP_ENV_FILE=%s\nAPP_TAG=%s\n' "$D" "$ENVF" "$1" > "$CENV"; chmod 600 "$CENV"; }

edge_match() {  # EDGE_AUTH_SECRET in the env file vs the include: both non-empty and >= 32 chars, then hashes only; never printed
  local a b n
  n=$(grep -c '^EDGE_AUTH_SECRET=' "$ENVF" || true); [ "$n" = 1 ] || return 1
  a=$(sed -n 's/^EDGE_AUTH_SECRET=//p' "$ENVF" | tr -d '"\r\n')
  b=$(grep -oE 'X-Edge-Auth[[:space:]]+"?[^";[:space:]]+' "$EDGE_INC" | sed -E 's/^X-Edge-Auth[[:space:]]+"?//' | tr -d '\r\n')
  [ -n "$a" ] && [ -n "$b" ] && [ "${#a}" -ge 32 ] && [ "${#b}" -ge 32 ] || return 1
  [ "$(printf '%s' "$a" | sha256sum | cut -c1-64)" = "$(printf '%s' "$b" | sha256sum | cut -c1-64)" ]
}

# APP_ENV and NODE_ENV must each appear exactly once in the env file, as "production". Only those lines are read.
env_prod_ok() {
  local k
  for k in APP_ENV NODE_ENV; do
    if [ "$(grep -c "^$k=" "$ENVF" || true)" != 1 ] || ! grep -qx "$k=production" "$ENVF"; then
      log "FAIL $k must be exactly 'production' (once) in the app env file"; return 1
    fi
  done
}

# Startup check must really fail closed (full-stack: exactly `run --rm --no-deps -e SMTP_PORT=25 app node server.js` on the
# candidate). SMTP_PORT=25 is a non-secret invalid value; no secret is blanked or passed with -e. Must exit 1, name SMTP_PORT,
# and must NOT be the "no production build" failure (that would be a false pass). The output stays in a 600 temp file, is
# scanned for every secret value of the env file (must be 0 hits) and deleted; it is never printed.
startup_fail_closed() {
  local out vals rc=0 ok=1 n="nbshiyan-envcheck-$$"
  out=$(mktemp); vals=$(mktemp); chmod 600 "$out" "$vals"
  timeout 90 docker compose -p nbshiyan -f "$COMPOSE_FILE" --env-file "$CENV" run --rm --no-deps -T --name "$n" -e SMTP_PORT=25 app node server.js >"$out" 2>&1 || rc=$?
  docker rm -f "$n" >/dev/null 2>&1 || true
  sed -nE 's/^[A-Z0-9_]*(SECRET|TOKEN|PASS|PASSWORD|KEY|DATABASE_URL|SMTP_USER)[A-Z0-9_]*=//p' "$ENVF" | sed -e 's/^"//' -e 's/"$//' | awk 'length >= 12' > "$vals"
  [ "$rc" = 1 ] || { log "FAIL startup with SMTP_PORT=25 exited $rc (want 1)"; ok=0; }
  grep -q 'SMTP_PORT' "$out" || { log "FAIL startup check output does not name SMTP_PORT"; ok=0; }
  grep -qi 'production build' "$out" && { log "FAIL server.js failed for a missing build, not the env check"; ok=0; }
  if [ -s "$vals" ] && grep -qFf "$vals" "$out"; then log "FAIL startup check output contains a secret value"; ok=0; fi
  rm -f "$out" "$vals"; (( ok ))
}

sha_ok() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

# Destructive-change gate (statement/clause based, case-insensitive, fail closed). Tests: deploy/tests/plan-check.test.sh
# shellcheck source=deploy/plan-check.sh
. "$(dirname "$(readlink -f "$0")")/plan-check.sh"

schema_sync() {   # 4 steps, all on the server; nothing leaves it
  local sha; sha=$(cat "$D/.candidate-sha"); sha_ok "$sha" || die "candidate sha invalid"
  local plan="$D/migrate/plan-$sha.sql" logf="$D/migrate/migrate-$sha.log"
  : > "$logf"; chmod 600 "$logf"
  # (1) backup
  "$D/src/deploy/backup-postgres.sh" pre-deploy || die "pre-deploy pg_dump failed"
  # (2) plan: DB (via datasource → DATABASE_URL from env_file) → schema.prisma, as SQL; review gate
  migrate migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script \
    > "$plan.part" 2> >(redact >>"$logf") || die "migrate diff failed (see $logf)"
  mv "$plan.part" "$plan"; chmod 600 "$plan"
  local probs plan_sha; probs=$(plan_problems "$plan" | sort -u); plan_sha=$(sha256sum "$plan" | cut -c1-64)
  if [ -n "$probs" ]; then
    log "schema plan needs review, NOT applied: $plan (sha256 $plan_sha)"; printf '%s\n' "$probs" | sed 's/^/  - /'
    # Review gate: continue ONLY for the exact plan that was reviewed. Any change in the DB or schema → new sha → stop again.
    # This never adds --accept-data-loss: prisma still refuses data-loss changes on its own.
    if [ -n "${APPROVED_PLAN_SHA256:-}" ]; then
      [[ "$APPROVED_PLAN_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "APPROVED_PLAN_SHA256 is not a 64-hex sha256"
      [ "$APPROVED_PLAN_SHA256" = "$plan_sha" ] || die "APPROVED_PLAN_SHA256 does not match this plan; review the new plan"
      log "plan approved by sha256 ($plan_sha), continuing"
    else
      die "awaiting full-stack review of the schema plan (then rerun with APPROVED_PLAN_SHA256=$plan_sha)"
    fi
  else
    log "schema plan: $(grep -ciE '^[[:space:]]*(CREATE|ALTER)' "$plan") statements, additive only"
  fi
  # (3) db push, never --accept-data-loss (prisma itself refuses data-loss changes without it)
  migrate db push --skip-generate --schema prisma/schema.prisma 2>&1 | redact >> "$logf"
  [ "${PIPESTATUS[0]}" = 0 ] || die "prisma db push failed (log kept locally: $logf)"
  # (4) drift must be zero before the app starts (exit 0 = no difference, 2 = difference, 1 = error)
  migrate migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code \
    >/dev/null 2> >(redact >>"$logf") || die "schema drift remains after db push; app NOT started"
  log "schema in sync (drift 0)"
}

post_checks() {
  local ok=1
  for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' nbshiyan-app-1 2>/dev/null)" = healthy ] && break; sleep 4; done
  [ "$(docker inspect -f '{{.State.Health.Status}}' nbshiyan-app-1)" = healthy ] || { log "FAIL app not healthy"; ok=0; }
  ss -lntH | awk '{print $4}' | grep -qE '(:|\.)5432$' && { log "FAIL something listens on 5432 on the host"; ok=0; }
  ss -lntH | awk '{print $4}' | grep -qE '(:|\.)6379$' && { log "WARN 6379 listening on host (not ours unless published)"; }
  ss -lntH | awk '{print $4}' | grep -E ':3000$' | grep -vqE '^127\.0\.0\.1:3000$' && { log "FAIL 3000 bound beyond 127.0.0.1"; ok=0; }
  dc ps --format '{{.Service}} {{.Publishers}}' | grep -vE '^app ' | grep -q '[0-9]->' && { log "FAIL a non-app service publishes a port"; ok=0; }
  h=$(curl -s http://127.0.0.1:3000/api/health); [ "$h" = '{"ok":true}' ] || { log "FAIL /api/health body is not {\"ok\":true}"; ok=0; }
  # srh-net isolation: the app must not resolve srh / redis (only redis-rest via srh-tls on backend)
  for h2 in srh redis; do
    dc exec -T app node -e "require('dns').lookup('$h2',e=>process.exit(e?0:1))" 2>/dev/null || { log "FAIL app can resolve $h2 (must be on srh-net only)"; ok=0; }
  done
  for p in /en /ru /robots.txt /sitemap.xml; do
    c=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$p"); [ "$c" = 200 ] || { log "FAIL $p → $c"; ok=0; }
  done
  curl -sI http://127.0.0.1:3000/en | grep -qi '^x-robots-tag:.*noindex' && { log "FAIL /en carries noindex (APP_ENV not production at build?)"; ok=0; }
  curl -s http://127.0.0.1:3000/en | grep -q '<link rel="canonical" href="https://geiom.com/en"' || { log "FAIL canonical is not https://geiom.com/en"; ok=0; }
  edge_match || { log "FAIL EDGE_AUTH_SECRET differs from the reverse-proxy include (hash compare)"; ok=0; }
  # Redirect headers as the proxy sees them (HOSTNAME=0.0.0.0 → Next emits relative Location). No header may mention
  # localhost; open-redirect probes must not produce a Location starting with // or pointing at evil.com.
  local loc hdr=(-H 'Host: geiom.com' -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-Host: geiom.com')
  for p in / /ru /admin; do
    curl -sI "${hdr[@]}" "http://127.0.0.1:3000$p" | grep -qi localhost && { log "FAIL a response header of $p contains localhost"; ok=0; }
  done
  for p in '//evil.com/' '/%2F%2Fevil.com' '/\evil.com'; do
    loc=$(curl -sI "${hdr[@]}" "http://127.0.0.1:3000$p" | tr -d '\r' | sed -n 's/^[Ll]ocation:[[:space:]]*//p')
    [[ "$loc" == //* || "$loc" == *evil.com* && ! "$loc" =~ ^/[^/] ]] && { log "FAIL open redirect: $p → $loc"; ok=0; }
  done
  startup_fail_closed || ok=0
  (( ok ))
}

promote() {
  for repo in nbshiyan-app nbshiyan-migrate; do
    docker image inspect "$repo:current" >/dev/null 2>&1 && docker tag "$repo:current" "$repo:previous"
    docker tag "$repo:candidate" "$repo:current"
  done
  sha_ok "$(cat "$D/.candidate-sha")" || die "candidate sha invalid"; cp "$D/.candidate-sha" "$D/.current-sha"
}

case "${1:-}" in
  up)
    [ -f "$ENVF" ] && [ "$(stat -c %a "$ENVF")" = 600 ] || die "app env file missing or not 600"
    env_prod_ok || die "APP_ENV / NODE_ENV not production in the app env file (startup check would be skipped)"
    edge_match || die "EDGE_AUTH_SECRET in env file does not match the include (hash compare)"
    docker image inspect nbshiyan-app:candidate >/dev/null || die "no candidate image; run build-on-server.sh"
    sha_ok "$(cat "$D/.candidate-sha" 2>/dev/null)" || die ".candidate-sha is not a 40-hex git sha"
    write_cenv candidate
    dc up -d --wait postgres redis srh srh-tls
    schema_sync          # ordering replaces depends_on: service_completed_successfully (see compose comment)
    dc up -d --no-deps app
    if post_checks; then promote; write_cenv current; dc up -d --no-deps app; log "deployed $(cut -c1-12 "$D/.current-sha")"
    else log "post-deploy checks failed → rolling back"; "$0" rollback; exit 1; fi ;;
  rollback)
    tag=current; [ -f "$CENV" ] && grep -q '^APP_TAG=current$' "$CENV" && tag=previous
    if ! docker image inspect "nbshiyan-app:$tag" >/dev/null 2>&1; then
      # First deploy (no :current / :previous yet): never leave a failed candidate serving on 127.0.0.1:3000
      dc stop app >/dev/null 2>&1 || true
      die "no nbshiyan-app:$tag to roll back to (first deploy?): app container stopped"
    fi
    write_cenv "$tag"; dc up -d --no-deps app; log "app now on :$tag (schema unchanged; additive SQL is backward compatible)" ;;
  *) echo "usage: $0 up|rollback" >&2; exit 2 ;;
esac
