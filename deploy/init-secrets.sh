#!/usr/bin/env bash
# One-time: create the data dirs and generate every server-side secret ON the server. Idempotent: never overwrites.
# Prints NOTHING secret. EDGE_AUTH_SECRET already exists in the app env file and is left untouched.
set -Eeuo pipefail; umask 077
: "${NBSHIYAN_DATA_DIR:?}"; ENVF="${NBSHIYAN_APP_ENV_FILE:-$NBSHIYAN_DATA_DIR/.env}"
D="$NBSHIYAN_DATA_DIR"; S="$D/secrets"; T="$D/internal-tls"
install -d -m 700 -o root -g root "$D" "$S" "$D/backup" "$D/migrate"
install -d -m 700 -o 70 -g 70 "$D/pgdata"
install -d -m 700 -o 1001 -g 1001 "$D/uploads"      # only the app (uid 1001) reads/writes uploads
install -d -m 700 -o root -g root "$T"              # docker (root) bind-mounts single files from here; nobody else lists it
grep -qE '^RESEND_API_KEY=' "${NBSHIYAN_APP_ENV_FILE:-$D/.env}" 2>/dev/null && echo "[init] NOTE: RESEND_API_KEY is obsolete since #315; remove it from the app env file"
rnd() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }
[ -f "$S/pg_password" ] || { rnd > "$S/pg_password"; chown 70:70 "$S/pg_password"; chmod 400 "$S/pg_password"; }
PG="$(cat "$S/pg_password")"
[ -f "$S/migrate.env" ] || printf 'DATABASE_URL=postgresql://nbshiyan:%s@postgres:5432/nbshiyan?schema=public\n' "$PG" > "$S/migrate.env"
if [ ! -f "$S/redis.conf" ]; then
  RP="$(rnd)"
  printf 'requirepass %s\nmaxmemory 48mb\nmaxmemory-policy allkeys-lru\nsave ""\nappendonly no\nprotected-mode yes\nbind 0.0.0.0\n' "$RP" > "$S/redis.conf"
  chown root:1000 "$S/redis.conf"; chmod 640 "$S/redis.conf"
  ST="$(rnd)"; [ "$ST" != "$RP" ] || { echo "[init] rng collision" >&2; exit 1; }   # SRH_TOKEN ≠ requirepass
  printf 'SRH_MODE=env\nSRH_TOKEN=%s\nSRH_CONNECTION_STRING=redis://:%s@redis:6379\n' "$ST" "$RP" > "$S/srh.env"
fi
# Internal CA + leaf cert for srh-tls. The CA is name-constrained to DNS:redis-rest only, and its private key is
# deleted right after signing (it can never sign anything else). Re-issue = run with REISSUE_INTERNAL_TLS=1 (new CA),
# then restart app and srh-tls.
if [ ! -f "$T/ca.crt" ] || [ "${REISSUE_INTERNAL_TLS:-0}" = 1 ]; then
  W=$(mktemp -d -p /dev/shm nbs-ca.XXXXXX); trap 'rm -rf "$W"' EXIT
  cat > "$W/ca.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = nbshiyan-internal-ca
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
nameConstraints = critical, permitted;DNS:redis-rest
subjectKeyIdentifier = hash
CNF
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -config "$W/ca.cnf" \
    -keyout "$W/ca.key" -out "$W/ca.crt" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=redis-rest" \
    -keyout "$W/leaf.key" -out "$W/leaf.csr" 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:redis-rest\n' > "$W/leaf.ext"
  openssl x509 -req -in "$W/leaf.csr" -CA "$W/ca.crt" -CAkey "$W/ca.key" -set_serial "0x$(openssl rand -hex 16)" \
    -days 3650 -extfile "$W/leaf.ext" -out "$W/leaf.crt" 2>/dev/null
  openssl verify -CAfile "$W/ca.crt" "$W/leaf.crt" >/dev/null || { echo "[init] internal TLS verify failed" >&2; exit 1; }
  openssl x509 -in "$W/ca.crt" -noout -ext nameConstraints | grep -q 'DNS:redis-rest' || { echo "[init] nameConstraints missing" >&2; exit 1; }
  # Delete the CA private key now (tmpfs, never written to disk outside /dev/shm)
  shred -u "$W/ca.key" 2>/dev/null || rm -f "$W/ca.key"
  install -m 644 -o root -g root "$W/ca.crt" "$T/ca.crt"
  install -m 644 -o root -g root "$W/leaf.crt" "$T/redis-rest.crt"
  install -m 640 -o root -g 101 "$W/leaf.key" "$T/redis-rest.key"
  rm -f "$T/ca.key" "$T/ca.srl"
  rm -rf "$W"; trap - EXIT
