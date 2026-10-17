#!/usr/bin/env bash
# Import NBshiyan images built OFF the server (deploy/build-offbox.sh) and gate them before deploy.sh may use them.
# Runs ON THE SERVER, from the pinned checkout ($NBSHIYAN_DATA_DIR/src at PIN_SHA). Order (each step fails closed):
#   1. checkout at PIN_SHA + clean + perms gate   2. manifest parse + sha256sum -c of the tarball   3. disk gate
#   4. tar content check BEFORE load: only nbshiyan-app/nbshiyan-migrate:<sha12>, IDs as in the manifest
#   5. docker load (only our two tags may be reported)   6. image IDs, platform, revision + stack labels
#   7. leak scan (= build-on-server.sh step 6: ENV key allow-list, history, fs secret-value scan + env/key files)
#   8. production build checks on the app image (geiom.com, APP_ENV=production, no localhost URL, no Turnstile test key,
#      baked site key = build-args.env value by sha256)
#   9. only on PASS: tag :candidate, write .candidate-sha, rotate OUR old images (as build-on-server.sh step 7)
#  10. the transferred files are always removed on exit.
# Never prints secret values (counts / PASS / FAIL only). Touches only nbshiyan-app:* / nbshiyan-migrate:* images.
#
# Usage: NBSHIYAN_DATA_DIR=<dir> PIN_SHA=<40-hex> IMPORT_DIR=<dir with the three files> deploy/import-and-scan.sh
set -Eeuo pipefail
umask 077

: "${NBSHIYAN_DATA_DIR:?set NBSHIYAN_DATA_DIR}"; D="$NBSHIYAN_DATA_DIR"
: "${PIN_SHA:?set PIN_SHA (full 40-hex SHA)}"
: "${IMPORT_DIR:?set IMPORT_DIR (directory holding the tarball, .sha256 and .manifest)}"
APP_ENV_FILE="${NBSHIYAN_APP_ENV_FILE:-$D/.env}"
BUILD_ARGS_FILE="${BUILD_ARGS_FILE:-$D/build-args.env}"
RESERVE_DISK_GB="${RESERVE_DISK_GB:-2.0}"
SRC="$D/src"

log()  { printf '[import %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
pass() { log "PASS $*"; }
die()  { printf '[import] FAIL: %s\n' "$*" >&2; exit 1; }

[[ "$PIN_SHA" =~ ^[0-9a-f]{40}$ ]] || die "PIN_SHA must be a full lowercase 40-hex SHA"
SHORT="${PIN_SHA:0:12}"
base="nbshiyan-images-$SHORT"
IMPORT_DIR=$(readlink -f "$IMPORT_DIR"); TARZ="$IMPORT_DIR/$base.tar.zst"; SUMF="$TARZ.sha256"; MANF="$IMPORT_DIR/$base.manifest"
APP="nbshiyan-app:$SHORT"; MIG="nbshiyan-migrate:$SHORT"
command -v zstd >/dev/null || die "zstd missing"

loaded=0; scan=""; pat=""
cleanup() {
  rm -f "$TARZ" "$SUMF" "$MANF"
  [ -n "$pat" ] && rm -f "$pat"
  [ -n "$scan" ] && rm -rf "$scan"
  return 0
}
fail_cleanup() {  # on any failure after load: remove the two loaded <sha12> tags unless candidate/current/previous use them
  local rc=$?
  if (( rc != 0 && loaded )); then
    for ref in "$APP" "$MIG"; do
      local repo=${ref%%:*} id keep
      id=$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true); [ -n "$id" ] || continue
      keep=$(for t in current previous candidate; do docker image inspect -f '{{.Id}}' "$repo:$t" 2>/dev/null || true; done)
      grep -qxF "$id" <<<"$keep" || docker image rm "$ref" >/dev/null 2>&1 || true
    done
    log "loaded $SHORT images removed again (not tagged :candidate)"
  fi
  cleanup
}
trap fail_cleanup EXIT

