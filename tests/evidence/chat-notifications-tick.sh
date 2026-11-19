#!/bin/sh
# The namespace launcher installs this fixed script as root, then each tick drops privileges.
set -eu
IFS=$(printf '\t') read -r uid gid node_bin setpriv_bin < /tmp/mail-cron/run.conf
case "$uid:$gid" in *[!0-9:]*) exit 70;; esac
[ "$uid" -gt 0 ] && [ "$gid" -gt 0 ] || exit 70
for bin in "$node_bin" "$setpriv_bin"; do
  case "$bin" in /*) ;; *) exit 72;; esac
  case "$bin" in *[!A-Za-z0-9/._+-]*) exit 72;; esac
done
exec "$setpriv_bin" --reuid="$uid" --regid="$gid" --init-groups --no-new-privs \
  -- "$node_bin" --input-type=module - <<'NODE'
import fs from 'node:fs';
const state = '/tmp/chat-notifications-cron';
const at = Date.now();
const taken = `${state}/taken`;
try { fs.renameSync(`${state}/armed`, taken); } catch (error) {
  if (error.code === 'ENOENT') process.exit(0);
  process.exit(1);
}
function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 4096) throw new Error('private_file');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
let status = 0;
try {
  if (readPrivate(taken) !== '1') throw new Error('invalid_arm');
  const secret = readPrivate(`${state}/secret`);
  const response = await fetch('http://127.0.0.1:3100/api/admin/cron/operations', {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jobKey: 'chat-notifications' }), signal: AbortSignal.timeout(55_000), redirect: 'error',
  });
  status = response.status;
  await response.body?.cancel();
} catch { /* Unknown HTTP outcome is recorded once. The driver never reposts. */ }
finally {
  fs.writeFileSync(`${state}/attempts.jsonl`, JSON.stringify({ at, status }) + '\n', {
    flag: fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    mode: 0o600,
  });
}
NODE