fi
# App env: append generated values only for keys that are missing or empty (never overwrite, never print)
touch "$ENVF"; chmod 600 "$ENVF"; chown root:root "$ENVF"
# A value that is blank or only a comment (e.g. `KEY=   # note`, copied from a template) counts as EMPTY.
EMPTY_RE='^[[:space:]]*(#.*)?$'
setkey() {
  local cur; cur=$(sed -n "s/^$1=//p" "$ENVF" | tail -n 1)
  [[ "$cur" =~ $EMPTY_RE ]] || return 0
  sed -i "/^$1=/d" "$ENVF"; printf '%s=%s\n' "$1" "$2" >> "$ENVF"
}
setkey DATABASE_URL "postgresql://nbshiyan:${PG}@postgres:5432/nbshiyan?schema=public"
setkey AUTH_SECRET "$(openssl rand -base64 32)"
setkey ADMIN_TOTP_KEY "$(openssl rand -base64 32)"
setkey PRIVACY_HASH_SECRET "$(openssl rand -base64 48)"
setkey CRON_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
setkey MIDDLEWARE_PROBE_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
setkey INDEXNOW_KEY "$(openssl rand -hex 16)"
setkey MAIL_WEBHOOK_SECRET "$(openssl rand -base64 48 | tr -d '\n')"   # 48 random bytes; NOT given to the Worker until Q7
setkey UPSTASH_REDIS_REST_TOKEN "$(sed -n 's/^SRH_TOKEN=//p' "$S/srh.env")"
# APP_ENV / NODE_ENV are FORCED (not just filled when empty): without APP_ENV=production at runtime the startup check
# in src/instrumentation.ts is skipped entirely. Non-secret, so overwriting is safe.
for k in APP_ENV NODE_ENV; do sed -i "/^$k=/d" "$ENVF"; printf '%s=production\n' "$k" >> "$ENVF"; done
# APP_ORIGIN is FORCED too: without it admin same-origin checks 403 every POST behind nginx (req.url is http://0.0.0.0:3000).
sed -i '/^APP_ORIGIN=/d' "$ENVF"; printf 'APP_ORIGIN=https://geiom.com\n' >> "$ENVF"
for kv in NEXT_PUBLIC_SITE_URL=https://geiom.com AUTH_URL=https://geiom.com \
          NEXT_PUBLIC_ADMIN_API=http RATE_LIMIT_STORE=upstash UPSTASH_REDIS_REST_URL=https://redis-rest:8443 \
          STORAGE_DRIVER=local UPLOAD_DIR=/data/uploads SHORTLINK_PROBE_ORIGIN=http://127.0.0.1:3000 \
          MAIL_SEND_ADAPTER=smtp SMTP_HOST=smtp.gmail.com SMTP_PORT=465 REPLY_DOMAIN=geiom.com \
          MAIL_DAILY_CAP=450 MAIL_DAILY_CAP_RESET=00:00 MAIL_RATE_ADMIN_PER_HOUR=30 MAIL_RATE_GLOBAL_PER_HOUR=200; do setkey "${kv%%=*}" "${kv#*=}"; done
grep -qE '^EDGE_AUTH_SECRET=[^#[:space:]]{32,}' "$ENVF" || echo "[init] WARNING: EDGE_AUTH_SECRET missing or < 32 bytes in app env file"
echo "[init] done. Keys still empty (Ryan supplies):"; grep -E '^[A-Z0-9_]+=[[:space:]]*(#.*)?$' "$ENVF" | cut -d= -f1 | sed 's/^/  - /' || true
