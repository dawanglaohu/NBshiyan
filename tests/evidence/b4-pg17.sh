#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

base_commit=ed9685a23b724baef64f43476b4f1e0c9ef06d63
base_tree=282e2d9224b7bb51371164d22a25bfd28427e22d
candidate_files=(tests/evidence/b4-pg17.sh tests/evidence/b4-pg17.config.ts tests/evidence/b4-pg17.spec.ts)
fixed_inputs=(deploy/cron.nbshiyan e2e/analytics-job-runtime.spec.ts e2e/analytics-settings.spec.ts e2e/run-auth.ts
  next.config.ts package.json playwright.config.ts pnpm-lock.yaml prisma/schema.prisma scripts/create-admin.mjs
  src/lib/analytics/daily-aggregate.ts src/lib/analytics/day-boundaries.ts src/lib/contracts/account.ts)
approved_files=()
mapfile -t approved_files < <(printf '%s\n' "${candidate_files[@]}" "${fixed_inputs[@]}" | LC_ALL=C sort)
if [[ ${1:-} == tick ]]; then
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
else
  node_bin=$(realpath -e -- "$(command -v node)")
fi
phase=arguments
trap 'printf "B4_FAILED phase=%s\n" "$phase" >&2' ERR

standalone_hash() {
  tar -C "$1" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . |
    sha256sum | cut -d' ' -f1
}

verify_approval() {
  local manifest=$1 expected=$2
  [[ $expected =~ ^[a-f0-9]{64}$ && -f $manifest && ! -L $manifest ]]
  [[ $(sha256sum -- "$manifest" | cut -d' ' -f1) == "$expected" ]]
  local file
  for file in "${approved_files[@]}"; do
    [[ -f $file && $(realpath -e -- "$file") == "$PWD/$file" ]]
  done
  cmp -s "$manifest" <(sha256sum -- "${approved_files[@]}")
}

