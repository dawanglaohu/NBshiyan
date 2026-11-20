#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读复核 m5t10-STATE-RUN.json（R2）：身份、收尾、15 个独立截图、同笔绑定与异常态布局。

不启动浏览器/服务/数据库，不改任何输入文件。它复核 capture spec 自己写的 RUN 是否
自洽、是否覆盖 5 状态×3 视口、截图是否与 RUN 哈希/IHDR 一致；不替代 Playwright 断言。

必填：--run、--expect-sha、--expect-tree、--expect-build-id、--repo。
--repo 是本次采集实际使用的隔离 checkout；14 项源文件会重新哈希比对。
"""

import argparse
import hashlib
import json
import os
import re
import struct
import sys

VIEWPORTS = ["1920x1080", "1440x900", "390x844"]
STATES = ["empty", "loading", "load-failed", "retry-recovered", "saved"]
EXPECTED = {(state, vp) for state in STATES for vp in VIEWPORTS}
NULL_TEXT = "无可用重算待办（null 不表示重建已完成）"
LOAD_FAILED_SENTENCE = "The result couldn't be confirmed."
CLIENT_DEADLINE_MS = 15_000
EXPECTED_SOURCES = [
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
EXPECTED_TEST_KEYWORDS = ["空/无重算", "加载中", "加载失败", "保存结果"]
HSV = re.compile(r"^[a-f0-9]{64}$", re.IGNORECASE)


def js_iso(value):
    """按 JS Date#toISOString 归一：UTC、3 位毫秒、Z 结尾。"""
    if value is None:
        return None
    text = str(value)
    try:
        from datetime import datetime, timezone
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc)
        return parsed.strftime("%Y-%m-%dT%H:%M:%S.") + f"{parsed.microsecond // 1000:03d}Z"
    except ValueError:
        return text


def recomputable_text(value):
    if value is None:
        return NULL_TEXT
    return f"partial：仅 {js_iso(value)} 起可重算；更早历史保留原时区标签"


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_header(path):
    with open(path, "rb") as handle:
        if handle.read(8) != b"\x89PNG\r\n\x1a\n":
            return None
        length = struct.unpack(">I", handle.read(4))[0]
        if handle.read(4) != b"IHDR" or length != 13:
            return None
        width, height = struct.unpack(">II", handle.read(8))
        return {"width": width, "height": height}


def is_relative_path(value):
    if not isinstance(value, str) or not value:
        return False
    if os.path.isabs(value) or re.match(r"^[A-Za-z]:", value):
        return False
    return not value.startswith(("/", "\\"))