# ---------- 1. the merged checkout this script runs from ----------
[ "$(git -C "$SRC" rev-parse HEAD)" = "$PIN_SHA" ] || die "$SRC is not checked out at $SHORT"
st=$(git -C "$SRC" status --porcelain) || die "git status failed"; [ -z "$st" ] || die "$SRC work tree not clean"
git -C "$SRC" merge-base --is-ancestor "$PIN_SHA" origin/main || die "$SHORT is not merged into origin/main"
src_perm_problems=$(find "$SRC" -mindepth 1 -path "$SRC/.git" -prune -o ! -type l \( \( -type f ! -perm -o=r \) -o \( -type d ! -perm -o=rx \) -o -perm /022 \) -print 2>&1 || true)
[ -z "$src_perm_problems" ] || die "checkout has files non-root containers cannot read (or group/other-writable)"
pass "checkout $SHORT clean, merged, perms ok"

# ---------- 2. manifest (strict key=value, never sourced) + sha256 ----------
[ -f "$TARZ" ] && [ -f "$SUMF" ] && [ -f "$MANF" ] || die "tarball, .sha256 or .manifest missing in IMPORT_DIR"
man=$(cat "$MANF")
mget() { local v; v=$(sed -n "s/^$1=//p" <<<"$man"); [ "$(grep -c "^$1=" <<<"$man")" = 1 ] || die "manifest: $1 must appear exactly once"; printf '%s' "$v"; }
[ "$(mget PIN_SHA)" = "$PIN_SHA" ] || die "manifest PIN_SHA is not $SHORT"
[ "$(mget TARBALL)" = "$base.tar.zst" ] || die "manifest TARBALL name mismatch"
[ "$(mget APP_TAG)" = "$APP" ] && [ "$(mget MIGRATE_TAG)" = "$MIG" ] || die "manifest tags are not $APP / $MIG"
for k in APP_CONFIG_ID APP_MANIFEST_DIGEST MIGRATE_CONFIG_ID MIGRATE_MANIFEST_DIGEST; do
  [[ "$(mget "$k")" =~ ^sha256:[0-9a-f]{64}$ ]] || die "manifest: $k is not a sha256 digest"
done
TAR_BYTES=$(mget TAR_BYTES); [[ "$TAR_BYTES" =~ ^[0-9]+$ ]] || die "manifest: TAR_BYTES invalid"
PLATFORM=$(mget PLATFORM)
srv_platform=$(docker version -f '{{.Server.Os}}/{{.Server.Arch}}') || die "docker version failed"
[ "$PLATFORM" = "$srv_platform" ] || die "manifest platform $PLATFORM != server $srv_platform"
want_sum=$(mget TARBALL_SHA256); [[ "$want_sum" =~ ^[0-9a-f]{64}$ ]] || die "manifest: TARBALL_SHA256 invalid"
sumline=$(cat "$SUMF")
[ "$sumline" = "$want_sum  $base.tar.zst" ] || die ".sha256 file does not match the manifest"
( cd "$IMPORT_DIR" && sha256sum --quiet --strict -c "$base.tar.zst.sha256" ) || die "sha256sum -c failed for $base.tar.zst"
pass "sha256 of $base.tar.zst"

# ---------- 3. disk gate: load (blobs + unpacked layers) + one exported fs at a time + reserve ----------
DOCKER_ROOT="$(docker info -f '{{.DockerRootDir}}')"
need_mb=$(( TAR_BYTES * 3 / 1048576 )); reserve_mb=$(awk -v r="$RESERVE_DISK_GB" 'BEGIN{print int(r*1024)}')
for dpath in "$DOCKER_ROOT" "$D"; do
  free_mb=$(df -P --block-size=1M "$dpath" | awk 'NR==2{print $4}')
  (( free_mb >= need_mb + reserve_mb )) || die "free disk ${free_mb} MiB < need ${need_mb} + reserve ${reserve_mb} MiB"
done
pass "disk: need $(( need_mb + reserve_mb )) MiB incl. reserve"

