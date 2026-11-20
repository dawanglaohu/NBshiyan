#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T10 发布收件门 R5：单次读取、整块遮盖、no-replace 原子发布。

用法（CI-STEP.sh 的接口未变）：
  T10-EVIDENCE-ADMISSION.py --run <RUN 目录> --check <check-run.json> --out <发布目录>
                            [--receipt-only]

退出码 0 = 发布目录已整包原子写出；1 = 拒收。
拒收时不创建/不修改 --out，stdout 只有一行 T10_ADMISSION_REJECTED:<code>，
不回显被拒字段、路径或原始诊断。

本脚本不启动浏览器/服务/数据库，不修改任何输入，不读取压缩包或凭据。
时区校验使用运行环境的真实 IANA 数据（zoneinfo/tzdata）；环境缺 tzdata 时一律 fail-closed。
"""

import argparse
import ctypes
import datetime
import errno
import hashlib
import json
import math
import os
import re
import shutil
import struct
import sys
import uuid
import zlib
from functools import lru_cache
from zoneinfo import ZoneInfo

RUN_SCHEMA = "m5t10-state-capture/2"
CHECK_SCHEMA = "t10-state-run-check/2"
PUBLIC_SCHEMA = "m5t10-state-public/3"
PUBLIC_FILE = "m5t10-STATE-RUN.json"

VIEWPORTS = {"1920x1080": (1920, 1080), "1440x900": (1440, 900), "390x844": (390, 844)}
ORDER = ["1920x1080", "1440x900", "390x844"]
STATES = ["empty", "loading", "load-failed", "retry-recovered", "saved"]
EXPECTED = [(state, viewport) for state in STATES for viewport in ORDER]
MOBILE = "390x844"

ALERT_OK = {"The result couldn't be confirmed.", "The result couldn't be confirmed. 重试"}
NET_ERRORS = {
    "net::ERR_INTERNET_DISCONNECTED", "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_REFUSED",
    "net::ERR_CONNECTION_CLOSED", "net::ERR_FAILED", "net::ERR_ABORTED", "net::ERR_TIMED_OUT",
    "net::ERR_EMPTY_RESPONSE",
}
TEST_IDS = {
    "空/无重算": "empty",
    "加载中": "loading",
    "加载失败与重试": "load-failed",
    "保存结果": "saved",
}
NULL_TEXT = "无可用重算待办（null 不表示重建已完成）"
MASK_SELECTOR = '[data-testid="admin-account"]'
MASK_COLOR = "#FF00FF"
MASK_RGB = b"\xff\x00\xff"
MASK_RGBA = b"\xff\x00\xff\xff"

ROUTE_API = "/api/admin/settings/analytics"
ROUTE_LANDING = "/admin/settings?section=analytics"
CTRL_SELECTORS = {
    "input": '[data-testid="analytics-settings-input"]',
    "save": '[data-testid="analytics-settings-save"]',
    "retry": 'p.st-ferr[role="alert"] button',
}
BLOCK_SELECTORS = {"loading": "p.st-hint", "load-failed": 'p.st-ferr[role="alert"]'}

FIXED_SOURCES = [
    "src/components/admin/stats/AnalyticsSettingsContainer.tsx",
    "src/components/admin/stats/AnalyticsSettingsContainer.module.css",
    "src/components/admin/settings/settings.css",
    "src/components/admin/settings/SettingsSections.tsx",
    "src/app/admin/settings/page.tsx",
    "src/app/api/admin/settings/analytics/route.ts",
    "src/lib/server/analytics/settings.ts",
    "src/lib/client/ops.ts",
    "src/lib/client/api.ts",
    "src/lib/client/api-errors.ts",
    "src/lib/contracts/analytics.ts",
    "e2e/analytics-settings.spec.ts",
    "e2e/density-evidence.ts",
    "e2e/t10-state-capture.spec.ts",
]

SIG = b"\x89PNG\r\n\x1a\n"
KEEP = {b"IHDR", b"IDAT", b"IEND"}
# 只允许会被整块丢弃的作色块；可携文本/EXIF/未知块一律拒收。
ANCILLARY_DROP = {b"sRGB", b"gAMA", b"cHRM", b"pHYs", b"iCCP"}
MAX_FILE = 48 << 20
MAX_RAW = 160 << 20
MAX_CHUNK = 4 << 20
MAX_CHUNKS = 4096
MAX_DIM_H = 40000
CHANNELS = {2: 3, 6: 4}

HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
RUN_ID = re.compile(r"^\d{8}T\d{6}Z-w\d{1,3}-r0-[0-9a-f]{6}$")
BUILD_ID = re.compile(r"^[A-Za-z0-9_-]{6,80}$")
PATCH_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
ZONE = re.compile(r"^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,3})$")
ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|\+00:00)$")
SAFE_REL = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")
PX = re.compile(r"^(auto|normal|none|\d{1,4}(\.\d{1,2})?px)$")
STATUS_READ = re.compile(r"^已读取最新配置（version \d{1,9}）；你的输入保留。$")
STATUS_SAVED = re.compile(r"^✓ 已保存：version \d{1,9} · revision \d{1,9} · 已登记重算$")
PARTIAL = re.compile(
    r"^partial：仅 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z 起可重算；更早历史保留原时区标签$")
ABS_WIN = re.compile(r"^[A-Za-z]:[\\/]")
ABS_POSIX = re.compile(r"^/(home|tmp|var|runner|builds|workspace|root|mnt|Users)(/|$)")


class Reject(Exception):
    """固定拒收码。detail 只用于内部断言，绝不打印。"""

    def __init__(self, code, detail=""):
        super().__init__(code)
        self.code = code
        self.detail = detail


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _no_constant(name):
    raise ValueError("non-finite constant")


def load_json(path, code, limit=8 << 20):
    try:
        if os.path.getsize(path) > limit:
            raise Reject(code)
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle, parse_constant=_no_constant)
    except Reject:
        raise
    except (OSError, ValueError, UnicodeDecodeError):
        raise Reject(code)
    if not isinstance(value, dict):
        raise Reject(code)
    return value


# ---------------------------------------------------------------- 值域

def bad(code, detail=""):
    raise Reject(code, detail)


def is_num(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def num(value, lo, hi, code):
    if not is_num(value):
        bad(code)
    if value < lo or value > hi:
        bad(code)
    return int(value) if isinstance(value, float) and value.is_integer() else value


def integer(value, lo, hi, code):
    if not isinstance(value, int) or isinstance(value, bool) or value < lo or value > hi:
        bad(code)
    return value


def flag(value, code):
    if not isinstance(value, bool):
        bad(code)
    return value


def enum(value, allowed, code):
    if value not in allowed:
        bad(code)
    return value


def text(value, pattern, code, maxlen=200):
    if not isinstance(value, str) or len(value) > maxlen or not pattern.match(value):
        bad(code)
    return value


@lru_cache(maxsize=512)
def _iana_known(name):
    try:
        ZoneInfo(name)
        return True
    except Exception:
        return False


def zone(value, code):
    """公开的业务时区必须是真实 IANA 名称（用运行环境的 tzdata 实际加载）。"""
    text(value, ZONE, code, 64)
    if not _iana_known(value):
        bad(code)
    return value


def utc_text(value, code):
    if not isinstance(value, str) or len(value) > 40 or not ISO_UTC.match(value):
        bad(code)
    stamp = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        bad(code)
    return stamp.astimezone(datetime.timezone.utc)


def utc_out(stamp):
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (stamp.microsecond // 1000)


def rect_out(value, code):
    if not isinstance(value, dict):
        bad(code)
    x = num(value.get("x"), -200000, 200000, code)
    y = num(value.get("y"), -200000, 200000, code)
    width = num(value.get("width"), 0, 200000, code)
    height = num(value.get("height"), 0, 200000, code)
    out = {"x": x, "y": y, "width": width, "height": height,
           "left": x, "right": x + width, "top": y, "bottom": y + height}
    for key in ("left", "right", "top", "bottom"):
        if key in value:
            if abs(num(value[key], -400000, 400000, code) - out[key]) > 0.75:
                bad(code)
    return out


def scan_absolute(node, path=""):
    hits = []
    if isinstance(node, dict):
        for key, value in node.items():
            hits += scan_absolute(value, path + "/" + str(key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            hits += scan_absolute(value, path + "[%d]" % index)
    elif isinstance(node, str):
        if "http://" in node or "https://" in node:
            hits.append(path + ":url")
        elif ABS_WIN.match(node) or ABS_POSIX.match(node):
            hits.append(path + ":abs")
    return hits


# ---------------------------------------------------------------- PNG

class PngImage(object):
    __slots__ = ("data", "width", "height", "channels", "raw", "stride", "rowbytes",
                 "chunks", "stripped", "_cache", "_next")

    def __init__(self, data, width, height, channels, raw, chunks, stripped):
        self.data = data
        self.width = width
        self.height = height
        self.channels = channels
        self.raw = raw
        self.rowbytes = width * channels
        self.stride = 1 + self.rowbytes
        self.chunks = chunks
        self.stripped = stripped
        self._cache = {}
        self._next = 0

    def public_bytes(self):
        return SIG + b"".join(self.data[start:end] for kind, start, end in self.chunks if kind in KEEP)

    def row(self, y):
        if y in self._cache:
            return self._cache[y]
        for i in range(self._next, y + 1):
            base = i * self.stride
            ftype = self.raw[base]
            line = bytearray(self.raw[base + 1:base + 1 + self.rowbytes])
            if ftype:
                prev = self._cache.get(i - 1) or bytes(self.rowbytes)
                bpp = self.channels
                if ftype == 1:
                    for j in range(bpp, self.rowbytes):
                        line[j] = (line[j] + line[j - bpp]) & 0xFF
                elif ftype == 2:
                    for j in range(self.rowbytes):
                        line[j] = (line[j] + prev[j]) & 0xFF
                elif ftype == 3:
                    for j in range(self.rowbytes):
                        left = line[j - bpp] if j >= bpp else 0
                        line[j] = (line[j] + ((left + prev[j]) >> 1)) & 0xFF
                else:
                    for j in range(self.rowbytes):
                        a = line[j - bpp] if j >= bpp else 0
                        b = prev[j]
                        c = prev[j - bpp] if j >= bpp else 0
                        p = a + b - c
                        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                        pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                        line[j] = (line[j] + pr) & 0xFF
            self._cache[i] = bytes(line)
            self._next = i + 1
        return self._cache[y]

    def painted(self, x, y, width, height):
        # 边缘 1px 允许抗锯齿/对齐误差，内部必须是整块不透明遮罩色。
        if width >= 3 and height >= 3:
            x, y, width, height = x + 1, y + 1, width - 2, height - 2
        unit = MASK_RGB if self.channels == 3 else MASK_RGBA
        needle = unit * width
        for row in range(y, y + height):
            start = x * self.channels
            if self.row(row)[start:start + len(needle)] != needle:
                return False
        return True


def parse_png(data, limit_ok=True):
    """只接受 Chromium 截图的 PNG profile：8 位、RGB/RGBA、非隔行、块序固定。"""
    if len(data) < 8 or data[:8] != SIG:
        bad("IMG_SIGNATURE")
    if limit_ok and len(data) > MAX_FILE:
        bad("IMG_LIMIT")
    pos = 8
    chunks = []
    stripped = []
    ihdr = None
    seen_ihdr = False
    idat = bytearray()
    idat_started = False
    idat_done = False
    saw_iend = False
    count = 0
    while pos < len(data):
        if pos + 8 > len(data):
            bad("IMG_TRUNCATED")
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        if length > MAX_CHUNK:
            bad("IMG_LIMIT")
        end = pos + 12 + length
        if end > len(data):
            bad("IMG_TRUNCATED")
        kind = data[pos + 4:pos + 8]
        payload = data[pos + 8:pos + 8 + length]
        crc = struct.unpack(">I", data[pos + 8 + length:end])[0]
        if (zlib.crc32(kind + payload) & 0xFFFFFFFF) != crc:
            bad("IMG_CRC")
        count += 1
        if count > MAX_CHUNKS:
            bad("IMG_LIMIT")
        if kind == b"IHDR":
            if seen_ihdr:
                bad("IMG_IHDR_DUP")
            if chunks:
                bad("IMG_CHUNK_ORDER")
            if length != 13:
                bad("IMG_IHDR")
            ihdr = struct.unpack(">IIBBBBB", payload)
            seen_ihdr = True
        elif kind == b"IDAT":
            if not seen_ihdr or idat_done:
                bad("IMG_CHUNK_ORDER")
            idat_started = True
            idat.extend(payload)
        elif kind == b"IEND":
            if length != 0:
                bad("IMG_IEND")
            if not idat_started:
                bad("IMG_NO_IDAT")
            if idat_done:
                bad("IMG_CHUNK_ORDER")
            idat_done = True
        else:
            if kind not in ANCILLARY_DROP:
                bad("IMG_CHUNK")
            if idat_started:
                bad("IMG_CHUNK_ORDER")
            stripped.append(kind.decode("latin-1"))
        chunks.append((kind, pos, end))
        pos = end
        if kind == b"IEND":
            saw_iend = True
            break
        if idat_done:
            bad("IMG_CHUNK_ORDER")
    if not saw_iend:
        bad("IMG_TRUNCATED")
    if pos != len(data):
        bad("IMG_IEND")
    if ihdr is None:
        bad("IMG_IHDR")
    width, height, depth, color, comp, filt, interlace = ihdr
    if width < 1 or height < 1 or width > 8192 or height > MAX_DIM_H:
        bad("IMG_LIMIT")
    if depth != 8 or color not in CHANNELS:
        bad("IMG_IHDR")
    if comp != 0 or filt != 0 or interlace != 0:
        bad("IMG_IHDR")
    if not idat:
        bad("IMG_NO_IDAT")
    channels = CHANNELS[color]
    rowbytes = width * channels
    stride = 1 + rowbytes
    needed = height * stride
    if needed > MAX_RAW:
        bad("IMG_LIMIT")
    inflater = zlib.decompressobj()
    try:
        raw = inflater.decompress(bytes(idat), needed + 1)
    except zlib.error:
        bad("IMG_IDAT")
    if len(raw) != needed:
        bad("IMG_RAWLEN")
    if inflater.unconsumed_tail or inflater.unused_data or not inflater.eof:
        bad("IMG_IDAT")
    for index in range(height):
        if raw[index * stride] > 4:
            bad("IMG_FILTER")
    return PngImage(data, width, height, channels, raw, chunks, sorted(set(stripped)))


# ---------------------------------------------------------------- RUN / CHECK

def verify_check_run(check, run_dir, run):
    if check.get("schema") != CHECK_SCHEMA:
        bad("CHECK_SCHEMA")
    source = check.get("source") or {}
    if not isinstance(source, dict):
        bad("CHECK_SCHEMA")
    if os.path.realpath(str(source.get("run") or "")) != os.path.realpath(run_dir):
        bad("CHECK_BINDING")
    identity = run.get("identity") or {}
    git = identity.get("git") or {}
    build = identity.get("build") or {}
    if source.get("expectSha") != git.get("head"):
        bad("CHECK_BINDING")
    if source.get("expectTree") != git.get("tree"):
        bad("CHECK_BINDING")
    if source.get("expectBuildId") != build.get("value"):
        bad("CHECK_BINDING")
    checks = check.get("checks")
    if not isinstance(checks, list) or not checks or len(checks) > 5000:
        bad("CHECKRUN_SUMMARY")
    for row in checks:
        if not isinstance(row, dict) or row.get("result") != "PASS":
            bad("CHECKRUN_FAILED")
    summary = check.get("summary") or {}
    if not isinstance(summary, dict):
        bad("CHECKRUN_SUMMARY")
    if summary.get("failed") != 0 or summary.get("total") != len(checks) or summary.get("verdict") != "PASS":
        bad("CHECKRUN_SUMMARY")
    return len(checks)


def verify_run(run):
    if run.get("schema") != RUN_SCHEMA:
        bad("RUN_SCHEMA")
    if run.get("closed") is not True:
        bad("RUN_NOT_CLOSED")
    started = utc_text(run.get("startedAt"), "RUN_TIME")
    finished = utc_text(run.get("finishedAt"), "RUN_TIME")
    if finished < started:
        bad("RUN_TIME_ORDER")
    if finished - started > datetime.timedelta(hours=6):
        bad("RUN_TIME_SPAN")
    text(run.get("runId"), RUN_ID, "RUN_ID")
    states = run.get("states")
    files = run.get("files")
    if not isinstance(states, list) or len(states) != 15:
        bad("RUN_MATRIX")
    pairs = set()
    for row in states:
        if not isinstance(row, dict):
            bad("RUN_MATRIX")
        state, viewport = row.get("state"), row.get("viewport")
        if state not in STATES or viewport not in VIEWPORTS:
            bad("RUN_MATRIX")
        pairs.add((state, viewport))
    if pairs != set(EXPECTED):
        bad("RUN_MATRIX")
    names = {"state-%s-%s.png" % pair for pair in EXPECTED}
    if not isinstance(files, list) or len(files) != 15:
        bad("RUN_FILES")
    if {row.get("file") for row in files if isinstance(row, dict)} != names:
        bad("RUN_FILES")
    tests = run.get("tests")
    if not isinstance(tests, list) or len(tests) != 4:
        bad("RUN_TESTS")
    seen = set()
    for row in tests:
        if not isinstance(row, dict):
            bad("RUN_TESTS")
        title = row.get("title")
        if not isinstance(title, str) or len(title) > 200:
            bad("RUN_TESTS")
        matched = [key for key in TEST_IDS if key in title]
        if len(matched) != 1:
            bad("RUN_TESTS")
        seen.add(TEST_IDS[matched[0]])
        if row.get("status") != "passed":
            bad("RUN_TESTS")
        integer(row.get("retry"), 0, 0, "RUN_TESTS")
    if seen != set(TEST_IDS.values()):
        bad("RUN_TESTS")
    return states, files


def read_image(path):
    """每张图只读一次；摘要、解析、遮盖、重封都用这同一份快照。"""
    if os.path.islink(path) or not os.path.isfile(path):
        bad("IMG_MISSING")
    size = os.path.getsize(path)
    if size > MAX_FILE:
        bad("IMG_LIMIT")
    with open(path, "rb") as handle:
        data = handle.read(MAX_FILE + 1)
    if len(data) != size:
        bad("IMG_DIGEST")
    return data


def mask_header(run):
    safety = run.get("safety")
    if not isinstance(safety, dict):
        bad("MASK_NOT_PROVEN")
    if safety.get("credentialsInRun") is not False:
        bad("SAFETY_CREDENTIALS")
    if safety.get("fullUrlsStored") is not False:
        bad("SAFETY_URLS")
    if safety.get("screenshotsMayShowSyntheticAdminName") is not False:
        bad("MASK_FLAG")
    mask = safety.get("accountMask")
    if not isinstance(mask, dict):
        bad("MASK_NOT_PROVEN")
    if mask.get("selector") != MASK_SELECTOR:
        bad("MASK_NOT_PROVEN")
    color = mask.get("maskColor")
    if color is not None and str(color).lower() != "#ff00ff":
        bad("MASK_NOT_PROVEN")
    shots = mask.get("shots")
    if not isinstance(shots, dict) or set(shots) != {"state-%s-%s.png" % pair for pair in EXPECTED}:
        bad("MASK_NOT_PROVEN")
    if mask.get("applied") is not None and not isinstance(mask.get("applied"), bool):
        bad("MASK_NOT_PROVEN")
    return mask, shots


def _computed_fields(shot):
    """已封 producer 形状：嵌套 computed；不接受平铺旧字段。"""
    computed = shot.get("computed")
    return None if not isinstance(computed, dict) else computed


def check_mask_shot(shot, name, state, viewport, digest, image):
    """固定单 locator：一个整矩形覆盖实际账号裁剪区，整块像素校验。"""
    if not isinstance(shot, dict):
        bad("MASK_NOT_PROVEN")
    if shot.get("file") != name or shot.get("state") != state or shot.get("viewport") != viewport:
        bad("MASK_BINDING")
    if not isinstance(shot.get("sha256"), str) or shot.get("sha256").lower() != digest:
        bad("MASK_BINDING")
    status = shot.get("status", shot.get("disposition"))
    if status not in ("masked", "not-visible"):
        bad("MASK_NOT_PROVEN")
    integer(shot.get("count"), 0, 1, "MASK_NOT_PROVEN")
    rects = shot.get("rects")
    if not isinstance(rects, list):
        bad("MASK_RECT")
    nav = shot.get("nav")
    if nav is not None:
        if nav not in ("open", "closed") or viewport != MOBILE:
            bad("MASK_NOT_PROVEN")
    selector = shot.get("selector")
    if selector is not None and selector != MASK_SELECTOR:
        bad("MASK_NOT_PROVEN")
    color = shot.get("maskColor")
    if color is not None and str(color).lower() != "#ff00ff":
        bad("MASK_NOT_PROVEN")
    mobile = shot.get("mobile")
    if not isinstance(mobile, bool) or mobile is not (viewport == MOBILE):
        bad("MASK_NOT_PROVEN")
    sidebar = shot.get("sidebar")
    if not isinstance(sidebar, dict) or sidebar.get("mode") not in ("static", "drawer"):
        bad("MASK_NOT_PROVEN")
    if not isinstance(sidebar.get("visible"), bool) or not isinstance(sidebar.get("inert"), bool):
        bad("MASK_NOT_PROVEN")
    if sidebar.get("visibility") not in ("visible", "hidden", "collapse"):
        bad("MASK_NOT_PROVEN")
    box = shot.get("accountBox")
    if not isinstance(box, dict):
        bad("MASK_RECT")
    bx = integer(box.get("x"), -200000, 200000, "MASK_RECT")
    by = integer(box.get("y"), -200000, 200000, "MASK_RECT")
    bw = integer(box.get("width"), 0, 200000, "MASK_RECT")
    bh = integer(box.get("height"), 0, 200000, "MASK_RECT")
    scroll = shot.get("scroll")
    if not isinstance(scroll, dict):
        bad("MASK_RECT")
    sx = num(scroll.get("x"), -200000, 200000, "MASK_RECT")
    sy = num(scroll.get("y"), -200000, 200000, "MASK_RECT")
    account_rect = shot.get("accountRect")
    if not isinstance(account_rect, dict):
        bad("MASK_RECT")
    ax = num(account_rect.get("x"), -200000, 200000, "MASK_RECT")
    ay = num(account_rect.get("y"), -200000, 200000, "MASK_RECT")
    aw = num(account_rect.get("width"), 0, 200000, "MASK_RECT")
    ah = num(account_rect.get("height"), 0, 200000, "MASK_RECT")
    if abs(ax + sx - bx) > 2 or abs(ay + sy - by) > 2:
        bad("MASK_RECT")
    if abs(aw - bw) > 2 or abs(ah - bh) > 2:
        bad("MASK_RECT")
    computed = _computed_fields(shot)
    if computed is None:
        bad("MASK_NOT_PROVEN")
    visibility = computed.get("visibility")
    display = computed.get("display")
    opacity = computed.get("opacity")
    if visibility not in ("visible", "hidden", "collapse"):
        bad("MASK_NOT_PROVEN")
    if display not in ("block", "inline", "inline-block", "inline-flex", "flex", "none", "grid",
                       "table", "table-cell", "contents"):
        bad("MASK_NOT_PROVEN")
    if isinstance(opacity, bool) or not isinstance(opacity, (str, int, float)):
        bad("MASK_NOT_PROVEN")
    try:
        opaque = float(opacity)
    except (TypeError, ValueError):
        bad("MASK_NOT_PROVEN")
    if opaque == 0:
        bad("MASK_NOT_PROVEN")
    x0, y0 = max(0, bx), max(0, by)
    x1, y1 = min(image.width, bx + bw), min(image.height, by + bh)
    if status == "masked":
        if nav == "closed":
            bad("MASK_NOT_PROVEN")
        if visibility in ("hidden", "collapse") or display == "none":
            bad("MASK_NOT_PROVEN")
        if x1 - x0 < 1 or y1 - y0 < 1:
            bad("MASK_NOT_PROVEN")
        if len(rects) != 1:
            bad("MASK_RECT")
        rect = rects[0]
        if not isinstance(rect, list) or len(rect) != 4:
            bad("MASK_RECT")
        x, y, width, height = (integer(v, -200000, 200000, "MASK_RECT") for v in rect)
        if width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > image.width or y + height > image.height:
            bad("MASK_RECT")
        if abs(x - x0) > 1 or abs(y - y0) > 1 or abs(x + width - x1) > 1 or abs(y + height - y1) > 1:
            bad("MASK_RECT")
        if not image.painted(x, y, width, height):
            bad("MASK_PAINT")
        return "masked"
    if viewport != MOBILE:
        bad("MASK_NOT_PROVEN")
    if rects:
        bad("MASK_NOT_PROVEN")
    if shot.get("intersectsOutput") is not False:
        bad("MASK_NOT_PROVEN")
    if x1 - x0 >= 1 and y1 - y0 >= 1:
        bad("MASK_NOT_PROVEN")
    return "notVisible"


def stage_images(run_dir, states, files, shots, staging, publish_images):
    by_name = {row["file"]: row for row in files}
    state_shot = {}
    for row in states:
        name = "state-%s-%s.png" % (row["state"], row["viewport"])
        shot = row.get("screenshot")
        if not isinstance(shot, dict) or shot.get("file") != name:
            bad("IMG_FACT")
        if shot.get("state") != row["state"] or shot.get("viewport") != row["viewport"]:
            bad("IMG_FACT")
        state_shot[name] = shot
    facts = {}
    seen_source = set()
    seen_public = set()
    counts = {"masked": 0, "notVisible": 0}
    for state, viewport in EXPECTED:
        name = "state-%s-%s.png" % (state, viewport)
        entry = by_name[name]
        shot = state_shot[name]
        data = read_image(os.path.join(run_dir, name))
        digest = sha256_bytes(data)
        size = len(data)
        for obj in (entry, shot):
            if obj.get("bytes") != size or obj.get("sha256") != digest:
                bad("IMG_DIGEST")
        if digest in seen_source:
            bad("IMG_DUPLICATE")
        seen_source.add(digest)
        image = parse_png(data)
        width, height = VIEWPORTS[viewport]
        if image.width != width:
            bad("IMG_WIDTH")
        if image.height < height or image.height > MAX_DIM_H:
            bad("IMG_HEIGHT")
        for obj in (entry, shot):
            if obj.get("fullPage") is not True:
                bad("IMG_FULLPAGE")
            png = obj.get("png")
            if not isinstance(png, dict):
                bad("IMG_FACT")
            if png.get("width") != image.width or png.get("height") != image.height:
                bad("IMG_FACT")
        if publish_images:
            counts[check_mask_shot(shots[name], name, state, viewport, digest, image)] += 1
        public = image.public_bytes()
        public_sha = sha256_bytes(public)
        if public_sha in seen_public:
            bad("IMG_DUPLICATE_PUBLIC")
        seen_public.add(public_sha)
        check = parse_png(public)
        if (check.width, check.height) != (image.width, image.height) or check.raw != image.raw:
            bad("IMG_PUBLIC")
        if publish_images:
            with open(os.path.join(staging, name), "wb") as handle:
                handle.write(public)
        facts[name] = {
            "state": state, "viewport": viewport, "width": image.width, "height": image.height,
            "channels": image.channels, "sourceBytes": size, "sourceSha256": digest.upper(),
            "publicBytes": len(public), "publicSha256": public_sha.upper(),
            "stripped": image.stripped,
        }
        del image, check, public
    return facts, counts


# ---------------------------------------------------------------- 状态判据

def verify_retry(states):
    """390 重试控件重算 44px；桌面只要求可见且正尺寸。"""
    for row in states:
        if row.get("state") != "load-failed":
            continue
        viewport = row["viewport"]
        layout = row.get("layout") or {}
        controls = layout.get("controls") or {}
        retry = controls.get("retry")
        if not isinstance(retry, dict):
            bad("RETRY_MISSING")
        if retry.get("visible") is not True:
            bad("RETRY_VISIBLE")
        if retry.get("selector") != CTRL_SELECTORS["retry"]:
            bad("RETRY_SELECTOR")
        rect = retry.get("rect")
        if not isinstance(rect, dict):
            bad("RETRY_RECT")
        width = num(rect.get("width"), 0, 5000, "RETRY_RECT")
        height = num(rect.get("height"), 0, 5000, "RETRY_RECT")
        if width <= 0 or height <= 0:
            bad("RETRY_RECT")
        computed = retry.get("computed") or {}
        if not isinstance(computed, dict):
            bad("RETRY_RECT")
        if computed.get("display") == "none" or computed.get("visibility") in ("hidden", "collapse"):
            bad("RETRY_HIDDEN")
        if viewport == MOBILE and (width < 44 or height < 44):
            bad("RETRY_TARGET")


def verify_saved(states):
    patches = []
    for row in states:
        if row.get("state") != "saved":
            continue
        body = row.get("body")
        patch = row.get("patch")
        if not isinstance(body, dict) or not isinstance(patch, dict) or not isinstance(patch.get("body"), dict):
            bad("SAVED_BODY_MISSING")
        if json.dumps(body, sort_keys=True) != json.dumps(patch["body"], sort_keys=True):
            bad("SAVED_BODY_MISMATCH")
        ui = row.get("ui") or {}
        expected = "✓ 已保存：version %s · revision %s · 已登记重算" % (
            body.get("version"), body.get("timezoneRevision"))
        if " ".join(str(ui.get("status") or "").split()) != expected:
            bad("SAVED_UI_TEXT")
        if ui.get("inputValue") != body.get("timezone"):
            bad("SAVED_UI_INPUT")
        text(patch.get("id"), PATCH_ID, "SAVED_PATCH_ID", 64)
        patches.append(patch)
    if len(patches) != 3:
        bad("SAVED_COUNT")
    if integer(patches[0].get("count"), 0, 20, "SAVED_PATCH_COUNT") != 1:
        bad("SAVED_PATCH_COUNT")
    if len({p.get("id") for p in patches}) != 1:
        bad("SAVED_SHARED_ID")
    for key in ("request", "body", "status"):
        if len({json.dumps(p.get(key), sort_keys=True) for p in patches}) != 1:
            bad("SAVED_SHARED_" + key.upper())


def verify_alert(states):
    alerts = set()
    for row in states:
        if row.get("state") != "load-failed":
            continue
        failure = row.get("failure")
        if not isinstance(failure, dict):
            bad("ALERT_TEXT")
        alert = failure.get("alertText")
        if not isinstance(alert, str):
            bad("ALERT_TEXT")
        alert = norm_text(alert)
        if alert not in ALERT_OK:
            bad("ALERT_TEXT")
        alerts.add(alert)
        if failure.get("alertVisible") is not True or failure.get("retryVisible") is not True:
            bad("ALERT_TEXT")
        if failure.get("errorText") not in NET_ERRORS:
            bad("ALERT_CODE")
    if len(alerts) != 1:
        bad("ALERT_TEXT")


# ---------------------------------------------------------------- 公开投影

def project_dto(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    rebuild = value.get("rebuildScheduled")
    if rebuild is not None:
        flag(rebuild, "PUBLIC_FIELD")
    return {
        "version": integer(value.get("version"), 0, 1000000, "PUBLIC_FIELD"),
        "timezone": zone(value.get("timezone"), "PUBLIC_FIELD"),
        "timezoneRevision": integer(value.get("timezoneRevision"), 0, 1000000, "PUBLIC_FIELD"),
        "recomputableFrom": None if value.get("recomputableFrom") is None
        else utc_out(utc_text(value.get("recomputableFrom"), "PUBLIC_FIELD")),
        "rebuildScheduled": rebuild,
    }


def project_change(value):
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    return {"timezone": zone(value.get("timezone"), "PUBLIC_FIELD"),
            "expectedVersion": integer(value.get("expectedVersion"), 0, 1000000, "PUBLIC_FIELD")}


def project_computed(value):
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    display = enum(value.get("display"),
                   {"block", "inline", "inline-block", "inline-flex", "flex", "none", "grid",
                    "table", "table-cell", "contents"}, "PUBLIC_FIELD")
    visibility = enum(value.get("visibility"), {"visible", "hidden", "collapse"}, "PUBLIC_FIELD")
    out = {"display": display, "visibility": visibility}
    for key in ("minWidth", "minHeight"):
        item = value.get(key)
        out[key] = None if item is None else text(item, PX, "PUBLIC_FIELD", 16)
    return out


def project_control(value, key):
    if value is None:
        return None
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    if value.get("selector") != CTRL_SELECTORS[key]:
        bad("PUBLIC_FIELD")
    return {"selector": CTRL_SELECTORS[key], "visible": flag(value.get("visible"), "PUBLIC_FIELD"),
            "rect": rect_out(value.get("rect"), "PUBLIC_FIELD"),
            "computed": project_computed(value.get("computed"))}


def project_layout(value, state, viewport):
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    if value.get("viewport") != viewport:
        bad("PUBLIC_FIELD")
    width = VIEWPORTS[viewport][0]
    client = integer(value.get("htmlClientWidth"), 100, 10000, "PUBLIC_FIELD")
    scroll = integer(value.get("htmlScrollWidth"), 100, 10000, "PUBLIC_FIELD")
    if abs(client - width) > 40:
        bad("PUBLIC_FIELD")
    controls = value.get("controls")
    if not isinstance(controls, dict):
        bad("PUBLIC_FIELD")
    block = value.get("block")
    if block is None:
        block_out = None
    else:
        if not isinstance(block, dict) or block.get("selector") != BLOCK_SELECTORS.get(state):
            bad("PUBLIC_FIELD")
        block_out = {"selector": BLOCK_SELECTORS[state], "rect": rect_out(block.get("rect"), "PUBLIC_FIELD"),
                     "visible": flag(block.get("visible"), "PUBLIC_FIELD"),
                     "gapFromTitle": None if block.get("gapFromTitle") is None
                     else num(block.get("gapFromTitle"), -200, 2000, "PUBLIC_FIELD"),
                     "leftDeltaFromTitle": None if block.get("leftDeltaFromTitle") is None
                     else num(block.get("leftDeltaFromTitle"), -2000, 2000, "PUBLIC_FIELD")}
    sparse = value.get("sparse")
    if sparse is None:
        sparse_out = None
    else:
        rule = sparse.get("rule") if isinstance(sparse, dict) else None
        if not isinstance(rule, str) or not rule.startswith("D5") or len(rule) > 300:
            bad("PUBLIC_FIELD")
        if integer(sparse.get("count"), 0, 1000, "PUBLIC_FIELD") != 0:
            bad("PUBLIC_FIELD")
        if sparse.get("offenders") != []:
            bad("PUBLIC_FIELD")
        sparse_out = {"rule": "D5", "count": 0, "offenders": []}
    return {"viewport": viewport, "htmlClientWidth": client, "htmlScrollWidth": scroll,
            "overflowX": num(value.get("overflowX"), 0, 100000, "PUBLIC_FIELD"),
            "page": None if value.get("page") is None else rect_out(value.get("page"), "PUBLIC_FIELD"),
            "title": None if value.get("title") is None else rect_out(value.get("title"), "PUBLIC_FIELD"),
            "block": block_out, "sparse": sparse_out,
            "controls": {key: project_control(controls.get(key), key) for key in ("input", "save", "retry")}}


def project_observed(value, viewport):
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    width, height = VIEWPORTS[viewport]
    requested = value.get("requested")
    if not isinstance(requested, dict):
        bad("PUBLIC_FIELD")
    if integer(requested.get("width"), 1, 10000, "PUBLIC_FIELD") != width:
        bad("PUBLIC_FIELD")
    if integer(requested.get("height"), 1, 10000, "PUBLIC_FIELD") != height:
        bad("PUBLIC_FIELD")
    inner_width = integer(value.get("innerWidth"), 100, 10000, "PUBLIC_FIELD")
    inner_height = integer(value.get("innerHeight"), 100, 10000, "PUBLIC_FIELD")
    if not (width - 40 <= inner_width <= width) or not (height - 40 <= inner_height <= height):
        bad("PUBLIC_FIELD")
    if num(value.get("devicePixelRatio"), 0.5, 4, "PUBLIC_FIELD") != 1:
        bad("PUBLIC_FIELD")
    return {"requested": {"width": width, "height": height},
            "innerWidth": inner_width, "innerHeight": inner_height, "devicePixelRatio": 1}


def project_get(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    count = integer(value.get("count"), 1, 4, "PUBLIC_FIELD")
    urls = value.get("urls")
    if not isinstance(urls, list) or len(urls) != count or any(u != ROUTE_API for u in urls):
        bad("PUBLIC_FIELD")
    if value.get("documentRoute") != ROUTE_LANDING:
        bad("PUBLIC_FIELD")
    bodies = value.get("bodies")
    if not isinstance(bodies, list) or len(bodies) != count:
        bad("PUBLIC_FIELD")
    out = []
    for row in bodies:
        if not isinstance(row, dict):
            bad("PUBLIC_FIELD")
        ok = flag(row.get("ok"), "PUBLIC_FIELD")
        if row.get("url") != ROUTE_API:
            bad("PUBLIC_FIELD")
        if ok:
            if integer(row.get("status"), 100, 599, "PUBLIC_FIELD") != 200:
                bad("PUBLIC_FIELD")
            if row.get("reason") is not None:
                bad("PUBLIC_FIELD")
            out.append({"ok": True, "status": 200, "reason": None, "url": ROUTE_API,
                        "json": project_dto(row.get("json"))})
        else:
            if row.get("status") is not None:
                bad("PUBLIC_FIELD")
            if row.get("reason") != "fetch":
                bad("PUBLIC_FIELD")
            if row.get("json") is not None:
                bad("PUBLIC_FIELD")
            out.append({"ok": False, "status": None, "reason": "fetch", "url": ROUTE_API, "json": None})
    return {"count": count, "urls": [ROUTE_API] * count, "documentRoute": ROUTE_LANDING, "bodies": out}


def norm_text(value):
    return " ".join(str(value).split())


def project_ui(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    status = value.get("status")
    if status is not None:
        status = norm_text(status)
        if not (STATUS_READ.match(status) or STATUS_SAVED.match(status)):
            bad("PUBLIC_FIELD")
    recomputable = value.get("recomputable")
    if recomputable is not None:
        recomputable = norm_text(recomputable)
        if recomputable != NULL_TEXT and not PARTIAL.match(recomputable):
            bad("PUBLIC_FIELD")
    alert = value.get("alert")
    if alert is not None:
        alert = norm_text(alert)
        if alert not in ALERT_OK:
            bad("PUBLIC_FIELD")
    revision = value.get("revision")
    if revision is not None:
        revision = norm_text(revision)
        text(revision, re.compile(r"^\d{1,9}$"), "PUBLIC_FIELD", 10)
    version_revision = value.get("versionRevision")
    if version_revision is not None:
        version_revision = norm_text(version_revision)
        text(version_revision, re.compile(r"^version \d{1,9} · revision \d{1,9}$"), "PUBLIC_FIELD", 40)
    input_value = value.get("inputValue")
    if input_value is None:
        out_input, has_input = None, False
    elif isinstance(input_value, str):
        has_input = input_value != ""
        out_input = input_value if (input_value == "" or _iana_known(input_value)) else None
    else:
        bad("PUBLIC_FIELD")
    timezone = value.get("timezone")
    if timezone is not None:
        timezone = norm_text(timezone)
        zone(timezone, "PUBLIC_FIELD")
    return {"timezone": timezone,
            "revision": revision, "versionRevision": version_revision, "recomputable": recomputable,
            "status": status, "alert": alert, "rebuild": flag(value.get("rebuild"), "PUBLIC_FIELD"),
            "inputValue": out_input, "hasInput": has_input}


def project_loading(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    if value.get("sentence") is None or norm_text(value.get("sentence")) != "加载中…":
        bad("PUBLIC_FIELD")
    if value.get("sentenceVisible") is not True:
        bad("PUBLIC_FIELD")
    for key in ("inputPresent", "savePresent", "alertPresent"):
        if value.get(key) is not False:
            bad("PUBLIC_FIELD")
    if integer(value.get("patchRequests"), 0, 5, "PUBLIC_FIELD") != 0:
        bad("PUBLIC_FIELD")
    return {"sentence": "加载中…", "sentenceVisible": True, "inputPresent": False,
            "savePresent": False, "alertPresent": False, "patchRequests": 0}


def project_failure(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    mode = value.get("mode")
    if not isinstance(mode, str) or "route.abort(internetdisconnected)" not in mode:
        bad("PUBLIC_FIELD")
    if value.get("errorText") not in NET_ERRORS:
        bad("PUBLIC_FIELD")
    if value.get("alertVisible") is not True or value.get("retryVisible") is not True:
        bad("PUBLIC_FIELD")
    alert = value.get("alertText")
    if not isinstance(alert, str):
        bad("PUBLIC_FIELD")
    alert = norm_text(alert)
    if alert not in ALERT_OK:
        bad("PUBLIC_FIELD")
    return {"mode": "route.abort(internetdisconnected)", "errorText": value.get("errorText"),
            "alertVisible": True, "alertText": alert, "retryVisible": True,
            "responsesBeforeRetry": integer(value.get("responsesBeforeRetry"), 0, 10, "PUBLIC_FIELD"),
            "matchedRequests": integer(value.get("matchedRequests"), 1, 20, "PUBLIC_FIELD"),
            "abortedRequests": integer(value.get("abortedRequests"), 1, 20, "PUBLIC_FIELD")}


def project_recovery(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    if value.get("oldAlertGone") is not True:
        bad("PUBLIC_FIELD")
    feedback = value.get("feedback")
    if not isinstance(feedback, str):
        bad("PUBLIC_FIELD")
    feedback = norm_text(feedback)
    if not STATUS_READ.match(feedback):
        bad("PUBLIC_FIELD")
    return {"oldAlertGone": True, "feedback": feedback,
            "apiResponses": integer(value.get("apiResponses"), 1, 10, "PUBLIC_FIELD"),
            "getCount": integer(value.get("getCount"), 1, 10, "PUBLIC_FIELD")}


def project_patch(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    patch_id = text(value.get("id"), PATCH_ID, "PUBLIC_FIELD", 64)
    request = project_change(value.get("request"))
    page = project_change(value.get("pageRequest"))
    if request != page:
        bad("PUBLIC_FIELD")
    if integer(value.get("status"), 100, 599, "PUBLIC_FIELD") != 200:
        bad("PUBLIC_FIELD")
    counts = {}
    for key in ("count", "captured", "countAtResponse", "capturedAtResponse",
                "countAtEnd", "capturedAtEnd", "screenshotsAfterPatch"):
        counts[key] = integer(value.get(key), 0, 20, "PUBLIC_FIELD")
    if counts["count"] != counts["captured"] or counts["count"] != counts["countAtEnd"]:
        bad("PUBLIC_FIELD")
    if counts["countAtResponse"] != counts["capturedAtResponse"]:
        bad("PUBLIC_FIELD")
    return {"id": patch_id, "request": request, "pageRequest": page, "status": 200,
            "body": project_dto(value.get("body")), "screenshotsAfterPatch": counts["screenshotsAfterPatch"],
            "count": counts["count"], "captured": counts["captured"],
            "countAtResponse": counts["countAtResponse"], "capturedAtResponse": counts["capturedAtResponse"],
            "countAtEnd": counts["countAtEnd"], "capturedAtEnd": counts["capturedAtEnd"]}


def project_route_hold(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        bad("PUBLIC_FIELD")
    mode = value.get("mode")
    if not isinstance(mode, str) or "hold-then-continue" not in mode:
        bad("PUBLIC_FIELD")
    if value.get("uiCapturedBeforeRelease") is not True or value.get("screenshotBeforeRelease") is not True:
        bad("PUBLIC_FIELD")
    return {"mode": "hold-then-continue",
            "heldCount": integer(value.get("heldCount"), 1, 3, "PUBLIC_FIELD"),
            "heldMs": integer(value.get("heldMs"), 0, 60000, "PUBLIC_FIELD"),
            "clientDeadlineMs": integer(value.get("clientDeadlineMs"), 1000, 600000, "PUBLIC_FIELD"),
            "uiCapturedBeforeRelease": True, "screenshotBeforeRelease": True}


def project_shot(fact):
    return {"state": fact["state"], "viewport": fact["viewport"],
            "file": "state-%s-%s.png" % (fact["state"], fact["viewport"]),
            "bytes": fact["sourceBytes"], "sha256": fact["sourceSha256"],
            "fullPage": True, "png": {"width": fact["width"], "height": fact["height"]},
            "publicBytes": fact["publicBytes"], "publicSha256": fact["publicSha256"],
            "stripped": fact["stripped"]}


def project_identity(run):
    identity = run.get("identity")
    if not isinstance(identity, dict):
        bad("PUBLIC_FIELD")
    git = identity.get("git")
    build = identity.get("build")
    sources = identity.get("sources")
    if not isinstance(git, dict) or not isinstance(build, dict):
        bad("PUBLIC_FIELD")
    head = text(git.get("head"), HEX40, "PUBLIC_FIELD", 40)
    tree = text(git.get("tree"), HEX40, "PUBLIC_FIELD", 40)
    value = text(build.get("value"), BUILD_ID, "PUBLIC_FIELD", 80)
    if not isinstance(sources, list) or len(sources) != len(FIXED_SOURCES):
        bad("PUBLIC_FIELD")
    seen = {}
    for row in sources:
        if not isinstance(row, dict):
            bad("PUBLIC_FIELD")
        rel = row.get("path")
        if not isinstance(rel, str) or not SAFE_REL.match(rel) or ".." in rel or rel.startswith("/"):
            bad("PUBLIC_FIELD")
        seen[rel] = {"path": rel, "bytes": integer(row.get("bytes"), 0, 10 << 20, "PUBLIC_FIELD"),
                     "sha256": text(row.get("sha256"), HEX64, "PUBLIC_FIELD", 64)}
    if set(seen) != set(FIXED_SOURCES):
        bad("PUBLIC_FIELD")
    return {"git": {"head": head, "tree": tree}, "build": {"value": value},
            "sources": [seen[rel] for rel in FIXED_SOURCES]}


def project_tests(run):
    out = []
    for row in run["tests"]:
        title = row["title"]
        matched = [key for key in TEST_IDS if key in title]
        out.append({"id": TEST_IDS[matched[0]], "status": "passed", "retry": row["retry"]})
    return out


def build_public(run, states, files, facts, mask_info, image_count):
    rows = {row["state"] + "/" + row["viewport"]: row for row in states}
    projected = []
    for state, viewport in EXPECTED:
        row = rows[state + "/" + viewport]
        name = "state-%s-%s.png" % (state, viewport)
        projected.append({
            "state": state, "viewport": viewport,
            "observed": project_observed(row.get("observed"), viewport),
            "layout": project_layout(row.get("layout"), state, viewport),
            "get": project_get(row.get("get")),
            "body": project_dto(row.get("body")),
            "ui": project_ui(row.get("ui")),
            "postReleaseUi": project_ui(row.get("postReleaseUi")),
            "loadingFacts": project_loading(row.get("loadingFacts")),
            "failure": project_failure(row.get("failure")),
            "recovery": project_recovery(row.get("recovery")),
            "patch": project_patch(row.get("patch")),
            "route": project_route_hold(row.get("route")),
            "screenshot": project_shot(facts[name]),
        })
    started = utc_text(run.get("startedAt"), "RUN_TIME")
    finished = utc_text(run.get("finishedAt"), "RUN_TIME")
    return {
        "schema": PUBLIC_SCHEMA,
        "claim": "T10 状态采集公开投影：逐层白名单重建的固定字段、仓内相对路径与经准入的截图；不含原始诊断、备注、主机路径或完整 URL。",
        "mode": "full",
        "runId": run.get("runId"),
        "startedAt": utc_out(started), "finishedAt": utc_out(finished), "closed": True,
        "identity": project_identity(run),
        "tests": project_tests(run),
        "states": projected,
        "files": [project_shot(facts["state-%s-%s.png" % pair]) for pair in EXPECTED],
        "safety": {"credentialsInRun": False, "fullUrlsStored": False,
                   "screenshotsMayShowSyntheticAdminName": False, "accountMask": mask_info},
        "admission": {"verdict": "PASS", "images": image_count, "mask": "proven"},
    }


def build_receipt(run, states, facts, check_total):
    started = utc_text(run.get("startedAt"), "RUN_TIME")
    finished = utc_text(run.get("finishedAt"), "RUN_TIME")
    counts = {state: 0 for state in STATES}
    for fact in facts.values():
        counts[fact["state"]] += 1
    patches = set()
    for row in states:
        if row.get("state") == "saved" and isinstance(row.get("patch"), dict):
            patch = row["patch"]
            patches.add((patch.get("id"), json.dumps(patch.get("request"), sort_keys=True)))
    return {
        "schema": PUBLIC_SCHEMA,
        "claim": "T10 发布回执：只含固定身份、状态计数与准入结论；不含任何状态明细、诊断或截图记录。",
        "mode": "receipt-only",
        "runId": run.get("runId"),
        "startedAt": utc_out(started), "finishedAt": utc_out(finished), "closed": True,
        "identity": project_identity(run),
        "tests": [{"id": row["id"], "status": row["status"]} for row in project_tests(run)],
        "counts": {"states": len(facts), "screenshots": 0, "publishedImages": 0,
                   "verifiedImages": len(facts), "savedViews": counts["saved"],
                   "savedPatches": len(patches), "loadFailed": counts["load-failed"],
                   "retryRecovered": counts["retry-recovered"], "loading": counts["loading"],
                   "empty": counts["empty"], "retries": 0},
        "check": {"total": check_total, "failed": 0, "verdict": "PASS"},
        "safety": {"credentialsInRun": False, "fullUrlsStored": False, "accountMaskVerified": False},
        "admission": {"verdict": "PASS", "images": 0, "mask": "not-published", "reason": "receipt-only"},
    }


# ---------------------------------------------------------------- 原子发布

def make_staging(out_dir):
    parent = os.path.dirname(out_dir) or "."
    if os.path.lexists(out_dir):
        bad("OUT_EXISTS")
    try:
        os.makedirs(parent, exist_ok=True)
    except OSError:
        bad("OUT_WRITE_FAILED")
    temp = out_dir + ".tmp-" + uuid.uuid4().hex[:12]
    try:
        os.makedirs(temp, exist_ok=False)
    except OSError:
        bad("OUT_WRITE_FAILED")
    return temp


def rename_noreplace(source, target):
    """no-replace 由原语保证；不存在『先查再普通 rename』的回退。"""
    if os.name == "nt":
        try:
            os.rename(source, target)
        except OSError as exc:
            if isinstance(exc, FileExistsError) or getattr(exc, "winerror", None) == 183:
                bad("OUT_EXISTS")
            bad("OUT_WRITE_FAILED")
        return
    if sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        try:
            func = libc.renameat2
        except AttributeError:
            bad("OUT_NO_REPLACE_UNSUPPORTED")
        func.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        func.restype = ctypes.c_int
        rc = func(-100, os.fsencode(source), -100, os.fsencode(target), 1)
        if rc == 0:
            return
        err = ctypes.get_errno()
        if err in (errno.EEXIST, errno.ENOTEMPTY):
            bad("OUT_EXISTS")
        if err in (errno.EINVAL, errno.ENOSYS, errno.ENOTSUP):
            bad("OUT_NO_REPLACE_UNSUPPORTED")
        bad("OUT_WRITE_FAILED")
    bad("OUT_NO_REPLACE_UNSUPPORTED")


def finish_publish(temp, out_dir, expected, facts):
    if set(os.listdir(temp)) != expected:
        bad("OUT_WRITE_FAILED")
    for name in expected - {PUBLIC_FILE}:
        path = os.path.join(temp, name)
        if os.path.islink(path) or not os.path.isfile(path):
            bad("OUT_WRITE_FAILED")
        if sha256_file(path).upper() != facts[name]["publicSha256"]:
            bad("OUT_WRITE_FAILED")
    rename_noreplace(temp, out_dir)


def check_out(out_dir, run_dir):
    if not out_dir or out_dir.rstrip("\\/") == "":
        bad("OUT_INVALID")
    try:
        common = os.path.commonpath([os.path.abspath(out_dir), os.path.abspath(run_dir)])
    except ValueError:
        return
    if common == os.path.abspath(run_dir):
        bad("OUT_INVALID")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--check", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--receipt-only", action="store_true",
                        help="只写固定回执，不发布任何 PNG（遮盖未证时的安全回退）")
    args = parser.parse_args()

    run_dir = os.path.abspath(args.run)
    out_dir = os.path.abspath(args.out)
    temp = None
    published = 0
    public = None
    try:
        check_out(out_dir, run_dir)
        run = load_json(os.path.join(run_dir, "m5t10-STATE-RUN.json"), "RUN_UNREADABLE")
        check = load_json(args.check, "CHECK_UNREADABLE")
        states, files = verify_run(run)
        check_total = verify_check_run(check, run_dir, run)
        verify_retry(states)
        verify_saved(states)
        verify_alert(states)
        safety = run.get("safety")
        if not isinstance(safety, dict) or safety.get("credentialsInRun") is not False:
            bad("SAFETY_CREDENTIALS")
        if safety.get("fullUrlsStored") is not False:
            bad("SAFETY_URLS")
        publish_images = not args.receipt_only
        if publish_images:
            mask, shots = mask_header(run)
        else:
            mask, shots = None, {}
        published = len(EXPECTED) if publish_images else 0
        temp = make_staging(out_dir)
        facts, counts = stage_images(run_dir, states, files, shots, temp, publish_images)
        if publish_images:
            for key in ("masked", "notVisible"):
                if mask.get(key) is not None and integer(mask.get(key), 0, 15, "MASK_NOT_PROVEN") != counts[key]:
                    bad("MASK_NOT_PROVEN")
            applied = mask.get("applied")
            if applied is not None and applied is not (counts["masked"] > 0):
                bad("MASK_NOT_PROVEN")
            mask_info = {"selector": MASK_SELECTOR, "color": MASK_COLOR, "verified": True,
                         "shots": len(facts), "masked": counts["masked"],
                         "notVisible": counts["notVisible"]}
            public = build_public(run, states, files, facts, mask_info, published)
        else:
            public = build_receipt(run, states, facts, check_total)
        leaks = scan_absolute(public)
        if leaks:
            bad("PUBLIC_ABSOLUTE")
        payload = json.dumps(public, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        with open(os.path.join(temp, PUBLIC_FILE), "wb") as handle:
            handle.write(payload)
        expected = {PUBLIC_FILE}
        if publish_images:
            expected |= {"state-%s-%s.png" % pair for pair in EXPECTED}
        finish_publish(temp, out_dir, expected, facts)
        temp = None
    except Reject as exc:
        if temp:
            shutil.rmtree(temp, ignore_errors=True)
        print("T10_ADMISSION_REJECTED:%s" % exc.code)
        return 1
    except OSError:
        if temp:
            shutil.rmtree(temp, ignore_errors=True)
        print("T10_ADMISSION_REJECTED:OUT_WRITE_FAILED")
        return 1
    except Exception:
        if temp:
            shutil.rmtree(temp, ignore_errors=True)
        print("T10_ADMISSION_REJECTED:INTERNAL")
        return 1
    entries = len(os.listdir(out_dir))
    print("T10_ADMISSION=PASS")
    print("T10_ADMISSION_IMAGES=%d" % published)
    print("T10_ADMISSION_ENTRIES=%d" % entries)
    print("T10_ADMISSION_MASK=%s" % public["admission"]["mask"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
