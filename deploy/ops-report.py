#!/usr/bin/env python3
"""Controlled read-only storage & backup metadata reporter for PackJoyU (M6-T3).

Security and boundary invariants:
- No arbitrary path, file, URL, or secret CLI flags are accepted.
- Reads only controlled directories under NBSHIYAN_DATA_DIR (uploads/ and backup/),
  rejecting symlinks and never opening/reading upload or .dump file contents.
- Backup completion requires verified metadata (backup-meta.json or backup-postgres.sh
  completion log paired with an existing non-empty .dump archive). File existence alone,
  .dump.part files, or pg_restore --list logs NEVER mark verified=true (recoverable).
- Sends strictly whitelisted JSON to loopback POST /api/internal/ops-report with
  Authorization: Bearer <CRON_SECRET> and retries the exact same payload at most once
  on transient network/5xx errors. Never prints secrets, file paths, or filenames.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_REPORT_URL = 'http://127.0.0.1:3000/api/internal/ops-report'
REPORT_PATH = '/api/internal/ops-report'
LOOPBACK_HOSTS = {'127.0.0.1', 'localhost'}
HTTP_TIMEOUT_SECONDS = 15.0
MAX_SCAN_ENTRIES = 50_000
MAX_SCAN_DEPTH = 16
MAX_META_BYTES = 4096
MAX_LOG_TAIL_BYTES = 256 * 1024
MAX_SAFE_INTEGER = (1 << 53) - 1

ARCHIVE_NAME_RE = re.compile(r'^nbshiyan-(?:daily|weekly|pre-deploy)-\d{8}-\d{4}\.dump$')
BACKUP_LOG_LINE_RE = re.compile(
    r'^\[backup\] (nbshiyan-(?:daily|weekly|pre-deploy)-\d{8}-\d{4}\.dump) \S+; dir total \d+ MB$'
)
ALLOWED_META_KEYS = {'archiveName', 'backupCompletedAt', 'restoreVerified', 'restoreVerifiedAt'}


class ConfigError(Exception):
    """Sanitized configuration error (never includes secret values or host paths)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def format_utc(dt: datetime) -> str:
    utc = dt.astimezone(timezone.utc)
    ms = utc.microsecond // 1000
    return utc.strftime(f'%Y-%m-%dT%H:%M:%S.{ms:03d}Z')


