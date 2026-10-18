# Self-host deployment (Docker Compose)

Production runs as one compose project, `nbshiyan`: app (Next.js standalone, uid 1001, local uploads at `UPLOAD_DIR`), Postgres 17, Redis 7, and an
Upstash-compatible REST proxy (SRH) behind an internal TLS terminator. Only `127.0.0.1:3000` is published. The host's
reverse proxy terminates public TLS, adds `X-Edge-Auth` and forwards to it.

## Rules
- **Builds carry no secrets.** `next build` only gets public build args (`APP_ENV=production`, `NEXT_PUBLIC_*`,
  `SANITY_PROJECT_ID/DATASET`). All server-side secrets are read at runtime from the env file given by
  `NBSHIYAN_APP_ENV_FILE` (root 600). `src/instrumentation.ts` re-runs the production env check at start and exits if anything is missing.
- **Build input:** a full 40-character commit SHA that is already merged into `main`, never a branch name.
- **Base images** are pinned by tag and digest, and so is the Dockerfile syntax frontend
  (`docker/dockerfile:1.7@sha256:a57df69d…a33e`, the 1.7 = 1.7.1 index). `build-on-server.sh` refuses any other first line.
- **Registry mirrors (builder only):** the server cannot reach `registry-1.docker.io`. dockerd uses its own
  `registry-mirrors`, but the dedicated `docker-container` builder runs its own BuildKit and ignores them, so it is created
  with the reviewed `deploy/buildkitd.toml` (the same three docker.io mirrors). Mirrors never weaken integrity: everything
  the build pulls is pinned by digest and BuildKit verifies content digests.
- **Cleanup is scoped to NBshiyan:** only its own buildx builder cache and its own images (`nbshiyan-app`,
  `nbshiyan-migrate`; keep `:current` and `:previous`). Never `docker system/image/volume prune`.
- **Never run `docker compose config`.** It expands `env_file` and would print secrets.
- **Checkout permissions:** `build-on-server.sh` keeps umask 077 globally (logs, scan dir, pattern file, markers) but clones,
  checks out and cleans `$NBSHIYAN_DATA_DIR/src` in a `( umask 022; … )` subshell, repairs an older 077 checkout to at most
  644/755 (`.git` excluded) and then aborts unless every checked-out file is other-readable and nothing is group/other-writable.
  Reason: non-root containers read it (migrate uid 1001 via COPY, srh-tls uid 101 via the `nginx.conf` bind mount). The
  Dockerfile also checks, as uid 1001, that everything under `/app` and `/opt/migrate` is readable. Secrets and keys are
  never in the checkout and keep their own modes (`.env` 600, `redis-rest.key` 640 root:101, `pg_password` 400 uid 70).

## Files
| file | purpose |
|---|---|
| `../Dockerfile`, `../.dockerignore` | multi-stage build: deps → builder → runner (standalone) and migrate (standalone prisma 6.19.3 CLI + schema.prisma) |
| `docker-compose.yml` | stack definition and hardening (read_only, cap_drop ALL, no-new-privileges, pids/mem limits) |
| `env.template` | every runtime variable, no values: who supplies it, whether it's a secret, whether prod requires it |
| `init-secrets.sh` | one-time: creates data dirs and generates secrets on the host; never overwrites, never prints |
| `build-on-server.sh` | pinned-SHA build in a memory-capped dedicated builder; disk/memory gates; leak checks; tag rotation; stops the builder when done |
| `buildkitd.toml` | reviewed BuildKit config of `nbshiyan-builder`: docker.io mirrors only. Its sha256 is pinned in `build-on-server.sh` |
| `plan-check.sh`, `tests/plan-check.test.sh` | destructive-change gate for the schema plan (sourced by `deploy.sh`) and its tests (`bash deploy/tests/plan-check.test.sh`, no docker/DB needed) |
| `smoke-lib.sh`, `tests/smoke.test.sh` | redirect/header smoke rules (`loc_bad`, `hdr_leak`, `root_redirect_ok`) used by `deploy.sh`, and their tests |
| `env-check.sh`, `tests/env-check.test.sh` | `env_prod_ok` (APP_ENV, NODE_ENV, APP_ORIGIN, NEXT_PUBLIC_SITE_URL, HOSTNAME) and the compose `HOSTNAME` check, sourced by `deploy.sh`, and their tests |
| `deploy.sh` | pg_dump → schema plan + destructive check → `db push` → drift check → start → post-deploy checks → auto-rollback |
| `build-offbox.sh`, `tests/build-offbox.test.sh` | build both images OFF the server (fresh clone at the pinned SHA, explicit `--platform`, same pins, public build args only), secret-free pre-checks, `docker save` → `.tar.zst` + `.sha256` + `.manifest` (expected IDs) |
| `import-and-scan.sh`, `tests/import-scan.test.sh` | ON the server: `sha256sum -c`, tar content check (only our two tags) → `docker load` → IDs / platform / revision label → leak scan with the server's secrets → production build checks → only then `:candidate` + `.candidate-sha`; the transferred files are always removed |
| `mem-check.sh`, `tests/mem-check.test.sh` | `mem_ok` (sourced by `deploy.sh up` before anything starts): MemAvailable ≥ compose `mem_limit` of the services that still have to start (+ migrate next to a running app) + `MEM_RESERVE_MB` (256) |
| `backup-postgres.sh`, `cron.nbshiyan` | daily `pg_dump -Fc` (7 daily + 4 weekly) and the cleanup cron run inside the container |

