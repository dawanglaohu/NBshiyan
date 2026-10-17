#!/usr/bin/env bash
# Build the NBshiyan images ON the server from a pinned, merged commit. DRAFT (plan §11 v1.6), full-stack review first.
# Touches ONLY: ${NBSHIYAN_DATA_DIR}/src, the dedicated buildx builder "nbshiyan-builder", images nbshiyan-app:* / nbshiyan-migrate:*.
# NEVER runs `docker system prune`, `docker image prune`, `docker volume prune` or touches any other image/volume/container.
# Never prints secret values (leak checks print counts / file names only).
#
# Usage: NBSHIYAN_DATA_DIR=<dir> PIN_SHA=<40-hex merged commit> deploy/build-on-server.sh
set -Eeuo pipefail
umask 077

: "${NBSHIYAN_DATA_DIR:?set NBSHIYAN_DATA_DIR}"
: "${PIN_SHA:?set PIN_SHA to a full 40-char commit SHA that is already merged into main}"
REPO_URL="${REPO_URL:-https://github.com/dawanglaohu/NBshiyan.git}"     # public, anonymous HTTPS, no token
APP_ENV_FILE="${NBSHIYAN_APP_ENV_FILE:-$NBSHIYAN_DATA_DIR/.env}"          # runtime secrets; read ONLY for the leak check
BUILD_ARGS_FILE="${BUILD_ARGS_FILE:-$NBSHIYAN_DATA_DIR/build-args.env}"   # PUBLIC values only (whitelisted below)
DOCKERFILE_DIR="${DOCKERFILE_DIR:-}"   # until the Dockerfile PR is merged: dir holding reviewed Dockerfile + .dockerignore
BUILDER=nbshiyan-builder
BUILDKIT_IMAGE="moby/buildkit:v0.34.0@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c"
# Reviewed BuildKit config (docker.io mirrors; the server cannot reach registry-1.docker.io). Read from the pinned checkout.
BUILDKITD_CONFIG_SHA256="6b46269ff5417a435a9891b0d573860947a0954ad6917db359233c5e9d5a1f7f"
BUILDKITD_MIRRORS=(docker.1ms.run docker.m.daocloud.io docker.xuanyuan.me)
BUILDER_CFG_MARK="$NBSHIYAN_DATA_DIR/.builder-config-sha256"   # sha256 of the config nbshiyan-builder was created with
DOCKERFILE_SYNTAX_DIGEST="sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e"   # docker/dockerfile:1.7 (= 1.7.1) index
BUILDER_MEM="${BUILDER_MEM:-2560m}"     # hard cap for the whole build (OOM kills the builder, not other prod)
BUILDER_CPUS="${BUILDER_CPUS:-0-2}"     # leave one core for the running services
NODE_IMAGE_DIGEST="sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
# Disk gate (GiB), from local measurements, see plan §11.3. First build pulls base images + fills the cache.
NEED_DISK_GB_FIRST="${NEED_DISK_GB_FIRST:-4.0}"
NEED_DISK_GB_REBUILD="${NEED_DISK_GB_REBUILD:-2.5}"
RESERVE_DISK_GB="${RESERVE_DISK_GB:-2.0}"  # must remain free for the other production services afterwards
NEED_MEM_AVAIL_MB="${NEED_MEM_AVAIL_MB:-2900}"
CACHE_KEEP="${CACHE_KEEP:-1gb}"

log() { printf '[build %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[build] ABORT: %s\n' "$*" >&2; exit 1; }

[[ "$PIN_SHA" =~ ^[0-9a-f]{40}$ ]] || die "PIN_SHA must be a full lowercase 40-hex SHA (never a branch name)"
SHORT="${PIN_SHA:0:12}"

# ---------- 1. gates: disk + memory ----------
DOCKER_ROOT="$(docker info -f '{{.DockerRootDir}}')"
free_gb() { df -P --block-size=1M "$1" | awk 'NR==2{printf "%.1f", $4/1024}'; }
first_build=1; docker buildx inspect "$BUILDER" >/dev/null 2>&1 && docker image inspect "nbshiyan-app:current" >/dev/null 2>&1 && first_build=0 || true
need=$([ $first_build = 1 ] && echo "$NEED_DISK_GB_FIRST" || echo "$NEED_DISK_GB_REBUILD")
for d in "$DOCKER_ROOT" "$NBSHIYAN_DATA_DIR"; do
  f=$(free_gb "$d")
  awk -v f="$f" -v n="$need" -v r="$RESERVE_DISK_GB" 'BEGIN{exit !(f >= n + r)}' \
    || die "free space on $(df -P "$d" | awk 'NR==2{print $6}') is ${f} GiB < need ${need} + reserve ${RESERVE_DISK_GB} GiB. Nothing outside NBshiyan may be cleaned; stop and report."
  log "disk ok: ${f} GiB free on $(df -P "$d" | awk 'NR==2{print $6}') (need ${need} + reserve ${RESERVE_DISK_GB})"