case ${1:-} in
  stage)
    [[ $# == 7 && $(uname -s) == Linux && $($node_bin --version) == v22.* ]]
    phase=checkout
    repo=$(realpath "$2")
    commit=$3
    tree=$4
    manifest=$(realpath "$5")
    approved_sha=$6
    out=$(realpath -m "$7")
    [[ $commit =~ ^[a-f0-9]{40}$ && $tree =~ ^[a-f0-9]{40}$ && ! -e $out ]]
    [[ $out != "$repo" && $out != "$repo/"* ]]
    cd "$repo"
    [[ $(git rev-parse --show-toplevel) == "$repo" && $(git rev-parse HEAD) == "$commit" ]]
    [[ $(realpath "${BASH_SOURCE[0]}") == "$repo/${candidate_files[0]}" ]]
    [[ $(git rev-parse 'HEAD^{tree}') == "$tree" && $(git rev-parse "$base_commit^{tree}") == "$base_tree" ]]
    git merge-base --is-ancestor "$base_commit" "$commit"
    git diff --quiet "$base_commit" "$commit" -- "${fixed_inputs[@]}" ":(exclude)package.json" ":(exclude)pnpm-lock.yaml"
    git diff --quiet HEAD --
    git ls-files --error-unmatch -- "${approved_files[@]}" >/dev/null
    verify_approval "$manifest" "$approved_sha"
    phase=stage_artifact
    app=.next/standalone
    [[ -s $app/server.js && -s $app/.next/BUILD_ID && -d $app/node_modules ]]
    [[ -d .next/static && -d public ]]
    mkdir -p "$app/.next/static" "$app/public"
    cp -a .next/static/. "$app/.next/static/"
    cp -a public/. "$app/public/"
    build_id=$(<"$app/.next/BUILD_ID")
    build_sha=$(standalone_hash "$app")
    [[ $build_id =~ ^[A-Za-z0-9_-]{1,128}$ && $build_id == "$(<.next/BUILD_ID)" && $build_sha =~ ^[a-f0-9]{64}$ ]]
    [[ $($node_bin -p 'require("./.next/standalone/.next/required-server-files.json").config.env.APP_ENV_AT_BUILD') == test ]]
    mkdir -- "$out"
    install -m 0600 "$manifest" "$out/approved-files.sha256"
    printf '%s\n' "$commit" "$tree" "$build_id" "$build_sha" test "$approved_sha" >"$out/source.receipt"
    sha256sum "$out/source.receipt"
    ;;
  tick)
    phase=cron_tick
    [[ $# == 3 && $2 =~ ^/tmp/packjoyu-b4\.[A-Za-z0-9]+$ && -O $2 && ! -L $2 ]]
    root=$2
    preflight_failure() { printf '%s\n' "$1" >"$root/cron-preflight.txt"; exit 1; }
    [[ $3 =~ ^/[A-Za-z0-9_./-]+$ && -x $3 && $3 == "$(<"$root/node.exe")" ]] || preflight_failure CRON_NODE_IDENTITY_MISMATCH
    node_bin=$3
    [[ -f $root/crond.pid && -f $root/crond.exe ]] || preflight_failure CROND_IDENTITY_MISSING
    [[ $PPID == "$(<"$root/crond.pid")" ]] || preflight_failure CROND_PARENT_MISMATCH
    [[ $(readlink -e "/proc/$PPID/exe") == "$(<"$root/crond.exe")" ]] || preflight_failure CROND_EXECUTABLE_MISMATCH
    [[ -f $root/cron.secret && ! -L $root/cron.secret && -O $root/cron.secret && $(stat -c %a "$root/cron.secret") == 600 ]] || preflight_failure CRON_SECRET_FILE_INVALID
    # The closed result fields bind the cron request to the database observation.
    exec "$node_bin" --input-type=module - "$root" <<'JS'
import { appendFileSync, readFileSync } from 'node:fs';
const root = process.argv[2];
const secret = readFileSync(`${root}/cron.secret`, 'utf8');
if (!/^[a-f0-9]{64}$/.test(secret)) {
  appendFileSync(`${root}/cron-preflight.txt`, 'CRON_SECRET_FORMAT_INVALID\n');
  process.exit(1);
}
const at = Date.now();
let http = 0;
let result = 'transport';
let finishedAt = null;
try {
  const reply = await fetch('http://127.0.0.1:3111/api/admin/cron/operations', {
    method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jobKey: 'analytics-aggregate' }), signal: AbortSignal.timeout(55000),
  });
  http = reply.status;
  const body = await reply.json();
  const echo = Date.parse(body.finishedAt);
  if (body.jobKey === 'analytics-aggregate' && http === 200 && ['SUCCEEDED', 'FAILED', 'PARTIAL'].includes(body.status) && Number.isFinite(echo)) {
    result = body.status;
    finishedAt = echo;
  } else if (http === 409 && body.error === 'job_busy') result = 'busy';
  else if (http === 500 && body.error === 'job_failed') result = 'job_failed';
  else if (http === 503 && body.error === 'job_timeout') result = 'job_timeout';
  else result = 'unexpected';
} catch { /* Transport and HTTP/body failures are distinguished by the observed status. */ }
appendFileSync(`${root}/cron.jsonl`, JSON.stringify({ at, end: Date.now(), http, result, finishedAt, crondPid: process.ppid }) + '\n');
if (result !== 'SUCCEEDED' && result !== 'busy' && result !== 'job_failed') process.exitCode = 1;
JS
    ;;
  run)
    phase=isolation
    [[ $# == 4 && $(uname -s) == Linux && $EUID == 0 && $$ == 1 && $($node_bin --version) == v22.* ]]
    [[ $(readlink /proc/self/ns/net) == "$(readlink /proc/1/ns/net)" ]]
    [[ $(readlink /proc/self/ns/pid) == "$(readlink /proc/1/ns/pid)" ]]
    [[ $(ip -o link show | awk -F': ' '{print $2}') == lo ]]
    [[ -n $(ip -4 -o addr show dev lo to 127.0.0.1/32) && -z $(ip -4 route show) && -z $(ip -6 route show default) ]]
    [[ $(getent -A ahostsv4 localhost | awk '{print $1}' | sort -u) == 127.0.0.1 ]]
    [[ $(findmnt -n -o FSTYPE --mountpoint /tmp) == tmpfs ]]
    [[ $2 =~ ^[a-f0-9]{64}$ && $3 =~ ^[a-f0-9]{64}$ ]]
    [[ $4 == schedule || $4 == with-guard || $4 == guard-control ]]
    mode=$4
    phase=build_provenance
    for mount in /build/source /build/attestation; do
      mount_opts=$(findmnt -n -o OPTIONS --mountpoint "$mount")
      [[ ,$mount_opts, == *,ro,* ]]
    done
    [[ $(findmnt -n -o TARGET --mountpoint /evidence) == /evidence ]]
    first_output=$(find /evidence -mindepth 1 -print -quit)
    [[ -z $first_output ]]
    attestation=/build/attestation
    [[ $(sha256sum "$attestation/source.receipt" | cut -d' ' -f1) == "$2" ]]
    cd /build/source
    mapfile -t provenance <"$attestation/source.receipt"
    [[ ${#provenance[@]} == 6 && ${provenance[0]} =~ ^[a-f0-9]{40}$ && ${provenance[1]} =~ ^[a-f0-9]{40}$ ]]
    [[ ${provenance[2]} =~ ^[A-Za-z0-9_-]{1,128}$ && ${provenance[3]} =~ ^[a-f0-9]{64}$ && ${provenance[4]} == test && ${provenance[5]} == "$3" ]]
    [[ $(realpath "${BASH_SOURCE[0]}") == /build/source/tests/evidence/b4-pg17.sh ]]
    verify_approval "$attestation/approved-files.sha256" "$3"
    [[ -s .next/standalone/server.js && $(<.next/standalone/.next/BUILD_ID) == "${provenance[2]}" ]]
    [[ $(standalone_hash .next/standalone) == "${provenance[3]}" ]]
    [[ $($node_bin -p 'require("./.next/standalone/.next/required-server-files.json").config.env.APP_ENV_AT_BUILD') == test ]]
    phase=tools_and_ports
    [[ ${B4_TOOL_ID:-} =~ ^[a-f0-9]{64}$ && ${B4_PG_BIN:-} == /* ]]
    pg=$(realpath -e -- "$B4_PG_BIN")
    for tool in postgres initdb pg_ctl psql createdb createuser; do [[ -x $pg/$tool ]]; done
    [[ $($pg/postgres --version) =~ ^postgres\ \(PostgreSQL\)\ 17\. && $(id -u postgres) -gt 0 && $(id -u nobody) -gt 0 && $(id -u nobody) != "$(id -u postgres)" ]]
    export TZ=UTC
    bb=$(realpath -e -- "$(command -v busybox)")
    "$bb" --list | grep -Fx crond >/dev/null
    pg_sha=$(sha256sum "$pg/postgres" | cut -d' ' -f1)
    bb_sha=$(sha256sum "$bb" | cut -d' ' -f1)
    node_sha=$(sha256sum "$node_bin" | cut -d' ' -f1)
    setpriv_bin=$(command -v setpriv)
    ports_closed() {
      local port listeners
      for port in 3111 55417; do
        listeners=$(ss -Hln "sport = :$port") || return 1
        [[ -z $listeners ]] || return 1
      done
    }
    ports_closed
    root=$(mktemp -d /tmp/packjoyu-b4.XXXXXXXX)
    chmod 0711 "$root"
    pg_started=0
    as_pg() { "$setpriv_bin" --reuid postgres --regid "$(id -g postgres)" --init-groups -- "$@"; }
    cleanup() {
      local status=$?
      trap - EXIT
      if (( pg_started )); then
        as_pg "$pg/pg_ctl" -D "$root/pg" -m fast -w stop >/dev/null 2>&1 || status=1
      fi
      ports_closed || status=1
      # The filesystem and any remaining namespace processes are discarded by the disposable container.
      if (( status == 0 )); then
        install -m 0600 "$root/result.json" /evidence/result.json
        install -m 0600 "$root/cron.jsonl" /evidence/cron.jsonl
        install -m 0600 "$root/result-gate.json" /evidence/result-gate.json
        install -m 0600 "$attestation/source.receipt" /evidence/source.receipt
        printf '%s\n' 'ports_closed=true pg_stopped=true' >/evidence/cleanup.txt
      fi
      if (( status != 0 )) && [[ -f $root/cron-preflight.txt ]]; then
        local reason
        reason=$(<"$root/cron-preflight.txt")
        case $reason in
          CROND_IDENTITY_MISSING|CROND_PARENT_MISMATCH|CROND_EXECUTABLE_MISMATCH|CRON_NODE_IDENTITY_MISMATCH|CRON_SECRET_FILE_INVALID|CRON_SECRET_FORMAT_INVALID)
            printf '%s\n' "$reason" >/evidence/cron-preflight.txt ;;
        esac
      fi
      if (( status != 0 )) && [[ -f $root/failed-reason.txt ]]; then
        local reason
        reason=$(<"$root/failed-reason.txt")
        case $reason in
          B4_GUARD_ARM_WINDOW|B4_OLD_DELETE_NOT_BLOCKED|B4_GUARD_RELEASE_LATE|B4_RR_WRITE_GUARD_SQLSTATE_UNPROVEN)
            printf '%s\n' "$reason" >/evidence/failed-reason.txt ;;
        esac
      fi
      if (( status != 0 )) && [[ -f $root/failed-stage.txt ]]; then
        local stage
        stage=$(<"$root/failed-stage.txt")
        case $stage in
          owned_database|standalone_and_auth|initial_true_tick|admin_patch_and_tick|restart_and_new_watermark|stopped_window|resumed_true_tick|rr_write_guard|rr_barrier_control|j5_revision_history|report)
            printf '%s\n' "$stage" >/evidence/failed-stage.txt ;;
        esac
      fi
      exit "$status"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    phase=pg17
    mkdir -m 0700 "$root/pg" "$root/pg-log" "$root/socket" "$root/app" "$root/tmp" "$root/spool"
    chown postgres: "${root}/pg" "${root}/pg-log" "${root}/socket"
    install -m 0700 tests/evidence/b4-pg17.sh "$root/tick.sh"
    cp -a -- .next/standalone/. "$root/app/"
    [[ $(standalone_hash "$root/app") == "${provenance[3]}" ]]
    find "$root/app" -type l -print0 >"$root/artifact-links"
    while IFS= read -r -d '' link; do
      target=$(realpath -e -- "$link")
      [[ $target == "$root/app/"* ]]
    done <"$root/artifact-links"
    chown -Rh nobody: "$root/app"
    as_pg "$pg/initdb" -D "$root/pg" -U b4_pg -A trust --no-locale -E UTF8 >"$root/init.private.log" 2>&1
    as_pg "$pg/pg_ctl" -D "$root/pg" -l "$root/pg-log/start.private.log" -w start \
      -o "-p 55417 -h 127.0.0.1 -k $root/socket -c log_destination=jsonlog -c logging_collector=on -c dynamic_shared_memory_type=mmap -c log_directory=$root/pg-log -c log_timezone=UTC -c log_min_error_statement=error -c log_parameter_max_length_on_error=0" \
      >"$root/pgctl.private.log" 2>&1
    pg_started=1
    as_pg "$pg/createuser" -h 127.0.0.1 -p 55417 -U b4_pg --no-superuser --no-createdb --no-createrole b4_app >/dev/null 2>&1
    as_pg "$pg/createdb" -h 127.0.0.1 -p 55417 -U b4_pg -O b4_app b4_e2e >/dev/null 2>&1
    db_url=postgresql://b4_pg@127.0.0.1:55417/b4_e2e
    app_db_url=postgresql://b4_app@127.0.0.1:55417/b4_e2e
    [[ $("$pg/psql" -XAtq "$app_db_url" -c "SELECT current_database(), current_setting('server_version_num'), host(inet_server_addr()), inet_server_port(), current_user") =~ ^b4_e2e\|17[0-9]{4}\|127\.0\.0\.1\|55417\|b4_app$ ]]
    phase=schema
    env -i PATH="$PATH" HOME="$root/tmp" DATABASE_URL="$app_db_url" ./node_modules/.bin/prisma db push --skip-generate >"$root/schema.private.log" 2>&1
    phase=playwright
    j5=${B4_J5:-0}
    [[ $j5 == 0 || ( $j5 == 1 && $mode == with-guard ) ]]
    ci_env=()
    if [[ -v CI ]]; then ci_env=("CI=$CI"); fi
    # Generate values inside the child so credentials never appear in a shell command's argv.
    env -i PATH="$PATH" HOME="$root/tmp" TMPDIR="$root/tmp" TZ=UTC LANG=C.UTF-8 B4_J5="$j5" "${ci_env[@]}" \
      "$node_bin" --input-type=module - "$root" "$db_url" "$app_db_url" "${provenance[0]}" "${provenance[1]}" "${provenance[2]}" "${provenance[3]}" "$mode" "$bb" "$setpriv_bin" "$(id -g nobody)" "$B4_TOOL_ID" "$pg_sha" "$bb_sha" "$node_sha" "$3" <<'JS' >"$root/playwright.private.log" 2>&1
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const [B4_ROOT, DATABASE_URL, B4_APP_DB, B4_SOURCE_COMMIT, B4_SOURCE_TREE, B4_BUILD_ID, B4_BUILD_SHA256, B4_MODE, B4_BUSYBOX, B4_SETPRIV, B4_APP_GID, B4_TOOL_ID, B4_PG_SHA256, B4_CROND_SHA256, B4_NODE_SHA256, B4_APPROVED_SHA256] = process.argv.slice(2);
const { status } = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/evidence/b4-pg17.config.ts'], {
  stdio: 'inherit', timeout: (process.env.B4_J5 === '1' ? 41 : 37) * 60_000, killSignal: 'SIGTERM', env: {
    ...process.env, B4_ROOT, DATABASE_URL, B4_APP_DB, B4_SOURCE_COMMIT, B4_SOURCE_TREE, B4_BUILD_ID, B4_BUILD_SHA256, B4_MODE, B4_BUSYBOX, B4_SETPRIV, B4_APP_GID,
    B4_TOOL_ID, B4_PG_SHA256, B4_CROND_SHA256, B4_NODE_SHA256, B4_APPROVED_SHA256,
    CRON_SECRET: randomBytes(32).toString('hex'), AUTH_SECRET: randomBytes(32).toString('hex'),
    PRIVACY_HASH_SECRET: randomBytes(32).toString('hex'), ADMIN_TOTP_KEY: randomBytes(32).toString('base64'),
  },
});
process.exitCode = status ?? 1;
JS
    phase=output_gate
    B4_J5="$j5" "$node_bin" --input-type=module - "$root" "$mode" "${provenance[0]}" "${provenance[1]}" "${provenance[2]}" "${provenance[3]}" "$3" "$B4_TOOL_ID" "$pg_sha" "$bb_sha" "$node_sha" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const [root, mode, sourceCommit, sourceTree, buildId, buildSha256, approvedSha256, toolId, postgres, crond, node] = process.argv.slice(2);
function checkJ5(result, ticks) {
  const { j5, guard } = result;
  const { settings, restart, round, current, history } = j5;
  assert.equal(result.mode, 'with-guard');
  assert.equal(guard.status, 'rr_write_guard_40001');
  assert.deepEqual([guard.evidence.sqlstate, guard.evidence.phase, guard.evidence.pid],
    ['40001', 'daily_write_guard_site_setting_for_update', guard.barrier.blockedPid]);
  const { httpStatus, ...saved } = guard.patch;
  assert.equal(httpStatus, 200);
  assert.deepEqual(settings.saved, saved);
  assert.deepEqual(settings.before, { version: saved.version - 1, timezone: 'Asia/Tokyo', timezoneRevision: saved.timezoneRevision - 1, recomputableFrom: null });
  assert.equal(saved.timezone, 'America/New_York');
  assert.equal(saved.rebuildScheduled, true);
  assert.deepEqual(settings.pending, { timezone: saved.timezone, revision: saved.timezoneRevision, from: saved.recomputableFrom, status: 'pending' });
  assert.deepEqual(settings.stale, { http: 409, code: 'version_conflict', unchanged: true });
  assert.ok(ticks[4].end <= restart.at && restart.at <= ticks[5].at);
  assert.ok(Number.isSafeInteger(restart.beforePid) && restart.beforePid > 1 && restart.beforePid !== restart.afterPid);
  assert.equal(restart.beforePid, result.appPids[1]);
  assert.ok(Number.isSafeInteger(restart.afterPid) && restart.afterPid > 1);
  assert.deepEqual(round.tick, ticks[5]);
  assert.deepEqual([round.name, round.tick.http, round.tick.result, round.generation, round.revision, round.timezone, round.count],
    ['j5_after_guard_restart', 200, 'SUCCEEDED', guard.generation + 1, saved.timezoneRevision, saved.timezone, 3]);
  assert.equal(round.tick.crondPid, guard.tick.crondPid);
  assert.equal(Math.floor(ticks[5].at / 300_000) - Math.floor(ticks[4].at / 300_000), 1);
  assert.ok(round.started >= restart.at && round.succeeded >= round.started && round.succeeded > guard.lastSucceeded);
  assert.ok(round.sourceThrough > guard.sourceThrough && round.sourceThrough === guard.seededThrough);
  assert.deepEqual([current.localDate, current.revision, current.timezone, current.classification, current.reason],
    [round.date, round.revision, round.timezone, 'complete', 'site_row_no_gap_no_defer_marker_equal']);
  assert.ok(Date.parse(j5.coverageFloor) >= Date.parse(saved.recomputableFrom));
  assert.ok(Date.parse(current.bounds.startUtc) >= Date.parse(j5.coverageFloor));
  assert.ok(Date.parse(current.bounds.endUtc) <= round.aggregatedAt && Date.parse(current.bounds.endUtc) > Date.parse(current.bounds.startUtc));
  assert.deepEqual(current.markers, round.markerVersions);
  assert.deepEqual([current.metrics.pageViews, current.metrics.visitors], [3, 1]);
  assert.deepEqual([history.date, history.timezone, history.revision, history.retained, history.unchanged, history.classification, history.reason],
    [result.retained.date, 'UTC', 1, true, true, 'partial', 'state_missing']);
  assert.deepEqual([history.requestedRevision, history.requestedClassification, history.requestedReason], [saved.timezoneRevision, 'no_data', 'no_site_row']);
  assert.deepEqual([history.metrics.pageViews, history.metrics.visitors], [11, 7]);
  assert.ok(Number.isSafeInteger(j5.metricRows) && j5.metricRows > 0);
  assert.deepEqual([j5.backlogConsumed, j5.allWrittenInsideCoverage, j5.rawUnchanged], [true, true, true]);
}
try {
  const read = name => JSON.parse(fs.readFileSync(`${root}/${name}`, 'utf8'));
  const result = read('result.json');
  const pw = read('playwright.json');
  assert.equal(pw.errors.length, 0);
  assert.deepEqual([pw.stats.expected, pw.stats.unexpected, pw.stats.flaky, pw.stats.skipped], [1, 0, 0, 0]);
  const spec = pw.suites[0]?.specs[0];
  assert.equal(spec?.title, 'B4 PG17 real schedule and ADMIN revision');
  assert.equal(spec?.tests[0]?.results[0]?.status, 'passed');
  assert.deepEqual([result.pass, result.sourceCommit, result.sourceTree, result.buildId, result.buildSha256], [true, sourceCommit, sourceTree, buildId, buildSha256]);
  assert.deepEqual(result.rounds.map(r => r.name), ['initial', 'patched', 'restarted', 'resumed']);
  assert.deepEqual([result.mode, result.buildMode, result.approvedSha256, result.sharedMemory], [mode, 'test', approvedSha256, 'mmap']);
  assert.deepEqual(result.tools, { toolId, postgres, crond, node });
  assert.ok(!fs.existsSync(`${root}/cron-preflight.txt`));
  const expected = { schedule: 'not_requested', 'with-guard': 'rr_write_guard_40001', 'guard-control': 'same_barrier_succeeded' };
  assert.equal(result.guard.status, expected[mode]);
  const ticks = fs.readFileSync(`${root}/cron.jsonl`, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const j5 = process.env.B4_J5 === '1';
  assert.equal(Boolean(result.j5), j5);
  assert.equal(ticks.length, mode === 'schedule' ? 4 : j5 ? 6 : 5);
  if (j5) checkJ5(result, ticks);
  for (const [i, round] of result.rounds.entries()) assert.deepEqual(ticks[i], round.tick);
  if (mode !== 'schedule') {
    const { guard, rounds } = result;
    const [resumed] = rounds.slice(-1);
    assert.deepEqual(ticks[4], guard.tick);
    assert.equal(guard.barrier.relation, 'AnalyticsDailyRollup');
    assert.equal(guard.barrier.lockMode, 'ShareLock');
    assert.ok(guard.barrier.blockedAt >= ticks[4].at && guard.barrier.releaseRequestedAt > guard.barrier.blockedAt);
    assert.ok(guard.barrier.releasedAt >= guard.barrier.releaseRequestedAt && guard.barrier.releasedAt < ticks[4].end);
    if (mode === 'with-guard') {
      assert.equal(guard.evidence.pid, guard.barrier.blockedPid);
      assert.ok(guard.patchedAt >= guard.barrier.blockedAt && guard.patchedAt < guard.barrier.releaseRequestedAt);
      assert.ok(guard.evidence.timestamp >= guard.barrier.releaseRequestedAt && guard.evidence.timestamp <= ticks[4].end);
      assert.equal(guard.evidence.sqlstate, '40001');
      assert.equal(guard.evidence.phase, 'daily_write_guard_site_setting_for_update');
      assert.equal(guard.lastSucceeded, resumed.succeeded);
      assert.equal(guard.sourceThrough, resumed.sourceThrough);
      assert.ok(guard.seededThrough > guard.sourceThrough);
    } else {
      assert.equal(guard.round.generation, resumed.generation + 1);
      assert.equal(guard.round.revision, resumed.revision);
      assert.equal(guard.round.count, resumed.count + 1);
      assert.ok(guard.round.sourceThrough > resumed.sourceThrough);
    }
  }
  fs.writeFileSync(`${root}/result-gate.json`, JSON.stringify({ title: spec.title, passed: 1, failed: 0, skipped: 0, tickCount: ticks.length, guard: result.guard.status }) + '\n', { flag: 'wx' });
} catch { process.exitCode = 1; }
JS
    ;;
  pair)
    [[ $# == 4 && $($node_bin --version) == v22.* ]]
    phase=pair_gate
    [[ ${B4_J5:-0} == 0 || ${B4_J5:-0} == 1 ]]
    "$node_bin" --input-type=module - "$2" "$3" "$4" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [conflictDir, controlDir, out] = process.argv.slice(2);
function checkJ5(result, ticks) {
  const { j5, guard } = result;
  const { settings, restart, round, current, history } = j5;
  assert.equal(result.mode, 'with-guard');
  assert.equal(guard.status, 'rr_write_guard_40001');
  assert.deepEqual([guard.evidence.sqlstate, guard.evidence.phase, guard.evidence.pid],
    ['40001', 'daily_write_guard_site_setting_for_update', guard.barrier.blockedPid]);
  const { httpStatus, ...saved } = guard.patch;
  assert.equal(httpStatus, 200);
  assert.deepEqual(settings.saved, saved);
  assert.deepEqual(settings.before, { version: saved.version - 1, timezone: 'Asia/Tokyo', timezoneRevision: saved.timezoneRevision - 1, recomputableFrom: null });
  assert.equal(saved.timezone, 'America/New_York');
  assert.equal(saved.rebuildScheduled, true);
  assert.deepEqual(settings.pending, { timezone: saved.timezone, revision: saved.timezoneRevision, from: saved.recomputableFrom, status: 'pending' });
  assert.deepEqual(settings.stale, { http: 409, code: 'version_conflict', unchanged: true });
  assert.ok(ticks[4].end <= restart.at && restart.at <= ticks[5].at);
  assert.ok(Number.isSafeInteger(restart.beforePid) && restart.beforePid > 1 && restart.beforePid !== restart.afterPid);
  assert.equal(restart.beforePid, result.appPids[1]);
  assert.ok(Number.isSafeInteger(restart.afterPid) && restart.afterPid > 1);
  assert.deepEqual(round.tick, ticks[5]);
  assert.deepEqual([round.name, round.tick.http, round.tick.result, round.generation, round.revision, round.timezone, round.count],
    ['j5_after_guard_restart', 200, 'SUCCEEDED', guard.generation + 1, saved.timezoneRevision, saved.timezone, 3]);
  assert.equal(round.tick.crondPid, guard.tick.crondPid);
  assert.equal(Math.floor(ticks[5].at / 300_000) - Math.floor(ticks[4].at / 300_000), 1);
  assert.ok(round.started >= restart.at && round.succeeded >= round.started && round.succeeded > guard.lastSucceeded);
  assert.ok(round.sourceThrough > guard.sourceThrough && round.sourceThrough === guard.seededThrough);
  assert.deepEqual([current.localDate, current.revision, current.timezone, current.classification, current.reason],
    [round.date, round.revision, round.timezone, 'complete', 'site_row_no_gap_no_defer_marker_equal']);
  assert.ok(Date.parse(j5.coverageFloor) >= Date.parse(saved.recomputableFrom));
  assert.ok(Date.parse(current.bounds.startUtc) >= Date.parse(j5.coverageFloor));
  assert.ok(Date.parse(current.bounds.endUtc) <= round.aggregatedAt && Date.parse(current.bounds.endUtc) > Date.parse(current.bounds.startUtc));
  assert.deepEqual(current.markers, round.markerVersions);
  assert.deepEqual([current.metrics.pageViews, current.metrics.visitors], [3, 1]);
  assert.deepEqual([history.date, history.timezone, history.revision, history.retained, history.unchanged, history.classification, history.reason],
    [result.retained.date, 'UTC', 1, true, true, 'partial', 'state_missing']);
  assert.deepEqual([history.requestedRevision, history.requestedClassification, history.requestedReason], [saved.timezoneRevision, 'no_data', 'no_site_row']);
  assert.deepEqual([history.metrics.pageViews, history.metrics.visitors], [11, 7]);
  assert.ok(Number.isSafeInteger(j5.metricRows) && j5.metricRows > 0);
  assert.deepEqual([j5.backlogConsumed, j5.allWrittenInsideCoverage, j5.rawUnchanged], [true, true, true]);
}
function run(dir, mode, status) {
  const file = name => fs.readFileSync(join(dir, name));
  const result = file('result.json');
  const evidence = JSON.parse(result);
  const gate = JSON.parse(file('result-gate.json'));
  assert.equal(String(file('cleanup.txt')), 'ports_closed=true pg_stopped=true\n');
  const j5 = process.env.B4_J5 === '1' && mode === 'with-guard';
  assert.equal(Boolean(evidence.j5), j5);
  assert.deepEqual([gate.passed, gate.failed, gate.skipped, gate.tickCount, gate.guard], [1, 0, 0, j5 ? 6 : 5, status]);
  assert.equal(evidence.pass, true);
  assert.equal(evidence.mode, mode);
  assert.equal(evidence.guard.status, status);
  assert.deepEqual(evidence.rounds.map(r => r.name), ['initial', 'patched', 'restarted', 'resumed']);
  const ticks = String(file('cron.jsonl')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(ticks.length, j5 ? 6 : 5);
  if (j5) {
    checkJ5(evidence, ticks);
  }
  for (const [i, round] of evidence.rounds.entries()) assert.deepEqual(ticks[i], round.tick);
  assert.deepEqual(ticks[4], evidence.guard.tick);
  const source = String(file('source.receipt'));
  assert.equal(source, [evidence.sourceCommit, evidence.sourceTree, evidence.buildId, evidence.buildSha256, evidence.buildMode, evidence.approvedSha256].join('\n') + '\n');
  return { evidence, source, resultSha256: createHash('sha256').update(result).digest('hex') };
}
try {
  assert.notEqual(fs.realpathSync(conflictDir), fs.realpathSync(controlDir));
  const conflict = run(conflictDir, 'with-guard', 'rr_write_guard_40001');
  const control = run(controlDir, 'guard-control', 'same_barrier_succeeded');
  assert.equal(conflict.source, control.source);
  assert.deepEqual(conflict.evidence.tools, control.evidence.tools);
  assert.deepEqual([conflict.evidence.pgVersionNum, conflict.evidence.sharedMemory], [control.evidence.pgVersionNum, 'mmap']);
  assert.equal(control.evidence.sharedMemory, 'mmap');
  const a = conflict.evidence.guard;
  const b = control.evidence.guard;
  for (const guard of [a, b]) {
    assert.deepEqual([guard.barrier.relation, guard.barrier.lockMode], ['AnalyticsDailyRollup', 'ShareLock']);
    assert.ok(guard.barrier.blockedPid !== guard.barrier.barrierPid);
    assert.ok(guard.barrier.releasedAt > guard.barrier.blockedAt);
  }
  assert.deepEqual([a.tick.http, a.tick.result, a.evidence.sqlstate, a.evidence.phase, a.evidence.pid], [500, 'job_failed', '40001', 'daily_write_guard_site_setting_for_update', a.barrier.blockedPid]);
  assert.deepEqual([b.tick.http, b.tick.result], [200, 'SUCCEEDED']);
  assert.ok(a.patchedAt >= a.barrier.blockedAt && a.patchedAt < a.barrier.releaseRequestedAt);
  assert.ok(a.evidence.timestamp >= a.barrier.releaseRequestedAt && a.evidence.timestamp <= a.tick.end);
  assert.ok(b.round.succeeded >= b.barrier.releaseRequestedAt);
  const resumedA = conflict.evidence.rounds[3];
  const resumedB = control.evidence.rounds[3];
  assert.equal(resumedA.revision, resumedB.revision);
  assert.deepEqual([a.generation, a.lastSucceeded, a.sourceThrough, a.previousCount], [resumedA.generation + 1, resumedA.succeeded, resumedA.sourceThrough, resumedA.count]);
  assert.ok(a.seededThrough > a.sourceThrough);
  assert.deepEqual([b.round.generation, b.round.revision, b.round.count], [resumedB.generation + 1, resumedB.revision, resumedB.count + 1]);
  assert.ok(b.round.sourceThrough > resumedB.sourceThrough);
  fs.writeFileSync(out, JSON.stringify({ pass: true, source: conflict.evidence.sourceCommit, buildId: conflict.evidence.buildId, conflict: conflict.resultSha256, control: control.resultSha256 }) + '\n', { flag: 'wx', mode: 0o600 });
} catch { process.exitCode = 1; }
JS
    ;;
  *) exit 64 ;;
esac
