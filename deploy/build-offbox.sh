#!/usr/bin/env bash
# Build the NBshiyan images OFF the server (a build host with docker + buildx), from a fresh clone of a pinned, merged
# commit, and package them for deploy/import-and-scan.sh on the server. The build host holds NO production secret:
# only PUBLIC build args (whitelist below). The leak scan that needs the server's secrets runs on the server
# (import-and-scan.sh) against the loaded images; this script only does the secret-free pre-checks.
#
# Usage: PIN_SHA=<40-hex merged commit> PLATFORM=linux/amd64 BUILD_ARGS_FILE=<600 file, public values> OUT_DIR=<dir> \
#        deploy/build-offbox.sh
# Output in OUT_DIR: nbshiyan-images-<sha12>.tar.zst, nbshiyan-images-<sha12>.tar.zst.sha256, nbshiyan-images-<sha12>.manifest
# Touches only: a temp clone (removed), the buildx builder "$BUILDER", images nbshiyan-app:<sha12> / nbshiyan-migrate:<sha12>.
set -Eeuo pipefail
umask 077

: "${PIN_SHA:?set PIN_SHA to a full 40-char commit SHA that is already merged into main}"
: "${PLATFORM:?set PLATFORM to the server platform (docker version -f {{.Server.Os}}/{{.Server.Arch}}), e.g. linux/amd64}"
: "${BUILD_ARGS_FILE:?set BUILD_ARGS_FILE (public build args only)}"
: "${OUT_DIR:?set OUT_DIR}"
REPO_URL="${REPO_URL:-https://github.com/dawanglaohu/NBshiyan.git}"     # public, anonymous HTTPS, no token
BUILDER="${BUILDER:-nbshiyan-offbox}"
# Same pins as build-on-server.sh (same BuildKit release and digest, same syntax frontend, same base image).
BUILDKIT_IMAGE="moby/buildkit:v0.34.0@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c"
BUILDKITD_CONFIG_SHA256="6b46269ff5417a435a9891b0d573860947a0954ad6917db359233c5e9d5a1f7f"
DOCKERFILE_SYNTAX_DIGEST="sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e"
NODE_IMAGE_DIGEST="sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
ZSTD_LEVEL="${ZSTD_LEVEL:-10}"

log() { printf '[offbox %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[offbox] ABORT: %s\n' "$*" >&2; exit 1; }

[[ "$PIN_SHA" =~ ^[0-9a-f]{40}$ ]] || die "PIN_SHA must be a full lowercase 40-hex SHA (never a branch name)"
[[ "$PLATFORM" =~ ^linux/(amd64|arm64)$ ]] || die "PLATFORM must be linux/amd64 or linux/arm64"
SHORT="${PIN_SHA:0:12}"
command -v zstd >/dev/null || die "zstd missing"

# ---------- 0. the build host must not carry production secrets in its environment (names only, never values) ----------
SECRET_NAMES_RE='^(DATABASE_URL|AUTH_SECRET|ADMIN_TOTP_KEY|PRIVACY_HASH_SECRET|CRON_SECRET|MIDDLEWARE_PROBE_SECRET|EDGE_AUTH_SECRET|UPSTASH_REDIS_REST_TOKEN|SRH_TOKEN|SMTP_USER|SMTP_PASS|MAIL_WEBHOOK_SECRET|RESEND_API_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|TURNSTILE_SECRET_KEY|SANITY_API_READ_TOKEN|SANITY_WEBHOOK_SECRET|SANITY_REVALIDATE_SECRET|POSTGRES_PASSWORD)$'
envnames=$(compgen -e)
bad_env=$(grep -E "$SECRET_NAMES_RE" <<<"$envnames" || true)
[ -z "$bad_env" ] || die "a production secret variable is set in this shell: $(tr '\n' ' ' <<<"$bad_env")(unset it; the build needs none)"
mocks=$(grep -E '^NEXT_PUBLIC_[A-Z_]*_MOCK$' <<<"$envnames" || true)
[ -z "$mocks" ] || die "a NEXT_PUBLIC_*_MOCK variable is set in this shell"

