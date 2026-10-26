# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# PackJoyU / NBshiyan self-host image (Refs #74, deploy plan §11 v1.6).
# Build:  see deploy/README.md. The build context is a clean checkout of a merged commit (never a dirty tree).
#
# Rules (full-stack review):
#   * No secret may enter the build: no secret ARG/ENV, no COPY of .env* (also excluded by .dockerignore).
#     `next build` only needs PUBLIC values. prod-env-check.ts checks only public values in the build phase;
#     every server-side secret is checked at runtime (src/instrumentation.ts, fail closed).
#   * NEXT_PUBLIC_* are inlined into the client bundle, so only public values are allowed in them.
#   * APP_ENV / NODE_ENV / NEXT_PUBLIC_SITE_URL must be the production values AT BUILD TIME, because
#     next.config.ts bakes `X-Robots-Tag: noindex` into routes-manifest unless APP_ENV=production, and
#     canonical/hreflang/sitemap use NEXT_PUBLIC_SITE_URL. The same values are set again at runtime (env file).
#   * Base image pinned by tag AND digest; the CI/ops script fails if the digest does not match.
#   * Requires the backend PR #321 fix/deploy-readiness (checked against bad9379: output: 'standalone', public-only build checks,
#     src/instrumentation.ts startup check, /api/health, STORAGE_DRIVER=local). Before it is merged
#     the COPY of .next/standalone below fails, so this Dockerfile cannot build an older commit by accident.
#   * Schema: 由 db push 应用（不加 --accept-data-loss），由 deploy/deploy.sh 用 migrate 镜像执行，构建期不连任何数据库。

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

############################ base ############################
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm CI=1
# openssl: Prisma engine detection; ca-certificates: outbound HTTPS (Turnstile, R2, mail, Sanity); tini: PID 1
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

############################ deps ############################
FROM base AS deps
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
COPY prisma ./prisma
# postinstall = `prisma generate` (downloads the query engine; network needed at build time only)
RUN --mount=type=cache,id=nbshiyan-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

############################ builder ############################
FROM deps AS builder
# Public build-time values only (fix/deploy-readiness: the build checks only NEXT_PUBLIC_* and the mock switches;
# everything else is checked at startup). APP_ENV is public too and is required at build for the SEO headers.
# Defaults = geiom.com production. Never pass a secret here.
ARG APP_ENV=production
ARG NEXT_PUBLIC_SITE_URL=https://geiom.com
ARG NEXT_PUBLIC_ADMIN_API=http
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG NEXT_PUBLIC_TAWK_PROPERTY_ID=
ARG NEXT_PUBLIC_TAWK_WIDGET_ID=
ARG NEXT_PUBLIC_TAWK_WIDGET_ID_RU=
ARG NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION=
ARG NEXT_PUBLIC_YANDEX_VERIFICATION=
ARG NEXT_PUBLIC_BING_VERIFICATION=
ARG NEXT_PUBLIC_FAQ_JSONLD_ENABLED=
# Admin mail UI / webhook switch (#303, inlined at build): empty until mail goes live, then "http". Never "mock".
ARG NEXT_PUBLIC_ADMIN_MAIL=
# Sanity project id / dataset are public identifiers (used by ISR pages and the sitemap at build)
ARG SANITY_PROJECT_ID=
ARG SANITY_DATASET=production
ENV APP_ENV=${APP_ENV} NODE_ENV=production \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} NEXT_PUBLIC_ADMIN_API=${NEXT_PUBLIC_ADMIN_API} \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_TURNSTILE_SITE_KEY} \
    NEXT_PUBLIC_TAWK_PROPERTY_ID=${NEXT_PUBLIC_TAWK_PROPERTY_ID} NEXT_PUBLIC_TAWK_WIDGET_ID=${NEXT_PUBLIC_TAWK_WIDGET_ID} \
    NEXT_PUBLIC_TAWK_WIDGET_ID_RU=${NEXT_PUBLIC_TAWK_WIDGET_ID_RU} \
    NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION=${NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION} \
    NEXT_PUBLIC_YANDEX_VERIFICATION=${NEXT_PUBLIC_YANDEX_VERIFICATION} \
    NEXT_PUBLIC_BING_VERIFICATION=${NEXT_PUBLIC_BING_VERIFICATION} \
    NEXT_PUBLIC_FAQ_JSONLD_ENABLED=${NEXT_PUBLIC_FAQ_JSONLD_ENABLED} NEXT_PUBLIC_ADMIN_MAIL=${NEXT_PUBLIC_ADMIN_MAIL} \
    SANITY_PROJECT_ID=${SANITY_PROJECT_ID} SANITY_DATASET=${SANITY_DATASET}
COPY . .
ARG PRISMA_VERSION=6.19.3
# The standalone migrate image below installs exactly this prisma version; fail if the lockfile moved.
RUN test "$(node -p "require('./node_modules/prisma/package.json').version")" = "${PRISMA_VERSION}"
# Heap cap keeps the build inside the builder's memory limit (local measurement: ~1.1–1.2 GB RSS main process with the cap).
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm build \
 && rm -rf .next/cache