def norm_text(value):
    return " ".join(str(value or "").split())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--expect-sha", required=True)
    parser.add_argument("--expect-tree", required=True)
    parser.add_argument("--expect-build-id", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    run_dir = os.path.abspath(args.run)
    repo = os.path.abspath(args.repo)
    checks = []

    def add(cid, target, actual, expected, ok=None):
        if ok is None:
            ok = actual == expected
        checks.append({
            "id": cid,
            "target": target,
            "expected": expected,
            "actual": actual,
            "result": "PASS" if ok else "FAIL",
        })
        return ok

    def add_true(cid, target, actual, expected=True):
        return add(cid, target, actual, expected, bool(actual) == bool(expected))

    run_path = os.path.join(run_dir, "m5t10-STATE-RUN.json")
    try:
        with open(run_path, "r", encoding="utf-8") as handle:
            run = json.load(handle)
    except OSError as exc:
        add("R0", "RUN readable", str(exc), "readable", False)
        return finish(checks, args, run_dir)

    # ---- 顶层：schema/收尾/测试 ----
    add("R1", "schema", run.get("schema"), "m5t10-state-capture/2")
    add_true("R2", "claim non-empty", bool(str(run.get("claim") or "").strip()))
    add_true("R3", "closed", run.get("closed") is True)
    add("R4", "finishedAt", run.get("finishedAt"), run.get("finishedAt"), isinstance(run.get("finishedAt"), str) and bool(run.get("finishedAt")))
    states = run.get("states") or []
    files = run.get("files") or []
    tests = run.get("tests") or []
    add("R5", "states count", len(states), len(EXPECTED))
    matrix = {(row.get("state"), row.get("viewport")) for row in states}
    add("R6", "state×viewport matrix", sorted(matrix), sorted(EXPECTED))
    add("R7", "states unique", len(matrix), len(states))
    add("R8", "files count", len(files), len(EXPECTED))
    add("R9", "tests count", len(tests), 4)
    add("R10", "tests all passed", [row.get("status") for row in tests], ["passed"] * 4)
    titles = [str(row.get("title") or "") for row in tests]
    add("R11", "tests unique titles", len(set(titles)), len(titles))
    missing_keywords = [key for key in EXPECTED_TEST_KEYWORDS if not any(key in title for title in titles)]
    add("R12", "tests cover four states", missing_keywords, [])

    computed_summary = {
        "states": len(states),
        "screenshots": len(files),
        "boundBodies": sum(1 for row in states if row.get("body") is not None),
        "testsTotal": len(tests),
        "testsPassed": sum(1 for row in tests if row.get("status") == "passed"),
    }
    add("R13", "summary exact", run.get("summary"), computed_summary)
    add("R14", "summary counts", computed_summary, {
        "states": 15, "screenshots": 15, "boundBodies": 12, "testsTotal": 4, "testsPassed": 4,
    })

    # ---- 身份：真实 HEAD/tree/BUILD_ID、干净工作树、14 项源 ----
    identity = run.get("identity") or {}
    git = identity.get("git") or {}
    env = identity.get("env") or {}
    build = identity.get("build") or {}
    carrier = identity.get("carrier") or {}
    add("R20", "identity.git.head", git.get("head"), args.expect_sha)
    add("R21", "identity.git.tree", git.get("tree"), args.expect_tree)
    add_true("R22", "identity.git.dirtyTracked is null", git.get("dirtyTracked") is None)
    add("R23", "identity.env.GITHUB_SHA", env.get("GITHUB_SHA"), args.expect_sha)
    add("R24", "identity.build.value", build.get("value"), args.expect_build_id)
    add_true("R25", "build.path relative and BUILD_ID", is_relative_path(build.get("path")) and str(build.get("path")).endswith("BUILD_ID"))
    add_true("R26", "carrier.serverEntryExists", carrier.get("serverEntryExists") is True)
    add_true("R27", "carrier.buildIdPath relative and BUILD_ID",
             is_relative_path(carrier.get("buildIdPath")) and str(carrier.get("buildIdPath")).endswith("BUILD_ID"))

    build_copy = identity.get("buildCopy") or {}
    copy_name = build_copy.get("file")
    if copy_name:
        copy_path = os.path.join(run_dir, copy_name)
        exists = os.path.isfile(copy_path)
        add_true("R28", f"{copy_name} exists", exists)
        if exists:
            add("R29", f"{copy_name} bytes", os.path.getsize(copy_path), build_copy.get("bytes"))
            add("R30", f"{copy_name} sha256", sha256_file(copy_path), build_copy.get("sha256"))
            with open(copy_path, "r", encoding="utf-8") as handle:
                add("R31", f"{copy_name} value", handle.read().strip(), build.get("value"))
    else:
        add_true("R28", "buildCopy.file present", False)

    sources = identity.get("sources") or []
    source_paths = [row.get("path") for row in sources]
    add("R32", "sources count", len(source_paths), len(EXPECTED_SOURCES))
    add("R33", "sources exact paths", sorted(source_paths), sorted(EXPECTED_SOURCES))
    bad_source_format = [row.get("path") for row in sources
                         if not HSV.match(str(row.get("sha256") or "")) or not isinstance(row.get("bytes"), int) or row.get("bytes") <= 0]
    add("R34", "sources sha256/bytes", bad_source_format, [])
    source_mismatch = []
    if os.path.isdir(repo):
        for row in sources:
            rel = row.get("path")
            if rel not in EXPECTED_SOURCES:
                continue
            target = os.path.join(repo, rel)
            if not os.path.isfile(target):
                source_mismatch.append(f"{rel}:missing")
                continue
            actual_hash = sha256_file(target)
            if actual_hash != row.get("sha256"):
                source_mismatch.append(f"{rel}:{actual_hash[:12]}!={str(row.get('sha256'))[:12]}")
    else:
        source_mismatch.append(f"repo missing: {repo}")
    add("R35", "sources re-hash against repo", source_mismatch, [])

    add_true("R36", "root relative", is_relative_path(run.get("root")))
    safety = run.get("safety") or {}
    add("R37", "safety flags", [safety.get("credentialsInRun"), safety.get("fullUrlsStored")], [False, False])

    # ---- 截图：15 个规范化文件名、独立哈希、IHDR、文件清单 ----
    expected_names = {f"state-{state}-{vp}.png" for state, vp in EXPECTED}
    file_names = [row.get("file") for row in files]
    add("R40", "file names exact set", sorted(file_names), sorted(expected_names))
    add("R41", "file names unique", len(set(file_names)), len(file_names))
    add("R42", "file sha256 unique", len({row.get("sha256") for row in files}), len(files))
    actual_pngs = sorted(name for name in os.listdir(run_dir) if name.startswith("state-") and name.endswith(".png"))
    add("R43", "no extra state PNG", actual_pngs, sorted(expected_names))
    file_by_name = {row.get("file"): row for row in files}
    shot_mismatch = []
    png_mismatch = []
    for row in files:
        name = row.get("file")
        target = os.path.join(run_dir, name) if name else ""
        if not name or not os.path.isfile(target):
            shot_mismatch.append(f"{name}:missing")
            continue
        if os.path.getsize(target) != row.get("bytes") or sha256_file(target) != row.get("sha256"):
            shot_mismatch.append(f"{name}:bytes/sha")
        header = png_header(target)
        shot_png = row.get("png") or {}
        if header is None or header != shot_png:
            png_mismatch.append(f"{name}:header={header} png={shot_png}")
    add("R44", "screenshots bytes/sha", shot_mismatch, [])
    add("R45", "screenshots IHDR matches RUN png", png_mismatch, [])

    # ---- 逐状态：布局、GET 字段、状态事实、保存同笔 ----
    by_key = {(row.get("state"), row.get("viewport")): row for row in states}
    saved_patches = []
    for state, vp in sorted(EXPECTED):
        row = by_key.get((state, vp)) or {}
        label = f"{state}/{vp}"
        width = int(vp.split("x")[0])
        height = int(vp.split("x")[1])
        observed = row.get("observed") or {}
        requested = observed.get("requested") or {}
        add(f"{label} V1", "requested viewport", requested, {"width": width, "height": height})
        add(f"{label} V2", "observed innerWidth/Height",
            {"innerWidth": observed.get("innerWidth"), "innerHeight": observed.get("innerHeight")},
            {"innerWidth": width, "innerHeight": height})

        shot = row.get("screenshot") or {}
        name = shot.get("file")
        add(f"{label} S1", "screenshot file", name, f"state-{state}-{vp}.png")
        target = os.path.join(run_dir, name) if name else ""
        exists = bool(name) and os.path.isfile(target)
        add_true(f"{label} S2", "screenshot exists", exists)
        if exists:
            add(f"{label} S3", "screenshot bytes", os.path.getsize(target), shot.get("bytes"))
            add(f"{label} S4", "screenshot sha256", sha256_file(target), shot.get("sha256"))
            header = png_header(target)
            add(f"{label} S5", "screenshot png header", header, shot.get("png"))
            add_true(f"{label} S6", "screenshot width", (header or {}).get("width") == width)
            add_true(f"{label} S7", "screenshot height>=120", (header or {}).get("height", 0) >= 120)
            add_true(f"{label} S8", "fullPage", shot.get("fullPage") is True)
            listed = file_by_name.get(name) or {}
            add(f"{label} S9", "files entry sha", listed.get("sha256"), shot.get("sha256"))

        layout = row.get("layout") or {}
        add(f"{label} L1", "layout viewport", layout.get("viewport"), vp)
        add(f"{label} L2", "overflowX", layout.get("overflowX"), 0)
        controls = layout.get("controls") or {}
        if state in ("loading", "load-failed"):
            block = layout.get("block") or {}
            add_true(f"{label} L3", "state block visible", block.get("visible") is True)
            gap = block.get("gapFromTitle")
            add_true(f"{label} L4", "state block gap 0..24", isinstance(gap, (int, float)) and 0 <= gap <= 24)
            left = block.get("leftDeltaFromTitle")
            add_true(f"{label} L5", "state block left 0..2", isinstance(left, (int, float)) and 0 <= left <= 2)
            sparse = layout.get("sparse") or {}
            add(f"{label} L6", "D5 sparse count", sparse.get("count"), 0)
            add(f"{label} L7", "no input/save in no-form state",
                [controls.get("input"), controls.get("save")], [None, None])
        if state == "load-failed" and vp == "390x844":
            retry = controls.get("retry") or {}
            add_true(f"{label} L8", "retry visible", retry.get("visible") is True)
            add_true(f"{label} L9", "retry atLeast44", retry.get("atLeast44") is True)
        if state in ("empty", "retry-recovered", "saved"):
            add_true(f"{label} L10", "input control present", controls.get("input") is not None)
            add_true(f"{label} L11", "save control present", controls.get("save") is not None)

        get = row.get("get") or {}
        bodies = get.get("bodies") or []
        body = row.get("body")
        ui = row.get("ui") or {}
        binding_ui = (row.get("postReleaseUi") or {}) if state == "loading" else ui
        if body is not None:
            add(f"{label} G1", "ui.timezone", binding_ui.get("timezone"), body.get("timezone"))
            add(f"{label} G2", "ui.revision", binding_ui.get("revision"), str(body.get("timezoneRevision")))
            add(f"{label} G3", "ui.versionRevision", norm_text(binding_ui.get("versionRevision")),
                f"version {body.get('version')} · revision {body.get('timezoneRevision')}")
            add(f"{label} G4", "ui.recomputable", norm_text(binding_ui.get("recomputable")),
                recomputable_text(body.get("recomputableFrom")))
            if state != "saved":
                body_index = 1 if state == "retry-recovered" else 0
                add(f"{label} G5", "GET body == states.body",
                    (bodies[body_index] or {}).get("json") if len(bodies) > body_index else None, body)
            doc_route = get.get("documentRoute")
            add_true(f"{label} G6", "GET documentRoute normalized",
                     isinstance(doc_route, str) and doc_route.startswith("/admin/settings?") and "section=analytics" in doc_route and "http" not in doc_route)
            add(f"{label} G7", "GET urls normalized", get.get("urls"), ["/api/admin/settings/analytics"] * len(get.get("urls") or []))

        if state == "empty":
            add(f"{label} E1", "contract initial body", body,
                {"version": 0, "timezone": "UTC", "timezoneRevision": 1, "recomputableFrom": None})
            add(f"{label} E2", "no status/alert/rebuild",
                [ui.get("status"), ui.get("alert"), ui.get("rebuild")], [None, None, False])
            add(f"{label} E3", "input value", ui.get("inputValue"), "UTC")
            add(f"{label} E4", "GET count", get.get("count"), 1)
            add(f"{label} E5", "D5 sparse count", (layout.get("sparse") or {}).get("count"), 0)

        if state == "loading":
            route = row.get("route") or {}
            facts = row.get("loadingFacts") or {}
            add(f"{label} L20", "heldCount", route.get("heldCount"), 1)
            held = route.get("heldMs")
            add_true(f"{label} L21", "heldMs within client deadline",
                     isinstance(held, (int, float)) and 0 < held < CLIENT_DEADLINE_MS - 1000)
            add(f"{label} L22", "clientDeadlineMs", route.get("clientDeadlineMs"), CLIENT_DEADLINE_MS)
            add_true(f"{label} L23", "uiCapturedBeforeRelease", route.get("uiCapturedBeforeRelease") is True)
            add_true(f"{label} L24", "screenshotBeforeRelease", route.get("screenshotBeforeRelease") is True)
            add(f"{label} L25", "loading facts",
                [facts.get("sentenceVisible"), facts.get("inputPresent"), facts.get("savePresent"),
                 facts.get("alertPresent"), facts.get("patchRequests")],
                [True, False, False, False, 0])
            add(f"{label} L26", "pre-release ui empty",
                [ui.get("timezone"), ui.get("inputValue"), ui.get("status"), ui.get("alert")],
                [None, None, None, None])
            post = row.get("postReleaseUi") or {}
            add(f"{label} L27", "post-release ui bound",
                [post.get("timezone"), post.get("revision"), norm_text(post.get("versionRevision")),
                 norm_text(post.get("recomputable")), post.get("inputValue")],
                [body.get("timezone") if body else None, str(body.get("timezoneRevision")) if body else None,
                 f"version {body.get('version')} · revision {body.get('timezoneRevision')}" if body else None,
                 recomputable_text(body.get("recomputableFrom")) if body else None,
                 body.get("timezone") if body else None])
            add(f"{label} L28", "GET count", get.get("count"), 1)

        if state == "load-failed":
            failure = row.get("failure") or {}
            add_true(f"{label} F1", "errorText net::ERR_*", str(failure.get("errorText") or "").startswith("net::ERR_"))
            add_true(f"{label} F2", "alert visible", failure.get("alertVisible") is True)
            add_true(f"{label} F3", "alert text contract", str(failure.get("alertText") or "").startswith(LOAD_FAILED_SENTENCE))
            add_true(f"{label} F4", "retry visible", failure.get("retryVisible") is True)
            add(f"{label} F5", "responses before retry", failure.get("responsesBeforeRetry"), 0)
            add(f"{label} F6", "matched requests", failure.get("matchedRequests"), 1)
            add(f"{label} F7", "aborted requests", failure.get("abortedRequests"), 1)
            add(f"{label} F8", "no body/get", [body, row.get("get")], [None, None])
            add(f"{label} F9", "no input", ui.get("inputValue"), None)

        if state == "retry-recovered":
            recovery = row.get("recovery") or {}
            add(f"{label} T1", "GET count", get.get("count"), 2)
            add_true(f"{label} T2", "first GET failed fetch",
                     len(bodies) == 2 and bodies[0].get("ok") is False and bodies[0].get("reason") == "fetch")
            add_true(f"{label} T3", "second GET 200",
                     len(bodies) == 2 and bodies[1].get("ok") is True and bodies[1].get("status") == 200)
            add_true(f"{label} T4", "old alert gone", recovery.get("oldAlertGone") is True)
            add(f"{label} T5", "recovery apiResponses", recovery.get("apiResponses"), 1)
            add(f"{label} T6", "recovery getCount", recovery.get("getCount"), 2)
            add_true(f"{label} T7", "recovery feedback", str(recovery.get("feedback") or "").startswith("已读取最新配置"))
            add_true(f"{label} T8", "ui feedback", str(ui.get("status") or "").startswith("已读取最新配置"))

        if state == "saved":
            patch = row.get("patch") or {}
            initial = (bodies[0].get("json") if bodies else {}) or {}
            saved_patches.append(patch)
            add(f"{label} P1", "GET count", get.get("count"), 1)
            add(f"{label} P2", "PATCH status", patch.get("status"), 200)
            add(f"{label} P3", "PATCH countAtResponse", patch.get("countAtResponse"), 1)
            add(f"{label} P4", "PATCH capturedAtResponse", patch.get("capturedAtResponse"), 1)
            add(f"{label} P5", "PATCH countAtEnd", patch.get("countAtEnd"), 1)
            add(f"{label} P6", "PATCH capturedAtEnd", patch.get("capturedAtEnd"), 1)
            add(f"{label} P7", "PATCH screenshotsAfterPatch", patch.get("screenshotsAfterPatch"), 3)
            add(f"{label} P8", "PATCH request keys", sorted((patch.get("request") or {}).keys()),
                ["expectedVersion", "timezone"])
            add(f"{label} P9", "PATCH body keys", sorted((patch.get("body") or {}).keys()),
                ["rebuildScheduled", "recomputableFrom", "timezone", "timezoneRevision", "version"])
            add(f"{label} P10", "PATCH request timezone", (patch.get("request") or {}).get("timezone"),
                (patch.get("body") or {}).get("timezone"))
            add(f"{label} P11", "PATCH expectedVersion", (patch.get("request") or {}).get("expectedVersion"),
                initial.get("version"))
            add(f"{label} P12", "PATCH version +1", (patch.get("body") or {}).get("version"),
                (initial.get("version") + 1) if isinstance(initial.get("version"), int) else None)
            add(f"{label} P13", "PATCH revision +1", (patch.get("body") or {}).get("timezoneRevision"),
                (initial.get("timezoneRevision") + 1) if isinstance(initial.get("timezoneRevision"), int) else None)
            add_true(f"{label} P14", "PATCH rebuildScheduled", (patch.get("body") or {}).get("rebuildScheduled") is True)
            add_true(f"{label} P15", "PATCH recomputableFrom non-null", (patch.get("body") or {}).get("recomputableFrom") is not None)
            add(f"{label} P16", "ui.status", norm_text(ui.get("status")),
                f"✓ 已保存：version {(patch.get('body') or {}).get('version')} · revision {(patch.get('body') or {}).get('timezoneRevision')} · 已登记重算")
            add(f"{label} P17", "ui.rebuild", ui.get("rebuild"), True)
            add(f"{label} P18", "ui.inputValue", ui.get("inputValue"), (patch.get("body") or {}).get("timezone"))
            add(f"{label} P19", "page request == Playwright request", patch.get("pageRequest"), patch.get("request"))

    if len(saved_patches) == 3:
        ids = {row.get("id") for row in saved_patches}
        requests = {json.dumps(row.get("request"), sort_keys=True) for row in saved_patches}
        bodies_json = {json.dumps(row.get("body"), sort_keys=True) for row in saved_patches}
        statuses = {row.get("status") for row in saved_patches}
        add("SAVED-1", "three saved share one PATCH id", len(ids), 1)
        add("SAVED-2", "three saved share one request", len(requests), 1)
        add("SAVED-3", "three saved share one body", len(bodies_json), 1)
        add("SAVED-4", "three saved share one status", len(statuses), 1)
        add_true("SAVED-5", "PATCH id non-empty", all(isinstance(row.get("id"), str) and len(row.get("id")) > 0 for row in saved_patches))

    # 报告安全：不把完整 URL/绝对诊断写进可上传 RUN
    http_hits = []
    for row in states:
        get = row.get("get") or {}
        if isinstance(get.get("documentRoute"), str) and "http" in get["documentRoute"]:
            http_hits.append("documentRoute")
        for body in get.get("bodies") or []:
            if isinstance(body.get("url"), str) and body["url"].startswith("http"):
                http_hits.append("get.body.url")
    add("SAFE-1", "no full URLs in state routes", http_hits, [])

    return finish(checks, args, run_dir)


def finish(checks, args, run_dir):
    failed = [row for row in checks if row["result"] == "FAIL"]
    result = {
        "schema": "t10-state-run-check/2",
        "claim": "只读复核 capture RUN 的身份/收尾/截图独立性/同笔绑定/异常态布局；不替代 Playwright 断言，不是验收结论。",
        "source": {
            "run": run_dir,
            "repo": os.path.abspath(args.repo),
            "expectSha": args.expect_sha,
            "expectTree": args.expect_tree,
            "expectBuildId": args.expect_build_id,
        },
        "checks": checks,
        "summary": {
            "total": len(checks),
            "passed": len(checks) - len(failed),
            "failed": len(failed),
            "verdict": "PASS" if not failed else "FAIL",
        },
        "failures": failed,
    }
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
    for row in checks:
        print("\t".join([
            row["id"],
            row["target"],
            json.dumps(row["expected"], ensure_ascii=False),
            json.dumps(row["actual"], ensure_ascii=False),
            row["result"],
        ]))
    print("SUMMARY\t{}/{}".format(len(checks) - len(failed), len(checks)))
    print("VERDICT\t{}".format(result["summary"]["verdict"]))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