## Builder (`nbshiyan-builder`)
- Created by `build-on-server.sh` with `--buildkitd-config deploy/buildkitd.toml` (from the pinned checkout; the script
  checks its sha256 first). The sha256 the builder was created with is kept in `$NBSHIYAN_DATA_DIR/.builder-config-sha256` (600).
- If the builder exists but was created with no or another config (no marker / different sha256), the script runs
  `docker buildx rm nbshiyan-builder` (**only this builder**, its cache goes with it) and recreates it. Nothing else is removed.
- After bootstrap it reads `/etc/buildkit/buildkitd.toml` inside `buildx_buildkit_nbshiyan-builder0` and aborts unless all
  three mirrors are there (content check; buildx re-serializes the toml with single quotes, e.g.
  `[registry.'docker.io']` / `mirrors = ['docker.1ms.run', …]`, so the hash would differ; both quote styles are accepted).
- The builder is stopped (`docker buildx stop nbshiyan-builder`) after every run, successful or not, so it holds no memory
  between builds. The next build restarts it; the cache (capped at `CACHE_KEEP`) is kept.

## Schema changes (final: `prisma db push`)
The repo uses `prisma db push` and has no `prisma/migrations`. `prisma/sql/*.sql` files, including
`74-mail-backend.sql`, are **not** executed by this deployment.
`deploy.sh up` runs these steps on the server, in this order:
1. **Backup.** `pg_dump -Fc` of the NBshiyan DB.
2. **Plan.** `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`
   writes the plan to a local 600 file. `plan-check.sh` parses it **by statement** (split on `;`, string literals and
   `--` comments removed first), not by line. For `ALTER TABLE` on a table that already exists, it also checks each
   `,`-separated clause on its own, with parentheses collapsed and quoted identifiers blanked, so `"isDefault"` or
   `"default"` never counts as a `DEFAULT`. It is case-insensitive and fails closed. The deploy **stops for full-stack review** on:
   - anywhere: `DROP`, `RENAME`, `TRUNCATE`, `DELETE FROM`, `ALTER … TYPE`, `SET NOT NULL`, or any statement it doesn't recognise;
   - on tables that already exist (not `CREATE TABLE`d in the same plan): `CREATE UNIQUE INDEX`, `ADD CONSTRAINT` or an
     inline key/`REFERENCES`/`CHECK`, or any clause with `NOT NULL` and no `DEFAULT`.

   **Continuing after review:** rerun with `APPROVED_PLAN_SHA256=<sha256 printed by the aborted run>`. The deploy goes on
   only if the newly generated plan has exactly that sha256. If the DB or the schema changed in between, the sha differs
   and the deploy stops again. The approval opens only *our* gate: `db push` still runs without `--accept-data-loss`, so
   prisma still refuses data-loss changes on its own. **Never run `prisma db push --accept-data-loss` (or any manual
   prisma/psql DDL) by hand.** A change that loses data needs a backend-written, reviewed migration plan instead.