# ---------- 4. tar content BEFORE load: only our two tags, IDs as in the manifest ----------
list=$(zstd -dcq "$TARZ" | tar -t) || die "tarball is not a readable tar.zst"
other=$(grep -vxE 'blobs/|blobs/sha256/|blobs/sha256/[0-9a-f]{64}|index\.json|manifest\.json|oci-layout|repositories' <<<"$list" || true)
[ -z "$other" ] || die "tarball holds unexpected entries"
idx=$(zstd -dcq "$TARZ" | tar -xO index.json) || die "index.json missing"
dmf=$(zstd -dcq "$TARZ" | tar -xO manifest.json) || die "manifest.json missing"
reps=$(zstd -dcq "$TARZ" | tar -xO repositories 2>/dev/null || true)
names=$(grep -oE '"io\.containerd\.image\.name":"[^"]*"' <<<"$idx" | cut -d'"' -f4 | sort)
[ "$names" = "$(printf 'docker.io/library/%s\ndocker.io/library/%s' "$APP" "$MIG" | sort)" ] || die "index.json names other images than $APP / $MIG (foreign tag)"
[ "$(grep -o '"mediaType":"application/vnd.oci.image.manifest.v1+json"' <<<"$idx" | wc -l)" = 2 ] || die "index.json must list exactly 2 image manifests"
refnames=$(grep -oE '"org\.opencontainers\.image\.ref\.name":"[^"]*"' <<<"$idx" | cut -d'"' -f4 | sort -u)
[ -z "$refnames" ] || [ "$refnames" = "$SHORT" ] || die "index.json ref.name is not $SHORT"
tags=$(grep -oE '"RepoTags":\[[^]]*\]' <<<"$dmf" | grep -oE '"[^"]+"' | grep -v '"RepoTags"' | tr -d '"' | sort)
[ "$tags" = "$(printf '%s\n%s' "$APP" "$MIG" | sort)" ] || die "manifest.json RepoTags are not exactly $APP / $MIG (foreign tag)"
if [ -n "$reps" ]; then
  rk=$(grep -oE '"[^"]+":\{' <<<"$reps" | tr -d '":{' | sort)
  [ "$rk" = "$(printf 'nbshiyan-app\nnbshiyan-migrate')" ] || die "repositories file names other repos (foreign tag)"