done
avail_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
(( avail_mb >= NEED_MEM_AVAIL_MB )) || die "MemAvailable ${avail_mb} MB < ${NEED_MEM_AVAIL_MB} MB; retry in a quieter window"
log "memory ok: MemAvailable ${avail_mb} MB"

# ---------- 2. source at the pinned, merged commit ----------
SRC="$NBSHIYAN_DATA_DIR/src"
if [ ! -d "$SRC/.git" ]; then git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$SRC"; fi
git -C "$SRC" remote set-url origin "$REPO_URL"
git -C "$SRC" fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main'
git -C "$SRC" cat-file -e "${PIN_SHA}^{commit}" 2>/dev/null || die "commit $SHORT not found on origin"
git -C "$SRC" merge-base --is-ancestor "$PIN_SHA" origin/main || die "commit $SHORT is not merged into main"
git -C "$SRC" -c advice.detachedHead=false checkout --quiet --force --detach "$PIN_SHA"
git -C "$SRC" clean -fdxq
[ "$(git -C "$SRC" rev-parse HEAD)" = "$PIN_SHA" ] || die "HEAD mismatch"
[ -z "$(git -C "$SRC" status --porcelain)" ] || die "work tree not clean"
log "source: $SHORT ($(git -C "$SRC" log -1 --format=%cI))"

DF="$SRC/Dockerfile"
if [ -n "$DOCKERFILE_DIR" ]; then
  DF="$DOCKERFILE_DIR/Dockerfile"; cp "$DOCKERFILE_DIR/.dockerignore" "$SRC/.dockerignore"
  log "WARNING: using out-of-repo Dockerfile from DOCKERFILE_DIR (only until the Dockerfile PR is merged)"
fi
[ -f "$DF" ] && [ -f "$SRC/.dockerignore" ] || die "Dockerfile/.dockerignore missing"
grep -q "$NODE_IMAGE_DIGEST" "$DF" || die "Dockerfile base image digest is not the reviewed one"
[ "$(head -n 1 "$DF")" = "# syntax=docker/dockerfile:1.7@$DOCKERFILE_SYNTAX_DIGEST" ] || die "Dockerfile syntax frontend is not pinned to the reviewed digest"
BKCFG="$SRC/deploy/buildkitd.toml"
[ -f "$BKCFG" ] && [ "$(sha256sum < "$BKCFG" | cut -c1-64)" = "$BUILDKITD_CONFIG_SHA256" ] || die "deploy/buildkitd.toml missing or not the reviewed file (sha256)"
{ grep -qE '^\.env$' "$SRC/.dockerignore" && grep -qE '^\.env\.\*$' "$SRC/.dockerignore"; } || die ".dockerignore must exclude .env*"
if grep -nE '^\s*(ARG|ENV)\s+[A-Z_]*(SECRET|TOKEN|PASSWORD|_KEY|DATABASE_URL)' "$DF" | grep -vE 'NEXT_PUBLIC_|SITE_KEY'; then die "secret-like ARG/ENV in Dockerfile"; fi
grep -nE '^\s*COPY\s+.*\.env' "$DF" && die "Dockerfile copies an env file"

# ---------- 3. public build args (whitelist) ----------
ALLOWED='^(APP_ENV|NEXT_PUBLIC_SITE_URL|NEXT_PUBLIC_ADMIN_API|NEXT_PUBLIC_TURNSTILE_SITE_KEY|NEXT_PUBLIC_TAWK_PROPERTY_ID|NEXT_PUBLIC_TAWK_WIDGET_ID|NEXT_PUBLIC_TAWK_WIDGET_ID_RU|NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION|NEXT_PUBLIC_YANDEX_VERIFICATION|NEXT_PUBLIC_BING_VERIFICATION|NEXT_PUBLIC_FAQ_JSONLD_ENABLED|NEXT_PUBLIC_ADMIN_MAIL|SANITY_PROJECT_ID|SANITY_DATASET)$'
BARGS=(--build-arg "GIT_SHA=$PIN_SHA")
if [ -f "$BUILD_ARGS_FILE" ]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    k="${line%%=*}"; v="${line#*=}"
    [[ "$k" =~ $ALLOWED ]] || die "build-args.env: key $k is not an allowed PUBLIC build arg"
    BARGS+=(--build-arg "$k=$v")
  done < "$BUILD_ARGS_FILE"