############################ migrate (one-off tool image, compose profile "tools") ############################
# Standalone prisma CLI (same version as pnpm-lock.yaml, checked above; no app devDependencies) + prisma/schema.prisma only.
# Schema 由 db push 应用（不加 --accept-data-loss）。deploy.sh runs: migrate diff --script (destructive check) → db push --skip-generate
# → migrate diff --exit-code. prisma/sql/*.sql (e.g. 74-mail-backend.sql) is NOT copied and NOT executed.
FROM base AS migrate
ARG PRISMA_VERSION=6.19.3
WORKDIR /opt/migrate
RUN npm install --no-audit --no-fund --no-save "prisma@${PRISMA_VERSION}" \
 && npx --no-install prisma version >/dev/null
# --chmod=644: COPY keeps the source mode, and a checkout made under umask 077 left it root-only 600 (migrate EACCES).
# The parent dir is created first: when COPY --chmod has to create a missing parent, BuildKit gives that dir the same
# file mode (644 → not traversable for uid 1001; the e155bc1 build stopped on the check below). mkdir here = 755.
RUN mkdir -p -m 755 /opt/migrate/prisma
COPY --from=builder --chmod=644 /app/prisma/schema.prisma ./prisma/schema.prisma
USER 1001:1001
ENV HOME=/tmp CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
# Fail the build unless the runtime uid can read the schema and the prisma CLI (GNU find -readable = real access check).
RUN bad=$(find /opt/migrate \( ! -readable -o \( -type d ! -executable \) \) -print 2>&1 | head -n 20) \
 && if [ -n "$bad" ]; then echo "not readable by uid 1001:"; echo "$bad"; exit 1; fi
ENTRYPOINT ["/usr/bin/tini", "--", "npx", "--no-install", "prisma"]
CMD ["--help"]

############################ runner ############################
FROM base AS runner
ENV NODE_ENV=production HOME=/tmp PORT=3000 HOSTNAME=0.0.0.0 UPLOAD_DIR=/data/uploads
# Files are root-owned, read-only for uid 1001. Writable at runtime: /app/.next (tmpfs, see CMD) and /tmp.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# First-admin script: scripts/admin-create.mjs + admin-create-lib.mjs (+ #347 enroll-token-lib.mjs) are traced into standalone by
# outputFileTracingIncludes (fix/deploy-readiness), so the standalone COPY above already ships them. Fail the build if not.
# Same for the read-only #361 deploy-gate count script scripts/admin-2fa-audit*.mjs (deploy/README.md "2FA audit")
# and the unbound-ADMIN initial password reset scripts/admin-reset-initial-password*.mjs (deploy/README.md).
# hardExpiresAt backfill (after prisma db push): scripts/backfill-hard-expires-at.mjs + lib.
RUN test -f scripts/admin-create.mjs && test -f scripts/admin-create-lib.mjs && test -f scripts/enroll-token-lib.mjs \
 && test -f scripts/admin-2fa-audit.mjs && test -f scripts/admin-2fa-audit-lib.mjs \
 && test -f scripts/admin-reset-initial-password.mjs && test -f scripts/admin-reset-initial-password-lib.mjs \
 && test -f scripts/backfill-hard-expires-at.mjs && test -f scripts/backfill-hard-expires-at-lib.mjs
# ISR (/products 1m, /articles 1h), route cache and the image optimizer write under .next/ (verified locally),
# but the root fs is read_only. So the build output is kept in .next-dist and copied into a tmpfs .next at start.
RUN mv .next .next-dist && mkdir .next && chown 1001:1001 .next \
 && mkdir -p /data/uploads && chown 1001:1001 /data/uploads
# Entrypoint: .next is a tmpfs (root fs read_only), so EVERY start — including one-off `compose run app node server.js` —
# first fills it from .next-dist; otherwise server.js exits "Could not find a production build" (a false fail-closed).
COPY --chmod=755 <<'SH' /usr/local/bin/nbshiyan-entrypoint
#!/bin/sh
set -e
[ -f /app/.next/BUILD_ID ] || cp -a /app/.next-dist/. /app/.next/
exec "$@"
SH
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/dawanglaohu/NBshiyan" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      com.nbshiyan.component="app"
USER 1001:1001
# Everything uid 1001 needs must be readable by it: standalone server + traced files, .next-dist (copied into the tmpfs
# .next at start), .next/static, public/ (images, posters, .glb models, draco/basis decoders, fonts). Checked AS uid 1001
# (GNU find -readable). /data/uploads must be owned by 1001 and writable (the host dir mounted over it is 700 1001:1001).
RUN [ "$(id -u)" = 1001 ] && [ "$(stat -c %u /data/uploads)" = 1001 ] && [ -w /data/uploads ] \
 && bad=$(find /app /usr/local/bin/nbshiyan-entrypoint -path /app/.next -prune -o \
          \( ! -readable -o \( -type d ! -executable \) \) -print 2>&1 | head -n 20) \
 && if [ -n "$bad" ]; then echo "not readable by uid 1001:"; echo "$bad"; exit 1; fi
EXPOSE 3000
# /api/health (PR #321): 200 {"ok":true} only if the DB answers SELECT 1 within 1.5 s, else 503 {"ok":false}; 429 above
# 120/min per client (in-process limiter). In-container use only: nginx returns 404 for it externally. No fallback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/nbshiyan-entrypoint"]
CMD ["node", "server.js"]
