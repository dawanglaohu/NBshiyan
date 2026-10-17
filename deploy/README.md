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
| `deploy.sh` | pg_dump → schema plan + destructive check → `db push` → drift check → start → post-deploy checks → auto-rollback |
| `backup-postgres.sh`, `cron.nbshiyan` | daily `pg_dump -Fc` (7 daily + 4 weekly) and the cleanup cron run inside the container |

## Schema changes (final: `prisma db push`)
The repo uses `prisma db push` and has no `prisma/migrations`. `prisma/sql/*.sql` files, including
`74-mail-backend.sql`, are **not** executed by this deployment.
`deploy.sh up` runs these steps on the server, in this order:
1. **Backup.** `pg_dump -Fc` of the NBshiyan DB.
2. **Plan.** `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`
   writes the plan to a local 600 file. The deploy **stops for full-stack review** if the plan contains any of these
   (case-insensitive): `DROP`, `ALTER COLUMN … TYPE`, `RENAME`, `SET NOT NULL`, `TRUNCATE`/`DELETE`, or, on tables
   that already exist, `CREATE UNIQUE INDEX`, `ADD CONSTRAINT` or `ADD COLUMN … NOT NULL` without `DEFAULT`.
3. **Push.** `prisma db push --skip-generate`, never with `--accept-data-loss`.
4. **Drift check.** The same diff with `--exit-code` must return 0, otherwise the app is not started.

How credentials and output are handled:
- `DATABASE_URL` comes only from the migrate service's `env_file`. It is never on argv and never printed, and `--from-url` is never used.
- `db push` output contains the DB host, port and name. It is redacted and kept in a local 600 log, which is never posted.

The ordering lives in `deploy.sh` instead of `depends_on: service_completed_successfully`. A dependency in an inactive
profile behaves differently across compose versions, and the review gate sits between two migrate runs.

## First admin (after the first successful deploy)
Run this on the server, as Ryan or with Ryan at the keyboard. The exact command name comes from backend PR
`fix/deploy-readiness`; it is referred to below as `<admin-create>`.
```sh
# interactive (TTY): asks for the password without echo; nothing goes into argv or shell history
docker compose -p nbshiyan -f deploy/docker-compose.yml --env-file "$NBSHIYAN_COMPOSE_ENV" exec -it app <admin-create> --email <admin email>
# non-interactive (no TTY): password on stdin only, e.g. from a password manager pipe; never as an argument or exported env
<password source> | docker compose -p nbshiyan -f deploy/docker-compose.yml --env-file "$NBSHIYAN_COMPOSE_ENV" exec -T app <admin-create> --email <admin email> --password-stdin
```
Then log in at `/admin` and **bind 2FA immediately**. `ADMIN_SEED_TOTP_SECRET` is never set in production.

## Review notes
- **Never run `docker compose config` for this project.** It prints the resolved `env_file` values, which are secrets.
  Use `docker compose ps` and `docker inspect --format` on specific fields instead.
- The build carries no secrets: no secret `ARG`/`ENV`, no `.env` in the context. After every build, `build-on-server.sh`
  scans `docker history`, the image ENV and both image filesystems (including `/app/.next-dist`) for every secret
  value. The required result is 0 hits.
- Redis REST is short-term: SRH plus the internal TLS proxy, on the `backend` network only, with no published ports,
  TLS 1.3 only, and only `POST /pipeline` allowed. `SRH_TOKEN` and `requirepass` are separate random values. The private
  CA is name-constrained to `DNS:redis-rest` and its key is deleted right after signing. Long term, a backend TCP Redis
  store removes `srh` and `srh-tls`.
- `MAIL_WEBHOOK_SECRET` is generated on the server and stored only in the app env file. It is not configured on the
  inbound Worker until Q7 is approved.