# ---------- 1. public build args (same whitelist and checks as build-on-server.sh) ----------
[ -f "$BUILD_ARGS_FILE" ] || die "build-args file missing"
[ "$(stat -c %a "$BUILD_ARGS_FILE")" = 600 ] || die "build-args file must be mode 600"
ALLOWED='^(APP_ENV|NEXT_PUBLIC_SITE_URL|NEXT_PUBLIC_ADMIN_API|NEXT_PUBLIC_TURNSTILE_SITE_KEY|NEXT_PUBLIC_TAWK_PROPERTY_ID|NEXT_PUBLIC_TAWK_WIDGET_ID|NEXT_PUBLIC_TAWK_WIDGET_ID_RU|NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION|NEXT_PUBLIC_YANDEX_VERIFICATION|NEXT_PUBLIC_BING_VERIFICATION|NEXT_PUBLIC_FAQ_JSONLD_ENABLED|NEXT_PUBLIC_ADMIN_MAIL|SANITY_PROJECT_ID|SANITY_DATASET)$'
BARGS=(--build-arg "GIT_SHA=$PIN_SHA")
while IFS= read -r line; do
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  k="${line%%=*}"; v="${line#*=}"
  [[ "$k" =~ $ALLOWED ]] || die "build-args: key $k is not an allowed PUBLIC build arg"
  # passed verbatim: a quote or a CR would be baked into the bundle (e.g. a broken Turnstile site key) → refuse
  if [[ "$v" =~ ^[\"\'] || "$v" == *$'\r' ]]; then die "build-args: $k must be unquoted, LF only"; fi
  BARGS+=(--build-arg "$k=$v")
done < "$BUILD_ARGS_FILE"
barg() { sed -n "s/^$1=//p" "$BUILD_ARGS_FILE" | tail -n 1; }   # no quote stripping: quotes are refused above
has_key() { grep -qE "^$1=" "$BUILD_ARGS_FILE"; }
# forced production values: if the file sets them at all, they must be exactly these (the effective value is checked below)
if has_key APP_ENV; then [ "$(barg APP_ENV)" = production ] || die "build-args: APP_ENV must be production"; fi
if has_key NEXT_PUBLIC_SITE_URL; then [ "$(barg NEXT_PUBLIC_SITE_URL)" = https://geiom.com ] || die "build-args: NEXT_PUBLIC_SITE_URL must be exactly https://geiom.com"; fi
tsk=$(barg NEXT_PUBLIC_TURNSTILE_SITE_KEY)
[ -n "$tsk" ] || die "build-args: NEXT_PUBLIC_TURNSTILE_SITE_KEY missing"
[[ "$tsk" =~ ^[123]x0{20,}[A-Z]{2}$ ]] && die "build-args: NEXT_PUBLIC_TURNSTILE_SITE_KEY is a Cloudflare test key"
aapi=$(barg NEXT_PUBLIC_ADMIN_API); [ -z "$aapi" ] || [ "$aapi" = http ] || die "build-args: NEXT_PUBLIC_ADMIN_API must be http"
amail=$(barg NEXT_PUBLIC_ADMIN_MAIL); [ "$amail" != mock ] || die "build-args: NEXT_PUBLIC_ADMIN_MAIL=mock is not allowed"
mockkeys=$(grep -iE '^NEXT_PUBLIC_[A-Z_]*_MOCK=' "$BUILD_ARGS_FILE" || true); [ -z "$mockkeys" ] || die "mock switches are not allowed"

# ---------- 2. fresh clone at the pinned, merged commit ----------
mkdir -p "$OUT_DIR"; OUT_DIR=$(readlink -f "$OUT_DIR")
WORK=$(mktemp -d); SRC="$WORK/src"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
( umask 022
  git clone --quiet --no-checkout "$REPO_URL" "$SRC" || die "git clone failed"
  git -C "$SRC" cat-file -e "${PIN_SHA}^{commit}" 2>/dev/null || die "commit $SHORT not found on origin"
  git -C "$SRC" merge-base --is-ancestor "$PIN_SHA" origin/main || die "commit $SHORT is not merged into main"
  git -C "$SRC" -c advice.detachedHead=false checkout --quiet --detach "$PIN_SHA" || die "checkout failed"
) || die "fresh clone of $SHORT failed"
[ "$(git -C "$SRC" rev-parse HEAD)" = "$PIN_SHA" ] || die "HEAD mismatch"
st=$(git -C "$SRC" status --porcelain --ignored) || die "git status failed"
[ -z "$st" ] || die "work tree not clean (incl. ignored files)"
case "$OUT_DIR/" in "$SRC"/*) die "OUT_DIR must not be inside the clone" ;; esac
envfiles=$(find "$SRC" -path "$SRC/.git" -prune -o \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name 'id_rsa*' \) ! -name '.env.example' -print)
[ -z "$envfiles" ] || die "the clone contains env/key files: $(tr '\n' ' ' <<<"${envfiles//"$SRC/"/}")"
log "source: $SHORT fresh clone, clean ($(git -C "$SRC" log -1 --format=%cI))"

# ---------- 3. static Dockerfile checks (same as build-on-server.sh) + ARG whitelist ----------
DF="$SRC/Dockerfile"
[ -f "$DF" ] && [ -f "$SRC/.dockerignore" ] || die "Dockerfile/.dockerignore missing"
grep -q "$NODE_IMAGE_DIGEST" "$DF" || die "Dockerfile base image digest is not the reviewed one"
[ "$(head -n 1 "$DF")" = "# syntax=docker/dockerfile:1.7@$DOCKERFILE_SYNTAX_DIGEST" ] || die "Dockerfile syntax frontend is not pinned to the reviewed digest"
[ "$(sha256sum < "$SRC/deploy/buildkitd.toml" | cut -c1-64)" = "$BUILDKITD_CONFIG_SHA256" ] || die "deploy/buildkitd.toml is not the reviewed file (sha256)"
{ grep -qE '^\.env$' "$SRC/.dockerignore" && grep -qE '^\.env\.\*$' "$SRC/.dockerignore"; } || die ".dockerignore must exclude .env*"
secret_args=$(grep -nE '^\s*(ARG|ENV)\s+[A-Z_]*(SECRET|TOKEN|PASSWORD|_KEY|DATABASE_URL)' "$DF" | grep -vE 'NEXT_PUBLIC_|SITE_KEY' || true)
[ -z "$secret_args" ] || die "secret-like ARG/ENV in Dockerfile"
copy_env=$(grep -nE '^\s*COPY\s+.*\.env' "$DF" || true); [ -z "$copy_env" ] || die "Dockerfile copies an env file"
# Every ARG the Dockerfile declares must be a known public one (a new ARG needs a review of this list first).
KNOWN_ARGS='^(NODE_IMAGE|PRISMA_VERSION|GIT_SHA|APP_ENV|NEXT_PUBLIC_SITE_URL|NEXT_PUBLIC_ADMIN_API|NEXT_PUBLIC_TURNSTILE_SITE_KEY|NEXT_PUBLIC_TAWK_PROPERTY_ID|NEXT_PUBLIC_TAWK_WIDGET_ID|NEXT_PUBLIC_TAWK_WIDGET_ID_RU|NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION|NEXT_PUBLIC_YANDEX_VERIFICATION|NEXT_PUBLIC_BING_VERIFICATION|NEXT_PUBLIC_FAQ_JSONLD_ENABLED|NEXT_PUBLIC_ADMIN_MAIL|SANITY_PROJECT_ID|SANITY_DATASET)$'
args=$(sed -nE 's/^[[:space:]]*ARG[[:space:]]+([A-Za-z_][A-Za-z0-9_]*).*/\1/p' "$DF" | sort -u)
unknown=$(grep -vE "$KNOWN_ARGS" <<<"$args" || true)
[ -z "$unknown" ] || die "Dockerfile declares ARGs not on the reviewed public list: $(tr '\n' ' ' <<<"$unknown")"
log "dockerfile ok: pins verified, $(wc -l <<<"$args") ARGs all on the public list"
# Effective value of every public build ARG = the build-args value if the key is present, else the Dockerfile default.
# Its sha256 is recorded as a label so import-and-scan.sh can compare it with the server's build-args.env + Dockerfile.
df_default() { sed -nE "s/^ARG $1(=(.*))?\$/\2/p" "$DF" | head -n 1; }
EFF_LBL=()
PUBLIC_ARGS=(APP_ENV NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_ADMIN_API NEXT_PUBLIC_TURNSTILE_SITE_KEY NEXT_PUBLIC_TAWK_PROPERTY_ID NEXT_PUBLIC_TAWK_WIDGET_ID NEXT_PUBLIC_TAWK_WIDGET_ID_RU NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION NEXT_PUBLIC_YANDEX_VERIFICATION NEXT_PUBLIC_BING_VERIFICATION NEXT_PUBLIC_FAQ_JSONLD_ENABLED NEXT_PUBLIC_ADMIN_MAIL SANITY_PROJECT_ID SANITY_DATASET)
[ "^($(IFS='|'; echo "${PUBLIC_ARGS[*]}"))\$" = "$ALLOWED" ] || die "internal: PUBLIC_ARGS and ALLOWED differ"
for k in "${PUBLIC_ARGS[@]}"; do
  grep -qE "^ARG $k(=|$)" "$DF" || die "Dockerfile has no ARG $k"
  if has_key "$k"; then eff=$(barg "$k"); else eff=$(df_default "$k"); fi
  case "$k" in
    APP_ENV) [ "$eff" = production ] || die "effective APP_ENV is not production" ;;
    NEXT_PUBLIC_SITE_URL) [ "$eff" = https://geiom.com ] || die "effective NEXT_PUBLIC_SITE_URL is not https://geiom.com" ;;
    NEXT_PUBLIC_ADMIN_API) [ "$eff" = http ] || die "effective NEXT_PUBLIC_ADMIN_API is not http" ;;
  esac
  EFF_LBL+=(--label "com.nbshiyan.buildarg.$k=sha256:$(printf '%s' "$eff" | sha256sum | cut -c1-64)")
done

# ---------- 4. builder: dedicated docker-container builder on the pinned BuildKit ----------
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container --driver-opt "image=$BUILDKIT_IMAGE" >/dev/null
fi
bk=$(docker buildx inspect --bootstrap "$BUILDER") || die "builder bootstrap failed"
grep -qE '^BuildKit version:[[:space:]]+v0\.34\.0$' <<<"$bk" || die "builder $BUILDER is not BuildKit v0.34.0"

# ---------- 5. build (runner + migrate) for the server platform ----------
LBL=(--label com.nbshiyan.stack=nbshiyan --label "org.opencontainers.image.revision=$PIN_SHA" "${EFF_LBL[@]}")
t0=$(date +%s)
for target in runner migrate; do
  repo=$([ $target = runner ] && echo nbshiyan-app || echo nbshiyan-migrate)
  log "building $repo:$SHORT for $PLATFORM"
  docker buildx build --builder "$BUILDER" --platform "$PLATFORM" --pull --load --provenance=false --sbom=false \
    -f "$DF" --target "$target" -t "$repo:$SHORT" "${LBL[@]}" "${BARGS[@]}" "$SRC"
done
log "build time: $(( $(date +%s) - t0 ))s"

# ---------- 6. secret-free pre-checks (the value scan runs on the server) ----------
ENV_OK='PATH|NODE_VERSION|YARN_VERSION|NEXT_TELEMETRY_DISABLED|PNPM_HOME|CI|NODE_ENV|HOME|PORT|HOSTNAME|UPLOAD_DIR|CHECKPOINT_DISABLE|PRISMA_HIDE_UPDATE_MESSAGE'
for img in "nbshiyan-app:$SHORT" "nbshiyan-migrate:$SHORT"; do
  [ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$img")" = "$PLATFORM" ] || die "$img is not $PLATFORM"
  [ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")" = "$PIN_SHA" ] || die "$img revision label mismatch"
  envk=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$img" | cut -d= -f1)
  bad=$(grep -vxE "$ENV_OK" <<<"$envk" | grep -v '^$' || true)
  [ -z "$bad" ] || die "$img has unexpected ENV keys: $(tr '\n' ' ' <<<"$bad")"
  hist=$(docker history --no-trunc --format '{{.CreatedBy}}' "$img") || die "docker history $img failed"
  if grep -Eiq '(DATABASE_URL|[A-Z_]*(SECRET|TOKEN|PASSWORD))=' <<<"$hist"; then die "secret-like assignment in docker history of $img"; fi
  cid=$(docker create "$img")
  files=$(docker export "$cid" | tar -t) || { docker rm -f "$cid" >/dev/null; die "export $img failed"; }
  docker rm -f "$cid" >/dev/null
  kf=$(grep -E '^(app|opt)/.*(/\.env(\.[^/]*)?|\.pem|\.key)$' <<<"$files" | grep -vE '/\.env\.example$' || true)
  [ -z "$kf" ] || die "$img contains env/key files: $(head -n 5 <<<"$kf" | tr '\n' ' ')"
  log "precheck ok: $img ($(docker image inspect -f '{{.Size}}' "$img") bytes)"
done

# ---------- 7. package: one tar (shared layers stored once), zstd, sha256, manifest of expected IDs ----------
base="nbshiyan-images-$SHORT"; tarz="$OUT_DIR/$base.tar.zst"
docker save "nbshiyan-app:$SHORT" "nbshiyan-migrate:$SHORT" | zstd -q -T0 -"$ZSTD_LEVEL" -o "$tarz" -f
( cd "$OUT_DIR" && sha256sum "$base.tar.zst" > "$base.tar.zst.sha256" )
# Expected IDs after `docker load`: the config digest (classic image store) and the manifest digest (containerd image
# store: `docker image inspect .Id` is the manifest digest). Both are read from the tar itself.
idx=$(zstd -dcq "$tarz" | tar -xO index.json)
digest_for() {  # digest_for <repo:tag> → manifest digest of that tag in index.json (one line per manifest entry)
  local split=${idx//'},{"mediaType"'/$'}\n{"mediaType"'}
  grep -F "\"io.containerd.image.name\":\"docker.io/library/$1\"" <<<"$split" | grep -oE '"digest":"sha256:[0-9a-f]{64}"' | cut -d'"' -f4 || true
}
{
  echo "PIN_SHA=$PIN_SHA"
  echo "PLATFORM=$PLATFORM"
  echo "TARBALL=$base.tar.zst"
  echo "TARBALL_SHA256=$(cut -c1-64 "$OUT_DIR/$base.tar.zst.sha256")"
  echo "TAR_BYTES=$(zstd -dcq "$tarz" | wc -c)"
  echo "APP_TAG=nbshiyan-app:$SHORT"
  echo "APP_CONFIG_ID=$(docker image inspect -f '{{.Id}}' "nbshiyan-app:$SHORT")"
  echo "APP_MANIFEST_DIGEST=$(digest_for "nbshiyan-app:$SHORT")"
  echo "MIGRATE_TAG=nbshiyan-migrate:$SHORT"
  echo "MIGRATE_CONFIG_ID=$(docker image inspect -f '{{.Id}}' "nbshiyan-migrate:$SHORT")"
  echo "MIGRATE_MANIFEST_DIGEST=$(digest_for "nbshiyan-migrate:$SHORT")"
} > "$OUT_DIR/$base.manifest"
m=$(cat "$OUT_DIR/$base.manifest")
grep -qE '^TAR_BYTES=[0-9]+$' <<<"$m" || die "manifest: TAR_BYTES missing"
for k in APP_CONFIG_ID APP_MANIFEST_DIGEST MIGRATE_CONFIG_ID MIGRATE_MANIFEST_DIGEST; do
  grep -qE "^$k=sha256:[0-9a-f]{64}$" <<<"$m" || die "manifest: $k missing or not a single sha256"
done
chmod 644 "$tarz" "$OUT_DIR/$base.tar.zst.sha256" "$OUT_DIR/$base.manifest"
log "packaged: $base.tar.zst ($(stat -c %s "$tarz") bytes), sha256 + manifest written"
log "done: copy the three files to the server and run deploy/import-and-scan.sh (merged version) there"