3. **Push.** `prisma db push --skip-generate`, never with `--accept-data-loss`.
4. **Drift check.** The same diff with `--exit-code` must return 0, otherwise the app is not started.

How credentials and output are handled:
- `DATABASE_URL` comes only from the migrate service's `env_file`. It is never on argv and never printed, and `--from-url` is never used.
- `db push` output and the stderr of both `migrate diff` runs contain the DB host, port and name. All of it goes through
  `redact` into a local 600 log, which is never posted.

The ordering lives in `deploy.sh` instead of `depends_on: service_completed_successfully`. A dependency in an inactive
profile behaves differently across compose versions, and the review gate sits between two migrate runs.

## First admin (after the first successful deploy)
Run this on the server, as Ryan or with Ryan at the keyboard. The password is read from a **hidden prompt**: never
pass it as an argument, an exported env var, or `-e ADMIN_CREATE_PASSWORD` (it would show in `docker inspect`); a hidden prompt or stdin only. The final steps follow runbook §4.1–4.3 once `fix/deploy-readiness` is merged.
```sh
DC="docker compose -p nbshiyan -f deploy/docker-compose.yml --env-file $NBSHIYAN_COMPOSE_ENV"
# standalone image: there is no pnpm, so use the node form, inside the running app container (it has the env and the DB network)
$DC exec -it app node scripts/admin-create.mjs --email <admin email>
# equivalent one-off container (does not publish ports):
$DC run --rm -it --no-deps app node scripts/admin-create.mjs --email <admin email>
```
Options (#321): `--name <display name>`, plus `--allow-additional-admin`, needed for any admin after the first (otherwise it
refuses with `admin_exists`). Any flag that looks like a password (`--password`, `-p`, …) is refused. With no TTY the
script reads the first line of stdin. With `APP_ENV=production`, `ADMIN_CREATE_PASSWORD` is refused.
`pnpm admin:seed` (the old create-admin with the `PROD_DATABASE_HOST` guard) is CI/local only: never run seed on the server. After creating the
account, log in at `/admin` and **bind 2FA immediately**. `ADMIN_SEED_TOTP_SECRET` is never set in production.

## Reset the initial password of an unbound ADMIN (queue ②, until #347's one-time enroll token ships)
For an ADMIN who has **not** bound 2FA yet (lost initial password, or stuck half-way through enroll). Run it on the
server, as Ryan or with Ryan at the keyboard; it ships in the image like admin-create. The new password comes only from a
**hidden prompt** (typed twice) or the first line of stdin. Arguments that look like a password are refused;
`ADMIN_RESET_PASSWORD` / `ADMIN_CREATE_PASSWORD` are deleted at start-up and never read. Never post the password in a group chat.
```sh
DC="docker compose -p nbshiyan -f deploy/docker-compose.yml --env-file $NBSHIYAN_COMPOSE_ENV"
$DC exec -it app node scripts/admin-reset-initial-password.mjs --email <admin email>            # or --id <user id>
$DC exec -it app node scripts/admin-reset-initial-password.mjs --email <admin email> --clear-pending-enroll
```
- Refused (exit 3, nothing changed): not found, role is not ADMIN, account disabled, **2FA already enabled (no flag bypasses this)**.
- A pending enroll (pending secret, cooldown, wrong-code count, `enrollIssuedAt` set) or a closed 72 h enroll window is refused
  unless `--clear-pending-enroll` is given; the flag clears the pending state and reopens the 72 h window (same fields as an ADMIN 2FA reset).
- One transaction: new argon2id hash (same parameters as login), all sessions revoked (`sessionVersion`+1), lockout cleared,
  audit `user.password_reset` (+ `user.pending_enroll_cleared`) with actor `cli` and the user id only (no password, hash, secret or email).
- After commit it deletes only the account-scoped rate-limit keys whose names it can compute: `login-acct:<e>`,
  `login:untrusted:<e>` and `enroll-confirm:untrusted:<e>`, current and previous window (Upstash only; one DEL, no SCAN/KEYS).
  `login-ip` and real-IP buckets (`login:<ip>:<e>`, `enroll-confirm:<ip>:<e>`) are left alone and expire within 10 minutes.
- Exit codes: 0 ok, 1 runtime error (DB, no password, weak password), 2 bad arguments, 3 refused. Output shows the user id only.