def parse_utc(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', value):
        return None
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(timezone.utc)


def resolve_report_url(env: dict[str, str]) -> str:
    raw = env.get('OPS_REPORT_URL', '').strip()
    url = raw or DEFAULT_REPORT_URL
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'http':
        raise ConfigError('invalid_report_url')
    if parsed.hostname not in LOOPBACK_HOSTS:
        raise ConfigError('non_loopback_report_url')
    if parsed.path != REPORT_PATH or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ConfigError('invalid_report_url_path')
    try:
        _ = parsed.port
    except ValueError as exc:
        raise ConfigError('invalid_report_url_port') from exc
    return url


def resolve_data_dir(env: dict[str, str]) -> Path:
    raw = env.get('NBSHIYAN_DATA_DIR', '').strip()
    if not raw or '\x00' in raw or not os.path.isabs(raw):
        raise ConfigError('invalid_data_dir')
    target = Path(raw)
    try:
        st = os.lstat(target)
    except OSError as exc:
        raise ConfigError('data_dir_unreadable') from exc
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise ConfigError('data_dir_not_real_dir')
    return Path(os.path.realpath(target))


def parse_env_values(content: str, target_key: str) -> list[str]:
    found: list[str] = []
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key.strip() != target_key:
            continue
        val = value.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        if val:
            found.append(val)
    return found


def read_controlled_env_file(file_path: str, prefix: str) -> str:
    if not file_path or '\x00' in file_path or not os.path.isabs(file_path):
        raise ConfigError(f'invalid_{prefix}')
    try:
        st = os.lstat(file_path)
    except OSError as exc:
        raise ConfigError(f'{prefix}_unreadable') from exc
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise ConfigError(f'{prefix}_not_regular')
    if os.name == 'posix':
        mode = stat.S_IMODE(st.st_mode)
        if mode & 0o077:
            raise ConfigError(f'{prefix}_insecure_perms')
        if st.st_uid not in (0, os.getuid()):
            raise ConfigError(f'{prefix}_wrong_owner')
    try:
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(file_path, flags)
        try:
            with os.fdopen(fd, 'r', encoding='utf-8', errors='strict') as handle:
                return handle.read(256 * 1024)
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
    except (OSError, UnicodeDecodeError) as exc:
        raise ConfigError(f'{prefix}_read_failed') from exc


def resolve_deployed_app_env_file(env: dict[str, str], data_dir: Path) -> str:
    explicit = env.get('NBSHIYAN_APP_ENV_FILE', '').strip()
    if explicit:
        return explicit

    compose_env = data_dir / 'compose.env'
    try:
        os.lstat(compose_env)
    except FileNotFoundError:
        return str(data_dir / '.env')
    except OSError as exc:
        raise ConfigError('compose_env_unreadable') from exc

    compose_content = read_controlled_env_file(str(compose_env), 'compose_env')
    configured = parse_env_values(compose_content, 'NBSHIYAN_APP_ENV_FILE')
    if len(configured) > 1:
        raise ConfigError('invalid_compose_env')
    if len(configured) == 1:
        return configured[0]
    return str(data_dir / '.env')


def read_cron_secret(env: dict[str, str], data_dir: Path) -> str:
    direct = env.get('CRON_SECRET', '').strip()
    if direct:
        return direct
    env_file = resolve_deployed_app_env_file(env, data_dir)
    content = read_controlled_env_file(env_file, 'env_file')
    found = parse_env_values(content, 'CRON_SECRET')
    if len(found) != 1:
        raise ConfigError('missing_cron_secret')
    return found[0]


def resolve_controlled_subdir(data_dir: Path, name: str) -> tuple[str, Path | None]:
    """Return ('ok', real_path), ('missing', None), or ('failed', None)."""
    candidate = data_dir / name
    try:
        st = os.lstat(candidate)
    except FileNotFoundError:
        return ('missing', None)
    except OSError:
        return ('failed', None)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        return ('failed', None)
    real_child = Path(os.path.realpath(candidate))
    try:
        real_child.relative_to(data_dir)
    except ValueError:
        return ('failed', None)
    return ('ok', real_child)


def collect_storage(data_dir: Path, measured_dt: datetime) -> dict[str, object]:
    measured_at = format_utc(measured_dt)
    kind, uploads_dir = resolve_controlled_subdir(data_dir, 'uploads')
    if kind == 'missing' or uploads_dir is None:
        if kind == 'failed':
            return {
                'source': 'STORAGE',
                'measuredAt': measured_at,
                'status': 'FAILED',
                'safeErrorCode': 'service_unavailable',
            }
        return {
            'source': 'STORAGE',
            'measuredAt': measured_at,
            'status': 'NOT_CONNECTED',
            'safeErrorCode': 'source_unavailable',
        }

    bytes_used = 0
    scanned = 0
    queue: list[tuple[Path, int]] = [(uploads_dir, 0)]
    try:
        while queue:
            current, depth = queue.pop(0)
            with os.scandir(current) as it:
                for entry in it:
                    scanned += 1
                    if scanned > MAX_SCAN_ENTRIES:
                        return {
                            'source': 'STORAGE',
                            'measuredAt': measured_at,
                            'status': 'FAILED',
                            'safeErrorCode': 'service_unavailable',
                        }
                    if entry.is_symlink():
                        continue
                    st = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(st.st_mode):
                        continue
                    if stat.S_ISDIR(st.st_mode):
                        if depth + 1 > MAX_SCAN_DEPTH:
                            return {
                                'source': 'STORAGE',
                                'measuredAt': measured_at,
                                'status': 'FAILED',
                                'safeErrorCode': 'service_unavailable',
                            }
                        queue.append((Path(entry.path), depth + 1))
                    elif stat.S_ISREG(st.st_mode):
                        bytes_used = min(MAX_SAFE_INTEGER, bytes_used + max(0, int(st.st_size)))

        usage = shutil.disk_usage(uploads_dir)
        bytes_free = min(MAX_SAFE_INTEGER, max(0, int(usage.free)))
    except OSError:
        return {
            'source': 'STORAGE',
            'measuredAt': measured_at,
            'status': 'FAILED',
            'safeErrorCode': 'service_unavailable',
        }

    return {
        'source': 'STORAGE',
        'measuredAt': measured_at,
        'status': 'OK',
        'values': {
            'bytesUsed': bytes_used,
            'bytesFree': bytes_free,
        },
    }


def verify_archive_metadata(backup_dir: Path, archive_name: str) -> os.stat_result | None:
    """Stat-only verification of a controlled .dump archive; never opens or reads dump content."""
    if not ARCHIVE_NAME_RE.fullmatch(archive_name):
        return None
    archive_path = backup_dir / archive_name
    try:
        st = os.lstat(archive_path)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        return None
    if st.st_size <= 0:
        return None
    real_archive = Path(os.path.realpath(archive_path))
    if real_archive.parent != backup_dir:
        return None
    return st


def read_regular_text_bounded(path: Path, max_bytes: int, tail: bool = False) -> str | None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError:
        raise
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise OSError('not_regular_file')
    if not tail and st.st_size > max_bytes:
        raise OSError('file_too_large')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    try:
        if tail and st.st_size > max_bytes:
            os.lseek(fd, st.st_size - max_bytes, os.SEEK_SET)
        chunks: list[bytes] = []
        remaining = max_bytes
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b''.join(chunks).decode('utf-8', errors='replace')
    finally:
        os.close(fd)


def collect_backup(data_dir: Path, measured_dt: datetime) -> dict[str, object]:
    measured_at = format_utc(measured_dt)
    kind, backup_dir = resolve_controlled_subdir(data_dir, 'backup')
    if kind == 'failed':
        return {
            'source': 'BACKUP',
            'measuredAt': measured_at,
            'status': 'FAILED',
            'safeErrorCode': 'service_unavailable',
        }
    if kind == 'missing' or backup_dir is None:
        return {
            'source': 'BACKUP',
            'measuredAt': measured_at,
            'status': 'NOT_CONNECTED',
            'safeErrorCode': 'source_unavailable',
        }

    # Source 1: explicit structured metadata file (only source allowed to attest restoreVerified=true,
    # strictly bound to its matching archiveName).
    meta_candidate: tuple[str, datetime, bool] | None = None
    meta_path = backup_dir / 'backup-meta.json'
    try:
        meta_raw = read_regular_text_bounded(meta_path, MAX_META_BYTES, tail=False)
    except OSError:
        return {
            'source': 'BACKUP',
            'measuredAt': measured_at,
            'status': 'FAILED',
            'safeErrorCode': 'service_unavailable',
        }

    if meta_raw is not None:
        try:
            meta = json.loads(meta_raw)
        except ValueError:
            return {
                'source': 'BACKUP',
                'measuredAt': measured_at,
                'status': 'FAILED',
                'safeErrorCode': 'service_unavailable',
            }
        if not isinstance(meta, dict) or not set(meta.keys()).issubset(ALLOWED_META_KEYS):
            return {
                'source': 'BACKUP',
                'measuredAt': measured_at,
                'status': 'FAILED',
                'safeErrorCode': 'service_unavailable',
            }
        archive_name = meta.get('archiveName')
        completed_dt = parse_utc(meta.get('backupCompletedAt'))
        if not isinstance(archive_name, str) or completed_dt is None:
            return {
                'source': 'BACKUP',
                'measuredAt': measured_at,
                'status': 'FAILED',
                'safeErrorCode': 'service_unavailable',
            }
        if completed_dt > measured_dt or verify_archive_metadata(backup_dir, archive_name) is None:
            return {
                'source': 'BACKUP',
                'measuredAt': measured_at,
                'status': 'FAILED',
                'safeErrorCode': 'service_unavailable',
            }

        restore_verified = meta.get('restoreVerified', False)
        if not isinstance(restore_verified, bool):
            return {
                'source': 'BACKUP',
                'measuredAt': measured_at,
                'status': 'FAILED',
                'safeErrorCode': 'service_unavailable',
            }
        verified = False
        if restore_verified:
            verified_dt = parse_utc(meta.get('restoreVerifiedAt'))
            if verified_dt is None or verified_dt < completed_dt or verified_dt > measured_dt:
                return {
                    'source': 'BACKUP',
                    'measuredAt': measured_at,
                    'status': 'FAILED',
                    'safeErrorCode': 'service_unavailable',
                }
            verified = True

        meta_candidate = (archive_name, completed_dt, verified)

    # Source 2: existing deploy/backup-postgres.sh completion log paired with the real archive stat.
    # backup-postgres.sh only runs `pg_restore --list`, which is NOT a restore verification,
    # so `verified` MUST always remain False for log-only archives.
    log_candidate: tuple[str, datetime, bool] | None = None
    log_path = backup_dir / 'backup.log'
    try:
        log_raw = read_regular_text_bounded(log_path, MAX_LOG_TAIL_BYTES, tail=True)
    except OSError:
        return {
            'source': 'BACKUP',
            'measuredAt': measured_at,
            'status': 'FAILED',
            'safeErrorCode': 'service_unavailable',
        }

    if log_raw is not None:
        best_order: tuple[datetime, int] | None = None
        for idx, line in enumerate(log_raw.splitlines()):
            match = BACKUP_LOG_LINE_RE.match(line.strip())
            if not match:
                continue
            archive_name = match.group(1)
            archive_stat = verify_archive_metadata(backup_dir, archive_name)
            if archive_stat is None:
                continue
            completed_dt = datetime.fromtimestamp(archive_stat.st_mtime, tz=timezone.utc)
            if completed_dt > measured_dt:
                return {
                    'source': 'BACKUP',
                    'measuredAt': measured_at,
                    'status': 'FAILED',
                    'safeErrorCode': 'service_unavailable',
                }
            order = (completed_dt, idx)
            if best_order is None or order >= best_order:
                best_order = order
                log_candidate = (archive_name, completed_dt, False)

    # Select the archive with the latest trustworthy completion time.
    # Restore verification (verified=True) strictly belongs to meta_candidate's archiveName only.
    chosen: tuple[str, datetime, bool] | None = None
    if meta_candidate is not None and log_candidate is not None:
        if log_candidate[0] == meta_candidate[0]:
            chosen = meta_candidate
        elif log_candidate[1] > meta_candidate[1]:
            chosen = log_candidate
        else:
            chosen = meta_candidate
    elif meta_candidate is not None:
        chosen = meta_candidate
    elif log_candidate is not None:
        chosen = log_candidate

    if chosen is not None:
        _, chosen_completed_dt, chosen_verified = chosen
        age_seconds = min(MAX_SAFE_INTEGER, max(0, int((measured_dt - chosen_completed_dt).total_seconds())))
        return {
            'source': 'BACKUP',
            'measuredAt': measured_at,
            'status': 'OK',
            'values': {
                'backupCompletedAt': format_utc(chosen_completed_dt),
                'backupAgeSeconds': age_seconds,
                'verified': chosen_verified,
            },
        }

    # No verifiable backup completion record (isolated files or .dump.part never count as completion).
    return {
        'source': 'BACKUP',
        'measuredAt': measured_at,
        'status': 'NOT_CONNECTED',
        'safeErrorCode': 'source_unavailable',
    }


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject all 3xx responses so Bearer credentials are never forwarded on redirects."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

    def http_error_302(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(req.full_url, code, 'redirect_rejected', headers, fp)

    http_error_301 = http_error_302
    http_error_303 = http_error_302
    http_error_307 = http_error_302
    http_error_308 = http_error_302


def post_report(url: str, secret: str, payload: dict[str, object]) -> tuple[int, bool]:
    """Post one strictly whitelisted report, rejecting 3xx and retrying 5xx/network at most once."""
    body = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    headers = {
        'Authorization': f'Bearer {secret}',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirectHandler())
    last_status = 0
    for attempt in range(2):
        req = urllib.request.Request(url, data=body, headers=headers, method='POST')
        try:
            with opener.open(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
                if 300 <= resp.status < 400:
                    return (resp.status, False)
                raw = resp.read(4096).decode('utf-8', errors='replace')
                parsed = json.loads(raw) if raw else {}
                accepted = bool(isinstance(parsed, dict) and parsed.get('accepted') is True)
                return (resp.status, accepted)
        except urllib.error.HTTPError as err:
            last_status = err.code
            if 500 <= err.code < 600 and attempt == 0:
                continue
            return (err.code, False)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            last_status = 0
            if attempt == 0:
                continue
            return (0, False)
    return (last_status, False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='ops-report.py',
        description='Read-only controlled storage and backup metadata reporter.',
        allow_abbrev=False,
    )
    parser.add_argument('--source', choices=('all', 'storage', 'backup'), default='all')
    parser.add_argument('--dry-run', action='store_true')
    return parser


def main(argv: list[str] | None = None, env: dict[str, str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    effective_env = os.environ if env is None else env
    try:
        data_dir = resolve_data_dir(dict(effective_env))
        report_url = resolve_report_url(dict(effective_env))
        secret = '' if args.dry_run else read_cron_secret(dict(effective_env), data_dir)
    except ConfigError as exc:
        print(f'ops-report config_error code={exc.code}', file=sys.stderr)
        return 2

    measured_dt = datetime.now(timezone.utc)
    payloads: list[dict[str, object]] = []
    if args.source in ('all', 'storage'):
        payloads.append(collect_storage(data_dir, measured_dt))
    if args.source in ('all', 'backup'):
        payloads.append(collect_backup(data_dir, measured_dt))

    if args.dry_run:
        print(json.dumps(payloads, separators=(',', ':'), sort_keys=True))
        return 0

    exit_code = 0
    for payload in payloads:
        status_code, accepted = post_report(report_url, secret, payload)
        source_name = payload.get('source', 'UNKNOWN')
        report_status = payload.get('status', 'UNKNOWN')
        print(
            f'ops-report source={source_name} status={report_status} '
            f'http={status_code} accepted={str(accepted).lower()}'
        )
        if status_code < 200 or status_code >= 300:
            exit_code = 1
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
