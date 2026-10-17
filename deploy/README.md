# Self-host deployment (Docker Compose)

Production runs as one compose project, `nbshiyan`: app (Next.js standalone, uid 1001, local uploads at `UPLOAD_DIR`), Postgres 17, Redis 7, and an
Upstash-compatible REST proxy (SRH) behind an internal TLS terminator. Only `127.0.0.1:3000` is published. The host's
reverse proxy terminates public TLS, adds `X-Edge-Auth` and forwards to it.

## Rules
- **Builds carry no secrets.** `next build` only gets public build args (`APP_ENV=production`, `NEXT_PUBLIC_*`,
  `SANITY_PROJECT_ID/DATASET`). All server-side secrets are read at runtime from the env file given by
  `NBSHIYAN_APP_ENV_FILE` (root 600). `src/instrumentation.ts` re-runs the production env check at start and exits if anything is missing.
- **Build input:** a full 40-character commit SHA that is already merged into `main`, never a branch name.
- **Base images** are pinned by tag and digest.
- **Cleanup is scoped to NBshiyan:** only its own buildx builder cache and its own images (`nbshiyan-app`,
  `nbshiyan-migrate`; keep `:current` and `:previous`). Never `docker system/image/volume prune`.
- **Never run `docker compose config`.** It expands `env_file` and would print secrets.

## Files
| file | purpose |
|---|---|
| `../Dockerfile`, `../.dockerignore` | multi-stage build: deps → builder → runner (standalone) and migrate (standalone prisma 6.19.3 CLI + schema.prisma) |
| `docker-compose.yml` | stack definition and hardening (read_only, cap_drop ALL, no-new-privileges, pids/mem limits) |
| `env.template` | every runtime variable, no values: who supplies it, whether it's a secret, whether prod requires it |
| `init-secrets.sh` | one-time: creates data dirs and generates secrets on the host; never overwrites, never prints |
| `build-on-server.sh` | pinned-SHA build in a memory-capped dedicated builder; disk/memory gates; leak checks; tag rotation |
| `plan-check.sh`, `tests/plan-check.test.sh` | destructive-change gate for the schema plan (sourced by `deploy.sh`) and its tests (`bash deploy/tests/plan-check.test.sh`, no docker/DB needed) |
| `smoke-lib.sh`, `tests/smoke.test.sh` | redirect/header smoke rules (`loc_bad`, `root_redirect_ok`) used by `deploy.sh`, and their tests |
| `deploy.sh` | pg_dump → schema plan + destructive check → `db push` → drift check → start → post-deploy checks → auto-rollback |
| `backup-postgres.sh`, `cron.nbshiyan` | daily `pg_dump -Fc` (7 daily + 4 weekly) and the cleanup cron run inside the container |

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
curl -sI 'https://geiom.com//evil.com/'      # Location must not start with // and must not point at evil.com
curl -sI 'https://geiom.com/%2F%2Fevil.com'  # same
curl -sI 'https://geiom.com/\evil.com'       # same
for u in /api/health '/api/health?x=1' /api/health/ /api/health/x; do curl -s -o /dev/null -w "%{http_code} $u\n" "https://geiom.com$u"; done   # all 404
curl -s -o /dev/null -w '%{http_code}\n' https://geiom.com/api/healthz   # reaches the app (its 404 page, not nginx's)
```
Rules, the same as `smoke-lib.sh`. In `deploy.sh`, any of these fails the deploy and triggers a rollback:
- Any **5xx** on `/`, `/ru`, `/admin` or the three `evil.com` probes is a FAIL.
- `/` must be a **3xx**. At app level (`deploy.sh`, 127.0.0.1:3000) the Location must be **exactly `/en`**. On the public
  post-DNS check, `/en` or `https://geiom.com/en` are both accepted.
- A Location is a FAIL if it starts with two slashes or backslashes in any mix (`//`, `/\`, `\/`, `\\`), starts with `\`,
  or mentions `evil.com` without being a plain same-site relative path (`/x…`). `/evil.com/` is fine: it's a path on geiom.com.
- No response header may contain `localhost`. Local observation on PR #321 (bad9379): with `HOSTNAME=127.0.0.1`, `/` answers
`Location: https://localhost:<port>/en`, so the nginx `proxy_redirect` regex is needed, and compose keeps
`HOSTNAME=0.0.0.0`. `/%2F%2Fevil.com` answers **500** from the app (reported to the backend; it is not a redirect).

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
