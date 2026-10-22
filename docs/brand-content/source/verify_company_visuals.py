"""Recompute company-visual hashes and decoded sizes.

The manifest status must stay unfinished while dot.invocationId is null.
This script does not open a page and does not treat the asset set as landed.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = ROOT / "docs" / "brand-content" / "company-visuals.json"
SESSION_PATH = ROOT / "docs" / "brand-content" / "source" / "inkscape-session.json"
MASTER_PATH = ROOT / "public" / "brand" / "packjoyu-logo-master.svg"
PDF_PATH = Path(r"C:\Users\admin\Desktop\catalog 2024-Mingkai&Kyson(1).pdf")
BANNED = ("YUHAO", "Mingkai", "Kyson", "certificate", "capacity", "factory", "ISO", "认证", "产能", "厂房")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def fail(message: str) -> None:
    print(f"FAIL {message}")
    sys.exit(1)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    session = json.loads(SESSION_PATH.read_text(encoding="utf-8"))
    require(manifest.get("status") == "unfinished", "status must stay unfinished")
    require(manifest["dot"]["invocationId"] is None, "dot invocation id must stay null")
    require(manifest["dot"]["reachable"] is False, "dot must stay unreachable")
    require(manifest.get("pageEvidence") is None, "page evidence belongs to M1-T5")
    require(manifest.get("integrationTask") == "M1-T5", "integration task")
    require(session["sessionId"] == manifest["software"]["sessionId"], "session id mismatch")
    require(session["software"]["version"] == "1.4.4 (dcaf3e7, 2026-05-05)", "inkscape version")

    logo_sha = sha256(MASTER_PATH)
    require(logo_sha == manifest["logoMaster"]["sha256"], "logo master hash")
    require(logo_sha == session["logoMaster"]["sha256"], "session logo hash")
    master_text = MASTER_PATH.read_text(encoding="utf-8")
    logo_paths = re.findall(r'<path fill="(#[0-9A-Fa-f]{6})" d="([^"]+)"/>', master_text)
    require(len(logo_paths) == 8, "logo master path count")

    artworks = manifest["artworks"]
    require(len(artworks) in (1, 2), "artwork count")
    session_by_id = {item["id"]: item for item in session["artworks"]}
    require(set(session_by_id) == {item["id"] for item in artworks}, "session artwork ids")

    for artwork in artworks:
        source = ROOT / artwork["source"]["path"]
        web = ROOT / artwork["web"]["path"]
        require(sha256(source) == artwork["source"]["sha256"], f"{artwork['id']} source hash")
        require(sha256(web) == artwork["web"]["sha256"], f"{artwork['id']} web hash")
        with Image.open(web) as image:
            width, height = image.size
        require(width == artwork["web"]["width"] and height == artwork["web"]["height"], f"{artwork['id']} size")
        require(width > 0 and height > 0, f"{artwork['id']} positive size")
        require(artwork["alt"]["en"].strip() and artwork["alt"]["ru"].strip(), f"{artwork['id']} alt")
        require(artwork["reference"] and artwork["factBasis"].strip(), f"{artwork['id']} reference")
        require(artwork["logoImportObject"] == "logo-master-import", f"{artwork['id']} import object")
        text = source.read_text(encoding="utf-8")
        require('id="logo-master-import"' in text, f"{artwork['id']} import group")
        require(f'id="{artwork["editedObject"]}"' in text, f"{artwork['id']} edited object")
        for _fill, d in logo_paths:
            require(d in text, f"{artwork['id']} logo path bytes")
        lowered = text.lower()
        for word in BANNED:
            require(word.lower() not in lowered, f"{artwork['id']} contains {word}")
        require("#0000ff" not in lowered, f"{artwork['id']} kept the temporary blue fill")
        record = session_by_id[artwork["id"]]
        require(record["source"]["sha256"] == artwork["source"]["sha256"], f"{artwork['id']} session source")
        require(record["web"]["sha256"] == artwork["web"]["sha256"], f"{artwork['id']} session web")
        require(record["undo"]["saved"] is False, f"{artwork['id']} undo must not save")
        require(record["reopen"]["sha256Unchanged"] is True, f"{artwork['id']} reopen")
        pixels = Image.open(web).convert("RGB")
        raw = pixels.tobytes()
        joy = accent = black = 0
        for offset in range(0, len(raw), 3):
            red = raw[offset]
            green = raw[offset + 1]
            blue = raw[offset + 2]
            if red < 30 and green < 30 and blue < 30:
                black += 1
            if 160 <= red <= 220 and green < 110 and blue < 70:
                if abs(red - 194) < 25 and abs(green - 56) < 25:
                    joy += 1
                if abs(red - 180) < 25 and abs(green - 87) < 25 and blue < 30:
                    accent += 1
        require(black > 1000, f"{artwork['id']} black outlines")
        require(joy > 100, f"{artwork['id']} wordmark joy color")
        require(accent > 20, f"{artwork['id']} accent rule")

    for item in manifest["originalMedia"]:
        require(sha256(ROOT / item["path"]) == item["sha256"], f"original media {item['path']}")
    if PDF_PATH.is_file():
        require(sha256(PDF_PATH) == manifest["referencePdf"]["sha256"], "reference pdf hash")
        require(PDF_PATH.stat().st_size == manifest["referencePdf"]["bytes"], "reference pdf size")

    print(f"PASS unfinished artworks={len(artworks)} session={manifest['software']['sessionId']}")


if __name__ == "__main__":
    main()
