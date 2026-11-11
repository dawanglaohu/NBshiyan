#!/bin/sh
# Root-owned fixed tick for M4-T12. Installed by the private namespace setup at
# /tmp/mail-cron/tick.sh (0700, root). Reads only the root-owned run.conf and never
# opens application-writable data before dropping to the fixed app uid/gid.
# Residual risk: this process still runs with root host write capability while the
# root part executes; the mount/net/pid namespaces are not a file-permission sandbox.
set -eu
conf=/tmp/mail-cron/run.conf
[ -f "$conf" ] || exit 70
tab=$(printf '\t')
IFS=$tab read -r MAIL_APP_UID MAIL_APP_GID NODE_BIN SETPRIV_BIN < "$conf" || exit 70
case "$MAIL_APP_UID" in ''|*[!0-9]*) exit 70;; esac
case "$MAIL_APP_GID" in ''|*[!0-9]*) exit 70;; esac
[ "$MAIL_APP_UID" -gt 0 ] && [ "$MAIL_APP_GID" -gt 0 ] || exit 70
case "$NODE_BIN" in /*) ;; *) exit 72;; esac
case "$NODE_BIN" in *[!A-Za-z0-9/._+-]*) exit 72;; esac
case "$SETPRIV_BIN" in /*) ;; *) exit 72;; esac
case "$SETPRIV_BIN" in *[!A-Za-z0-9/._+-]*) exit 72;; esac
exec "$SETPRIV_BIN" --reuid="$MAIL_APP_UID" --regid="$MAIL_APP_GID" --init-groups --no-new-privs \
  -- "$NODE_BIN" --input-type=module - <<'NODE'
import fs from 'node:fs';

const state = '/tmp/mail-cron-state';
const uid = process.getuid();
const gid = process.getgid();
const at = new Date().toISOString();
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK;
const APPEND = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND;

const closeQuietly = (fd) => { if (fd !== undefined && fd !== null) { try { fs.closeSync(fd); } catch {} } };
const shape = (st, maxSize) =>
  st.isFile() && !st.isSymbolicLink() && st.uid === uid && st.nlink === 1 &&
  (st.mode & 0o777) === 0o600 && (maxSize === undefined || st.size <= maxSize);

// Evidence writes are best-effort: a missing/invalid last-attempt.json is a phase-level
// FAIL, never treated as a successful tick. O_TRUNC is deliberately avoided: a same-uid
// hard link must be rejected by the fstat shape check before anything is truncated.
const record = (outcome) => {
  let fd;
  try {
    fd = fs.openSync(`${state}/last-attempt.json`, APPEND | NOFOLLOW | NONBLOCK, 0o600);
    if (!shape(fs.fstatSync(fd))) throw new Error('shape');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify({ at, uid, gid, outcome }));
  } catch { /* phase treats absent evidence as failure */ }
  finally { closeQuietly(fd); }
};

let armed = false;
try {
  const st = fs.lstatSync(`${state}/armed`);
  armed = st.isFile() && !st.isSymbolicLink() && st.uid === uid;
} catch {}
if (!armed) process.exit(0);

// One arm => at most one tick can POST. The rename is atomic; a second minute sees no
// armed file even if the first POST is still in flight. If this tick later fails, the
// failed attempt is still recorded and the phase reports that window as failed.
const taken = `${state}/armed.taken.${process.pid}.${Date.now()}`;
try { fs.renameSync(`${state}/armed`, taken); } catch { process.exit(0); }

let logFd = null;
try {
  logFd = fs.openSync(`${state}/cron-mail-queue.log`, APPEND | NOFOLLOW | NONBLOCK, 0o600);
  if (!shape(fs.fstatSync(logFd), 1_048_576)) throw new Error('log_shape');
} catch {
  closeQuietly(logFd);
  record('log_open_failed');
  process.exit(3);
}

const writeLine = (status) => {
  try { fs.writeSync(logFd, `${new Date().toISOString()} mail-queue ${status}\n`); return true; }
  catch { return false; }
};

let secret = '';
try {
  const fd = fs.openSync(`${state}/secret`, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!shape(st) || st.size === 0 || st.size > 4096) throw new Error('secret_shape');
    const buffer = Buffer.alloc(st.size);
    if (fs.readSync(fd, buffer, 0, st.size, 0) !== st.size) throw new Error('secret_short');
    secret = buffer.toString('utf8').trim();
  } finally { closeQuietly(fd); }
} catch {
  writeLine(0);
  record('secret_invalid');
  process.exit(1);
}
if (!secret) { writeLine(0); record('secret_empty'); process.exit(1); }

try {
  const res = await fetch('http://127.0.0.1:3100/api/admin/cron/mail-queue', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(55_000),
  });
  const written = writeLine(res.status);
  record(written ? `posted:${res.status}` : 'log_write_failed');
  process.exit(written ? (res.ok || res.status === 409 ? 0 : 1) : 4);
} catch {
  writeLine(0);
  record('post_failed');
  process.exit(1);
}
NODE