fi
grep -q "^NEXT_PUBLIC_ADMIN_MAIL=mock" "$BUILD_ARGS_FILE" 2>/dev/null && die "NEXT_PUBLIC_ADMIN_MAIL=mock is not allowed"  # admin_mail_mock
grep -q '^APP_ENV=production$' "$BUILD_ARGS_FILE" 2>/dev/null || BARGS+=(--build-arg APP_ENV=production)
grep -q '^NEXT_PUBLIC_SITE_URL=' "$BUILD_ARGS_FILE" 2>/dev/null || BARGS+=(--build-arg NEXT_PUBLIC_SITE_URL=https://geiom.com)
# barg/sed below would exit 2 (silently, under errexit) without the file; the Turnstile site key requires it anyway.
[ -f "$BUILD_ARGS_FILE" ] || die "build-args.env missing ($BUILD_ARGS_FILE)"
# Fail early on what prod-env-check's BUILD phase (fix/deploy-readiness) would reject anyway, after a long build:
barg() { sed -n "s/^$1=//p" "$BUILD_ARGS_FILE" 2>/dev/null | tail -n 1 | sed -e 's/^"//' -e 's/"$//'; }
site=$(barg NEXT_PUBLIC_SITE_URL); site=${site:-https://geiom.com}
[[ "$site" =~ ^https://[^/]+ ]] || die "NEXT_PUBLIC_SITE_URL must be https"
host=$(sed -E 's#^https://(\[[^]]*\]|[^/:]+).*#\1#' <<<"$site" | tr '[:upper:]' '[:lower:]'); host=${host%.}
[ "$host" = geiom.com ] || die "NEXT_PUBLIC_SITE_URL host must be exactly geiom.com (allowlist)"
[ "$site" = https://geiom.com ] || die "NEXT_PUBLIC_SITE_URL must be exactly https://geiom.com (no port, path or trailing slash)"
tsk=$(barg NEXT_PUBLIC_TURNSTILE_SITE_KEY)
[ -n "$tsk" ] || die "NEXT_PUBLIC_TURNSTILE_SITE_KEY missing in build-args.env (public; required by the build check)"
[[ "$tsk" =~ ^[123]x0{20,}[A-Z]{2}$ ]] && die "NEXT_PUBLIC_TURNSTILE_SITE_KEY is the Cloudflare test key"
aapi=$(barg NEXT_PUBLIC_ADMIN_API); [ -z "$aapi" ] || [ "$aapi" = http ] || die "NEXT_PUBLIC_ADMIN_API must be http"
grep -qE '^NEXT_PUBLIC_[A-Z_]*_MOCK=' <<<"$(env)" && die "a NEXT_PUBLIC_*_MOCK variable is set in this shell"
grep -qiE '^NEXT_PUBLIC_[A-Z_]*_MOCK=' "$BUILD_ARGS_FILE" 2>/dev/null && die "mock switches are not allowed in build-args.env"

# ---------- 4. dedicated, memory-capped builder (with the reviewed registry config) ----------
# A builder made before this config (or with another one) is removed and recreated. Only OUR builder is ever removed;
# its build cache goes with it (the next build is a first build again).
if docker buildx inspect "$BUILDER" >/dev/null 2>&1 && [ "$(cat "$BUILDER_CFG_MARK" 2>/dev/null)" != "$BUILDKITD_CONFIG_SHA256" ]; then
  log "builder $BUILDER was created with another (or no) buildkitd config: recreating it"
  docker buildx rm "$BUILDER" >/dev/null
  rm -f "$BUILDER_CFG_MARK"
fi
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container \
    --buildkitd-config "$BKCFG" \
    --driver-opt "image=$BUILDKIT_IMAGE" \
    --driver-opt "memory=$BUILDER_MEM" --driver-opt "memory-swap=$BUILDER_MEM" \
    --driver-opt "cpuset-cpus=$BUILDER_CPUS" >/dev/null
  printf '%s\n' "$BUILDKITD_CONFIG_SHA256" > "$BUILDER_CFG_MARK"; chmod 600 "$BUILDER_CFG_MARK"
fi
# From here on, always stop our builder on exit (success or failure) to give its memory back to the other services.
stop_builder() { docker buildx stop "$BUILDER" >/dev/null 2>&1 || true; }
trap stop_builder EXIT
docker buildx inspect --bootstrap "$BUILDER" >/dev/null
# The running BuildKit must really have the mirrors (buildx re-serializes the toml, so check content, not the file hash).
BK_CTR="buildx_buildkit_${BUILDER}0"
bk_toml=$(docker exec "$BK_CTR" cat /etc/buildkit/buildkitd.toml 2>/dev/null) || die "cannot read buildkitd.toml in $BK_CTR"
# buildx (v0.34) writes TOML with single quotes ([registry.'docker.io'], mirrors = ['a', ...]); accept either quote style.
grep -qE "^[[:space:]]*\[registry\.[\"']docker\.io[\"']\][[:space:]]*$" <<<"$bk_toml" || die "builder config lacks the [registry.docker.io] section"
for m in "${BUILDKITD_MIRRORS[@]}"; do
  grep -qE "^[[:space:]]*mirrors[[:space:]]*=.*[\"']${m//./\\.}[\"']" <<<"$bk_toml" || die "builder config lacks docker.io mirror $m"
done
log "builder ok: $BUILDER with docker.io mirrors (${#BUILDKITD_MIRRORS[@]})"

# ---------- 5. build (runner + migrate), tagged by SHA ----------
LBL=(--label com.nbshiyan.stack=nbshiyan --label "org.opencontainers.image.revision=$PIN_SHA")
t0=$(date +%s)
for target in runner migrate; do
  repo=$([ $target = runner ] && echo nbshiyan-app || echo nbshiyan-migrate)
  log "building $repo:$SHORT"
  docker buildx build --builder "$BUILDER" --pull --load --provenance=false \
    -f "$DF" --target "$target" -t "$repo:$SHORT" "${LBL[@]}" "${BARGS[@]}" "$SRC"
done
log "build time: $(( $(date +%s) - t0 ))s"

# ---------- 6. leak checks (print counts only) ----------
leak=0
# Secret variable names (values must never be in an image). RESEND_API_KEY kept on purpose (obsolete since #315, must stay absent).
SECRET_KEYS_RE='DATABASE_URL|AUTH_SECRET|ADMIN_TOTP_KEY|PRIVACY_HASH_SECRET|CRON_SECRET|MIDDLEWARE_PROBE_SECRET|EDGE_AUTH_SECRET|UPSTASH_REDIS_REST_TOKEN|SRH_TOKEN|SMTP_USER|SMTP_PASS|MAIL_WEBHOOK_SECRET|RESEND_API_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|TURNSTILE_SECRET_KEY|SANITY_API_READ_TOKEN|SANITY_REVALIDATE_SECRET|POSTGRES_PASSWORD|requirepass|[A-Z_]*(SECRET|TOKEN|PASSWORD)'
for img in "nbshiyan-app:$SHORT" "nbshiyan-migrate:$SHORT"; do
  # 6a. image config env: only expected non-secret keys
  bad=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$img" | cut -d= -f1 | grep -vxE 'PATH|NODE_VERSION|YARN_VERSION|NEXT_TELEMETRY_DISABLED|PNPM_HOME|CI|NODE_ENV|HOME|PORT|HOSTNAME|UPLOAD_DIR|CHECKPOINT_DISABLE|PRISMA_HIDE_UPDATE_MESSAGE' || true)
  [ -z "$bad" ] || { log "LEAK? $img has unexpected ENV keys: $bad"; leak=1; }
  # 6b. history must not contain secret-like assignments
  #     captured first: `docker history | grep -q` under pipefail can SIGPIPE the producer and read a hit as clean
  hist=$(docker history --no-trunc --format '{{.CreatedBy}}' "$img") || die "docker history $img failed"
  if grep -Eiq "($SECRET_KEYS_RE)=" <<<"$hist"; then
    log "LEAK? secret-like assignment in docker history of $img"; leak=1; fi
done
# 6c. filesystem scan of BOTH images (app image includes the full build output under /app/.next-dist):
#     secret VALUES from the runtime env file + internal secrets must not appear anywhere. Must be 0 hits.
pat=$(mktemp -p /dev/shm nbs-pat.XXXXXX); scan=$(mktemp -d -p "$NBSHIYAN_DATA_DIR" .scan.XXXXXX)
trap 'rm -f "$pat"; rm -rf "$scan"; stop_builder' EXIT
# The group runs in a pipeline subshell that inherits errexit: a missing file or a no-match grep would end it early (and,
# with pipefail, the whole script silently). Every line therefore ends in `|| true`.
{ [ -f "$APP_ENV_FILE" ] && grep -E "^($SECRET_KEYS_RE)=" "$APP_ENV_FILE" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
  [ -f "$NBSHIYAN_DATA_DIR/secrets/pg_password" ] && cat "$NBSHIYAN_DATA_DIR/secrets/pg_password" || true
  [ -f "$NBSHIYAN_DATA_DIR/secrets/srh.env" ] && sed -n 's/^SRH_TOKEN=//p' "$NBSHIYAN_DATA_DIR/secrets/srh.env" || true
  [ -f "$NBSHIYAN_DATA_DIR/secrets/redis.conf" ] && sed -n 's/^requirepass //p' "$NBSHIYAN_DATA_DIR/secrets/redis.conf" || true
} 2>/dev/null | awk 'length >= 12' | sort -u > "$pat"
[ -s "$pat" ] || log "WARNING: no secret values available yet (run init-secrets.sh first); value scan is vacuous"
for img in "nbshiyan-app:$SHORT" "nbshiyan-migrate:$SHORT"; do
  rm -rf "${scan:?}"/*; cid=$(docker create "$img")
  docker export "$cid" | tar -x -C "$scan" --exclude='proc/*' --exclude='sys/*' --exclude='dev/*'; docker rm -f "$cid" >/dev/null
  # pipefail + errexit: grep exits 1 on ZERO hits (the good case) and find exits 1 if a dir is missing; without the
  # `|| true` inside the pipeline the assignment fails and the script stops silently right after the build.
  hits=0; if [ -s "$pat" ]; then hits=$( { grep -rFla -f "$pat" "$scan" 2>/dev/null || true; } | wc -l); fi
  keyfiles=$( { find "$scan/app" "$scan/opt" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \) ! -name '.env.example' 2>/dev/null || true; } | wc -l)
  log "fs scan $img: $(wc -l < "$pat") secret values, hits=$hits, env/key files=$keyfiles"
  (( hits == 0 && keyfiles == 0 )) || leak=1
done
rm -f "$pat"; rm -rf "$scan"; trap stop_builder EXIT
if (( leak )); then
  docker image rm "nbshiyan-app:$SHORT" "nbshiyan-migrate:$SHORT" >/dev/null || true
  die "leak check failed; images removed. Do not deploy."
fi

# ---------- 7. tags: keep only current + previous (+ this candidate); own repos only ----------
# deploy.sh promotes :candidate → :current and the old :current → :previous.
for repo in nbshiyan-app nbshiyan-migrate; do
  docker tag "$repo:$SHORT" "$repo:candidate"
  keep_ids=$(for t in current previous candidate; do docker image inspect -f '{{.Id}}' "$repo:$t" 2>/dev/null; done | sort -u)
  docker image ls "$repo" --filter label=com.nbshiyan.stack=nbshiyan --format '{{.Repository}}:{{.Tag}}' | while read -r ref; do
    id=$(docker image inspect -f '{{.Id}}' "$ref")
    grep -qxF "$id" <<<"$keep_ids" || { log "removing old own image $ref"; docker image rm "$ref" >/dev/null || true; }
  done
done

# ---------- 8. cleanup: ONLY this builder's cache ----------
docker buildx prune --builder "$BUILDER" --keep-storage "$CACHE_KEEP" --force >/dev/null
docker buildx du --builder "$BUILDER" 2>/dev/null | tail -1 | sed 's/^/[build] builder cache: /' || true   # info only; must not stop before .candidate-sha
stop_builder; log "builder $BUILDER stopped (frees its memory; the next build restarts it, cache kept)"
docker image ls --filter label=com.nbshiyan.stack=nbshiyan --format '[build] image {{.Repository}}:{{.Tag}} {{.Size}}'
for d in "$DOCKER_ROOT" "$NBSHIYAN_DATA_DIR"; do log "free after: $(free_gb "$d") GiB on $(df -P "$d" | awk 'NR==2{print $6}')"; done
echo "$PIN_SHA" > "$NBSHIYAN_DATA_DIR/.candidate-sha"
log "done: nbshiyan-app:$SHORT built and tagged :candidate (deploy.sh promotes it to :current)"