## 2FA audit (deploy gate for #361, before `deploy.sh up`)
#361 closes the 2FA enroll window 72 h after `enrollIssuedAt` (set by an ADMIN 2FA reset) or, if empty, `createdAt`.
An ADMIN still unbound after that can no longer enroll and needs another ADMIN to reset 2FA. Before promoting a candidate
that contains #361, count them with the read-only script that ships in the image (same window rule as
`src/lib/server/admin/enroll-guard.ts`). Run it in a one-off container of the **candidate** image (the running `:current`
image predates the script); it uses the app's own `DATABASE_URL` from the env file and `@prisma/client`, publishes no port
and takes no arguments:
```sh
DC="docker compose -p nbshiyan -f deploy/docker-compose.yml --env-file $NBSHIYAN_COMPOSE_ENV"
APP_TAG=candidate $DC run --rm -T --no-deps app node scripts/admin-2fa-audit.mjs
# (once the image is current, inside the running container: $DC exec -T app node scripts/admin-2fa-audit.mjs)
```
Output is exactly two lines, numbers only (never an email, id or name):
```
admins=<n>
unbound_over_72h=<n>
```
`admins` = enabled (not disabled) ADMIN accounts; `unbound_over_72h` = those with 2FA not bound and the 72 h window closed.
Before the #361 `db push` the `enrollIssuedAt` column does not exist yet; the script then counts on `createdAt` only, which
is exactly what #361 will see after the push (the new column starts empty). On any failure it prints only
`error=audit_failed` to stderr and exits 1 (no error text, query or connection string); any argument → `error=no_args_accepted`, exit 2.
Report only the two numbers. If `unbound_over_72h` > 0 and it equals `admins`, nobody could reset them after the deploy:
bind 2FA first (or have another ADMIN reset it right after the deploy), then deploy.