fi
split=${idx//'},{"mediaType"'/$'}\n{"mediaType"'}
dsplit=${dmf//'},{"Config"'/$'}\n{"Config"'}
for pair in "APP:$APP" "MIGRATE:$MIG"; do
  k=${pair%%:*}; ref=${pair#*:}
  md=$(grep -F "\"io.containerd.image.name\":\"docker.io/library/$ref\"" <<<"$split" | grep -oE '"digest":"sha256:[0-9a-f]{64}"' | cut -d'"' -f4 || true)
  [ "$md" = "$(mget "${k}_MANIFEST_DIGEST")" ] || die "manifest digest of $ref in the tar != expected"
  cf=$(grep -F "\"$ref\"" <<<"$dsplit" | grep -oE '"Config":"blobs/sha256/[0-9a-f]{64}"' | grep -oE '[0-9a-f]{64}' || true)
  [ "sha256:$cf" = "$(mget "${k}_CONFIG_ID")" ] || die "config digest of $ref in the tar != expected"
done
pass "tar holds only $APP + $MIG with the expected digests"

# ---------- 5. load ----------
loaded=1
lout=$(zstd -dcq "$TARZ" | docker load 2>&1) || die "docker load failed"
got=$(grep -oE '^Loaded image( ID)?: .*' <<<"$lout" | sed -E 's/^Loaded image( ID)?: //' | sed 's#^docker.io/library/##' | sort -u)
[ "$got" = "$(printf '%s\n%s' "$APP" "$MIG" | sort)" ] || die "docker load reported other images than $APP / $MIG"
rm -f "$TARZ"
pass "docker load: exactly $APP + $MIG (tarball removed)"

# ---------- 6. IDs, platform, labels ----------
for pair in "APP:$APP" "MIGRATE:$MIG"; do
  k=${pair%%:*}; ref=${pair#*:}
  id=$(docker image inspect -f '{{.Id}}' "$ref") || die "$ref not present after load"
  # classic image store: .Id = config digest; containerd image store: .Id = manifest digest. Both come from the verified tar.
  [ "$id" = "$(mget "${k}_CONFIG_ID")" ] || [ "$id" = "$(mget "${k}_MANIFEST_DIGEST")" ] || die "image ID of $ref != manifest"
  [ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$ref")" = "$PLATFORM" ] || die "$ref platform != $PLATFORM"
  [ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")" = "$PIN_SHA" ] || die "$ref revision label != $SHORT"
  [ "$(docker image inspect -f '{{index .Config.Labels "com.nbshiyan.stack"}}' "$ref")" = nbshiyan ] || die "$ref lacks com.nbshiyan.stack=nbshiyan"
done
pass "image IDs = manifest, platform $PLATFORM, revision = $SHORT"

# ---------- 7. leak scan (same rules as build-on-server.sh step 6; counts only) ----------
leak=0
SECRET_KEYS_RE='DATABASE_URL|AUTH_SECRET|ADMIN_TOTP_KEY|PRIVACY_HASH_SECRET|CRON_SECRET|MIDDLEWARE_PROBE_SECRET|EDGE_AUTH_SECRET|UPSTASH_REDIS_REST_TOKEN|SRH_TOKEN|SMTP_USER|SMTP_PASS|MAIL_WEBHOOK_SECRET|RESEND_API_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|TURNSTILE_SECRET_KEY|SANITY_API_READ_TOKEN|SANITY_REVALIDATE_SECRET|POSTGRES_PASSWORD|requirepass|[A-Z_]*(SECRET|TOKEN|PASSWORD)'
for img in "$APP" "$MIG"; do
  envk=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$img" | cut -d= -f1)
  bad=$(grep -vxE 'PATH|NODE_VERSION|YARN_VERSION|NEXT_TELEMETRY_DISABLED|PNPM_HOME|CI|NODE_ENV|HOME|PORT|HOSTNAME|UPLOAD_DIR|CHECKPOINT_DISABLE|PRISMA_HIDE_UPDATE_MESSAGE|' <<<"$envk" || true)
  if [ -n "$bad" ]; then log "FAIL $img has unexpected ENV keys: $(tr '\n' ' ' <<<"$bad")"; leak=1; fi
  hist=$(docker history --no-trunc --format '{{.CreatedBy}}' "$img") || die "docker history $img failed"
  if grep -Eiq "($SECRET_KEYS_RE)=" <<<"$hist"; then log "FAIL secret-like assignment in docker history of $img"; leak=1; fi
done
pat=$(mktemp -p /dev/shm nbs-pat.XXXXXX); scan=$(mktemp -d -p "$D" .scan.XXXXXX)
{ [ -f "$APP_ENV_FILE" ] && grep -E "^($SECRET_KEYS_RE)=" "$APP_ENV_FILE" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
  [ -f "$D/secrets/pg_password" ] && cat "$D/secrets/pg_password" || true
  [ -f "$D/secrets/srh.env" ] && sed -n 's/^SRH_TOKEN=//p' "$D/secrets/srh.env" || true
  [ -f "$D/secrets/redis.conf" ] && sed -n 's/^requirepass //p' "$D/secrets/redis.conf" || true
} 2>/dev/null | awk 'length >= 12' | sort -u > "$pat"
[ -s "$pat" ] || die "no secret values available to scan for (env file / secrets missing): a vacuous scan is not a PASS"
prod_checks() {  # prod_checks <exported fs root of the app image> → 0 if all PASS; one PASS/FAIL line each
  local root="$1" N="$1/app/.next-dist" ok=1 n R files cands want got
  [ -d "$N" ] || { log "FAIL app image has no /app/.next-dist"; return 1; }
  # (a) the production origin is baked in (canonical / sitemap / metadataBase use NEXT_PUBLIC_SITE_URL at build)
  n=$( { grep -rlF 'https://geiom.com' "$N" 2>/dev/null || true; } | wc -l)
  if (( n > 0 )); then pass "build output contains https://geiom.com ($n files)"; else log "FAIL build output lacks https://geiom.com"; ok=0; fi
  # (b) APP_ENV=production at build: otherwise next.config.ts adds an X-Robots-Tag noindex header rule for /:path*
  n=$( { grep -oE '"source":"/:path\*","headers":\[[^]]*noindex' "$N/routes-manifest.json" 2>/dev/null || true; } | wc -l)
  if [ -f "$N/routes-manifest.json" ] && (( n == 0 )); then pass "APP_ENV=production at build (no site-wide noindex rule)"
  else log "FAIL site-wide noindex rule in routes-manifest (APP_ENV was not production at build)"; ok=0; fi
  # (c) no localhost / loopback URL in what is served or baked from config: client bundle (static/), prerendered pages
  #     (server/app/**/*.html|rsc|body|meta) and the build manifests. Server JS chunks are excluded: Next.js framework
  #     code there has dev/test fallbacks like `http://localhost:${PORT}` that never reach a response (runtime headers
  #     are covered by deploy.sh hdr_leak). Library code in static/ only compares hostnames to "localhost", so the
  #     rule matches URL forms (//localhost, //127.0.0.1, //0.0.0.0), not the bare word.
  R='//(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/"'"'"'`]|$)'
  files=$( { find "$N/static" "$N/server/app" -type f \( -path "$N/static/*" -o -name '*.html' -o -name '*.rsc' -o -name '*.body' -o -name '*.meta' \) 2>/dev/null
             find "$N" "$N/server" -maxdepth 1 -type f -name '*.json' 2>/dev/null; } || true)
  n=0; if [ -n "$files" ]; then n=$( { tr '\n' '\0' <<<"$files" | xargs -0 grep -lE "$R" 2>/dev/null || true; } | wc -l); fi
  if (( n == 0 )); then pass "no localhost/loopback URL in client bundle, prerendered pages or manifests"; else log "FAIL localhost/loopback URL in $n served/baked files"; ok=0; fi
  # (d) no Cloudflare Turnstile test key anywhere in the app
  n=$( { grep -rlE '[123]x0{20,}[A-Z]{2}' "$root/app" 2>/dev/null || true; } | wc -l)
  if (( n == 0 )); then pass "no Turnstile test key"; else log "FAIL Turnstile test key in $n files"; ok=0; fi
  # (e) exactly one baked site key in the client bundle, and its sha256 = the build-args.env value's sha256
  cands=$( { grep -rhoE '0x4AAAAA[A-Za-z0-9_-]{10,40}' "$N/static" 2>/dev/null || true; } | sort -u)
  want=$(sed -n 's/^NEXT_PUBLIC_TURNSTILE_SITE_KEY=//p' "$BUILD_ARGS_FILE" 2>/dev/null | tail -n 1 | sed -e 's/^"//' -e 's/"$//' | tr -d '\r\n' | sha256sum | cut -c1-64)
  got=""; [ -n "$cands" ] && got=$(printf '%s' "$cands" | sha256sum | cut -c1-64)
  if [ -n "$cands" ] && [ "$(wc -l <<<"$cands")" = 1 ] && [ "$got" = "$want" ] && [ -s "$BUILD_ARGS_FILE" ]; then pass "baked Turnstile site key = build-args.env (sha256)"
  else log "FAIL baked Turnstile site key: $( [ -n "$cands" ] && wc -l <<<"$cands" || echo 0) candidate(s), sha256 match=$([ "$got" = "$want" ] && echo yes || echo no)"; ok=0; fi
  (( ok ))
}
for img in "$APP" "$MIG"; do
  rm -rf "${scan:?}"/*; cid=$(docker create "$img")
  docker export "$cid" | tar -x -C "$scan" --exclude='proc/*' --exclude='sys/*' --exclude='dev/*'; docker rm -f "$cid" >/dev/null
  hits=$( { grep -rFla -f "$pat" "$scan" 2>/dev/null || true; } | wc -l)
  keyfiles=$( { find "$scan/app" "$scan/opt" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \) ! -name '.env.example' 2>/dev/null || true; } | wc -l)
  log "fs scan $img: $(wc -l < "$pat") secret values, hits=$hits, env/key files=$keyfiles"
  (( hits == 0 && keyfiles == 0 )) || leak=1
  if [ "$img" = "$APP" ]; then prod_checks "$scan" || leak=1; fi
done
rm -f "$pat"; rm -rf "$scan"; pat=""; scan=""
(( leak == 0 )) || die "leak scan / production checks failed; loaded images removed. Do not deploy."
pass "leak scan: 0 hits, 0 env/key files, production checks ok"

# ---------- 9. promote to :candidate (only here, only after every check passed) + rotate our old images ----------
for repo in nbshiyan-app nbshiyan-migrate; do
  docker tag "$repo:$SHORT" "$repo:candidate"
  keep_ids=$(for t in current previous candidate; do docker image inspect -f '{{.Id}}' "$repo:$t" 2>/dev/null || true; done | sort -u)
  refs=$(docker image ls "$repo" --filter label=com.nbshiyan.stack=nbshiyan --format '{{.Repository}}:{{.Tag}}')
  while read -r ref; do
    [ -n "$ref" ] || continue
    id=$(docker image inspect -f '{{.Id}}' "$ref")
    grep -qxF "$id" <<<"$keep_ids" || { log "removing old own image $ref"; docker image rm "$ref" >/dev/null || true; }
  done <<<"$refs"
done
echo "$PIN_SHA" > "$D/.candidate-sha"
loaded=0
log "done: $APP + $MIG tagged :candidate, .candidate-sha = $SHORT (next: deploy.sh up)"