## Health endpoint
`/api/health` (PR #321) returns:
- `200 {"ok":true}` only when the DB answers `SELECT 1` within 1.5 s;
- `503 {"ok":false}` otherwise;
- `429` above 120 requests/min per client. This is its own in-process limiter, not Redis.

It never returns a version or config. It is for the container healthcheck only, and it runs a DB query, so the public
nginx site returns `404` for `/api/health` and `/api/health/…`. There is **no** `/robots.txt` fallback: the image requires
#321, and `deploy.sh` treats any body other than `{"ok":true}` as a failed deploy, which triggers a rollback. After the
DNS cutover, check that `/api/health`, `/api/health?x=1`, `/api/health/` and `/api/health/x` all return 404, while
`/api/healthz` and other `/api/*` still reach the app (nginx: `location = /api/health` + `location ^~ /api/health/`).

## First deploy on the server: run each item and report the result
These can't be verified off the server, because the box has no docker and no real DB.
1. **Compose version:** `docker compose version` must support `up --wait` (Compose v2.17 or later). `deploy.sh` uses `up -d --wait postgres redis srh srh-tls`.
2. **Required env values:** `deploy.sh` refuses to start unless the app env file has `APP_ENV=production` and
   `NODE_ENV=production`, each exactly once. `init-secrets.sh` forces both. Without runtime `APP_ENV`, the startup check is skipped entirely.
3. **srh-net isolation:** from inside the app container, `srh` and `redis` must not resolve. `deploy.sh` checks this with `node -e "dns.lookup(...)"`.
   Only `redis-rest` (srh-tls on `backend`) is reachable.
4. **Internal TLS:**
   - `openssl x509 -in internal-tls/ca.crt -noout -ext nameConstraints` shows `permitted DNS:redis-rest`, and `internal-tls/` contains no CA key.
   - A Node TLS 1.3 handshake from the app container to `https://redis-rest:8443/pipeline` works with the CA (`NODE_EXTRA_CA_CERTS`).
   - Rate-limited routes work, i.e. no 503 caused by the Redis store.
5. **Real-DB schema plan:** the plan generated against the real (empty, first-deploy) DB passes `plan-check.sh` with no
   problems, and the drift check after `db push` exits 0. Report the plan's line count and sha256, never its connection details.
6. **Leak scan with real values:** `build-on-server.sh`'s image filesystem/history scan, using the values that `init-secrets.sh`
   generated on the server, must report `hits=0` for both images.
7. **Ports:** `ss -lntH` shows nothing new on 5432 or 6379, and 3000 is bound only on 127.0.0.1. Only `app` publishes a port.
8. **Startup fails closed:** `deploy.sh` runs exactly `docker compose … run --rm --no-deps -e SMTP_PORT=25 app node server.js`
   (plus `-T` and a container name, because it runs without a TTY) on the candidate image.
   - It must exit 1, and the output must name only variables (`SMTP_PORT …`), not a "no production build" error.
   - `SMTP_PORT=25` is a non-secret invalid value. **Never blank a secret or pass any secret with `-e`.**
   - The output goes to a 600 temp file created with `mktemp -p` inside the 700 root-only `secrets/` dir, never in `/tmp`.
     It is scanned for every secret value (0 hits required) and removed when the function returns, with an EXIT/INT/TERM
     trap as fallback (tested). It is never printed.
   - This works because the image entrypoint fills the `.next` tmpfs from `.next-dist` on every start, including one-off `run … node server.js`.
9. **First rollback:** if post-checks fail on the very first deploy, there is no `:current` / `:previous` image. Rollback then stops the app container and aborts.

## Post-deploy smoke tests through nginx (after DNS/CF cutover; nginx files are final)
Run these from outside, through Cloudflare. `deploy.sh` also runs the local equivalents against 127.0.0.1:3000 with
`Host: geiom.com` (with `HOSTNAME=0.0.0.0`, Next emits a relative Location).
```sh
curl -sI https://geiom.com/          # 307/308, Location: /en or https://geiom.com/en (no localhost, no :port)
curl -sI https://geiom.com/ru        # 200, or a redirect that stays on https://geiom.com
curl -sI https://geiom.com/admin     # redirect to the sign-in page on geiom.com (proxy_redirect regex rewrites localhost/127.0.0.1/0.0.0.0 targets)
for u in / /ru /admin; do curl -sI "https://geiom.com$u" | grep -qi localhost && echo "FAIL $u header mentions localhost"; done
curl -sI 'https://geiom.com//evil.com'       # 308, Location /evil.com (on site; relative or https://geiom.com/...)
curl -sI 'https://geiom.com//evil.com/'      # 308, Location /evil.com/
curl -sI 'https://geiom.com/\evil.com'       # 308, Location /evil.com
curl -sI 'https://geiom.com/%2F%2Fevil.com'  # 404
curl -sI 'https://geiom.com/%5C%5Cevil.com'  # 404
curl -sI https://geiom.com/s/nbshiyan-smoke-probe | grep -qiE 'localhost|127\.0\.0\.1|0\.0\.0\.0' && echo "FAIL /s/ rewrite leaks"
for u in /api/health '/api/health?x=1' /api/health/ /api/health/x; do curl -s -o /dev/null -w "%{http_code} $u\n" "https://geiom.com$u"; done   # all 404
curl -s -o /dev/null -w '%{http_code}\n' https://geiom.com/api/healthz   # reaches the app (its 404 page, not nginx's)
```
Rules, the same as `smoke-lib.sh`. In `deploy.sh`, any of these fails the deploy and triggers a rollback:
- Any **5xx** on `/`, `/ru`, `/admin`, `/s/nbshiyan-smoke-probe` or the five `evil.com` probes is a FAIL. Expected from the
  app (backend PR #328): `/` → 307 `/en`; `//evil.com`, `//evil.com/`, `/\evil.com` → 308 to on-site `/evil.com[/]`;
  `/%2F%2Fevil.com`, `/%5C%5Cevil.com` → 404. Without a DB `/api/health` is 503 (expected; the healthcheck then fails).
- `/` must be a **3xx**. At app level (`deploy.sh`, 127.0.0.1:3000) the Location must be **exactly `/en`**. On the public
  post-DNS check, `/en` or `https://geiom.com/en` are both accepted.
- `loc_bad` is an allow-list: a Location passes only if it is empty, a same-site path (`/` or `/x…` with the second char
  not `/` or `\`), or `https://geiom.com` optionally followed by such a path. Anything else fails: any backslash, any
  whitespace/control char, `//` / `/\` prefixes (also after `https://geiom.com`), other hosts, ports, schemes, userinfo.
  `/evil.com/` and `https://geiom.com/evil.com/` are fine: they're paths on geiom.com.
- No response header (including `x-middleware-rewrite`) may contain `localhost`, `127.0.0.1` or `0.0.0.0`. Local observation on PR #321 (bad9379): with `HOSTNAME=127.0.0.1`, `/` answers
`Location: https://localhost:<port>/en`, so the nginx `proxy_redirect` regex is needed, and compose keeps
`HOSTNAME=0.0.0.0`. With `HOSTNAME=127.0.0.1` the `/s/*` rewrite also leaks localhost in `x-middleware-rewrite`, so
compose hardcodes `HOSTNAME: "0.0.0.0"` for `app`, `env_prod_ok` fails if compose doesn't or if the env file sets HOSTNAME
to anything else, and post-checks verify the running container's HOSTNAME. `/%2F%2Fevil.com` answered **500** on bad9379;
fixed in backend PR #328 (now 404).

## Review notes
- The schema plan gate (`plan-check.sh`) refuses an empty or unreadable plan. Prisma's no-diff output is `-- This is an empty migration.`, which passes.
  It also sends anything its lexer can't handle safely to manual review: `E''` strings, `$$`/`$tag$`, `/* */`, backslashes,
  multi-line strings, and identifiers containing `'`, `;` or `--`. On existing tables only `ADD COLUMN` and
  `ALTER COLUMN … SET DEFAULT` clauses are allowed. `CREATE TABLE IF NOT EXISTS` does not count as a new table.
- **Never run `docker compose config` for this project.** It prints the resolved `env_file` values, which are secrets.
  Use `docker compose ps` and `docker inspect --format` on specific fields instead.
- The build carries no secrets: no secret `ARG`/`ENV`, no `.env` in the context. After every build, `build-on-server.sh`
  scans `docker history`, the image ENV and both image filesystems (including `/app/.next-dist`) for every secret
  value. The required result is 0 hits.
- Networks: `edge` (app egress + 127.0.0.1:3000), `backend` (internal: app, postgres, srh-tls as `redis-rest`, migrate),
  `srh-net` (internal: **only** srh, srh-tls, redis). The app is not on `srh-net`, so it can't resolve or reach
  `http://srh:80` or `redis:6379`. `deploy.sh` checks this after every start.
- Host dirs: `uploads` 700 (uid 1001), `internal-tls` 700 root (docker bind-mounts single files from it), `secrets` 700 root.
- `env.template` is not a `.env`. Every value line is plain `KEY=`, with comments on their own lines. `init-secrets.sh` treats
  `KEY=`, `KEY=   ` and `KEY=  # note` as empty.
- `build-on-server.sh` only builds for `NEXT_PUBLIC_SITE_URL` = exactly `https://geiom.com`. The host check is an
  allowlist (`geiom.com`), not a blocklist of local names.
- `deploy.sh` compares `EDGE_AUTH_SECRET` with the proxy include only if both are non-empty and at least 32 characters,
  and compares sha256 hashes, never the values.
- Redis REST is short-term: SRH plus the internal TLS proxy, with no published ports,
  TLS 1.3 only, and only `POST /pipeline` allowed. `SRH_TOKEN` and `requirepass` are separate random values. The private
  CA is name-constrained to `DNS:redis-rest` and its key is deleted right after signing. Long term, a backend TCP Redis
  store removes `srh` and `srh-tls`.
- `MAIL_WEBHOOK_SECRET` is generated on the server and stored only in the app env file. It is not configured on the
  inbound Worker until Q7 is approved.

## Rate-limit store notes
- `RATE_LIMIT_STORE=upstash`, `UPSTASH_REDIS_REST_URL=https://redis-rest:8443`, `UPSTASH_REDIS_REST_TOKEN` = SRH token (written by `init-secrets.sh`). The prod check only requires the `https://` prefix, so the internal hostname is accepted.
- `NODE_EXTRA_CA_CERTS` must be set in the app container environment before the process starts (it is, in compose); setting it at runtime has no effect.
- `src/lib/seo/indexnow.ts` reuses the same Upstash variables for de-duplication; no extra config.
- If SRH/srh-tls is down, routes follow their own `onStoreError`: some reject, some fall back to in-process counting. 429/503 on some endpoints in that state is expected, not a bug.
- Long term: backend TCP Redis store (`REDIS_URL` with requirepass), then remove `srh` and `srh-tls`.

## APP_ORIGIN (required)
`APP_ORIGIN=https://geiom.com` must be in the app env file exactly once and equal the `NEXT_PUBLIC_SITE_URL` origin. It is not a secret. standalone sees its own origin as `http://0.0.0.0:<port>`, so without it the admin same-origin check rejects every browser POST with 403 (2FA binding included). `init-secrets.sh` forces it, compose also sets it, `deploy.sh` (`env_prod_ok`) aborts if it's missing, duplicated or different, and the app's startup check (fix/root-redirect-location) exits 1 in production if it's missing, not https, or not the SITE_URL origin.

## Off-box build (server memory too tight for `next build`)
`build-on-server.sh` stays the default. When its memory gate keeps failing, the images are built on a separate build host
and only imported on the server. `deploy.sh up` is the same in both paths (backup → plan → `db push` → drift → start →
checks → auto-rollback); it never builds.
1. **Build host** (has docker + buildx, holds NO production secret):
   `PIN_SHA=<40-hex> PLATFORM=<server: docker version -f '{{.Server.Os}}/{{.Server.Arch}}'> BUILD_ARGS_FILE=<600 file> OUT_DIR=<dir> deploy/build-offbox.sh`.
   The build-args file is the server's `build-args.env`, copied verbatim (600 on the build host, deleted after the build).
   Only the keys present in it are passed; every other ARG keeps its Dockerfile default. Values must be unquoted and LF
   only (a quote or `\r` would be baked into the bundle). Required: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (the **site** key;
   the secret key never leaves the server). `APP_ENV` / `NEXT_PUBLIC_SITE_URL`, if present, must be `production` /
   `https://geiom.com`. The sha256 of the effective value of every public ARG is written as a
   `com.nbshiyan.buildarg.<KEY>` label. The script clones fresh, checks HEAD / clean
   tree / no `.env*` or key files, the base-image and syntax digests, the `buildkitd.toml` sha256, that every Dockerfile
   `ARG` is on the public list, builds on BuildKit v0.34.0 (same digest as the server builder), checks platform, revision
   label, ENV keys, history and key files, then writes `nbshiyan-images-<sha12>.tar.zst`, `.sha256` and `.manifest`.
2. **Transfer** the three files to the server (any channel; integrity comes from the sha256 and the manifest IDs).
3. **Server**, from the checkout at the same SHA (`$NBSHIYAN_DATA_DIR/src`, umask-022 checkout, reviewed hashes):
   `NBSHIYAN_DATA_DIR=<dir> PIN_SHA=<40-hex> IMPORT_DIR=<dir> deploy/import-and-scan.sh`. Every step fails closed and prints
   PASS/FAIL only. Expected IDs: classic image store → config digest, containerd image store → manifest digest (both are in
   the manifest and both are checked against the tar before load). Production checks on the app image: `https://geiom.com`
   in the build output; no site-wide `noindex` rule in `routes-manifest.json` (= `APP_ENV=production` at build); no
   `//localhost`, `//127.0.0.1`, `//0.0.0.0` URL in the client bundle, prerendered pages or build manifests (server JS chunks
   are excluded: Next.js framework code there has dev/test fallbacks such as `http://localhost:${PORT}`; runtime headers are
   covered by `deploy.sh`'s `hdr_leak`); no Turnstile test key; exactly one baked site key whose sha256 equals the value in
   `build-args.env`. Build args: `build-args.env` format (public keys only, once each, unquoted, LF), the required keys,
   and for **every** public ARG the effective value (file value if present, else the Dockerfile default) = the image's
   `com.nbshiyan.buildarg.<KEY>` label by sha256 (both images); `NEXT_PUBLIC_ADMIN_API` / `NEXT_PUBLIC_ADMIN_MAIL` also
   against the inlined next.config `env`; every non-empty `NEXT_PUBLIC_*` value of 8+ chars must be literally in the build
   output; `MAIL_MOCK_ADAPTER_BUILD` must be empty or unset. No quote stripping anywhere. Only after all of that are `:candidate` and `.candidate-sha` set (and our old images rotated as in
   `build-on-server.sh` step 7).
4. `deploy.sh up` as usual.
