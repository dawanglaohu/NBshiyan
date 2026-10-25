"""Verify delivered asset bytes and record links; software evidence also needs human review.

Desktop originals are read only with --verify-originals. A successful file check
does not establish website integration or task landing.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[3]
MANIFEST = "docs/brand-content/company-visuals.json"
SVG = "{http://www.w3.org/2000/svg}"


class VerificationError(ValueError):
    """A required asset or record does not agree with its registered evidence."""


def require(condition: object, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_file(root: Path, value: object, label: str) -> Path:
    require(nonempty(value), f"{label} path missing")
    relative = Path(str(value))
    require(not relative.is_absolute(), f"{label} must use a repository-relative path")
    path = (root / relative).resolve()
    require(path.is_relative_to(root), f"{label} escapes repository")
    require(path.is_file(), f"{label} file missing: {value}")
    return path


def read_json(path: Path, label: str) -> dict:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def checked_file(root: Path, entry: dict, label: str) -> Path:
    path = repository_file(root, entry.get("path"), label)
    require(sha256(path) == entry.get("sha256"), f"{label} hash mismatch")
    return path


def decoded_size(path: Path, label: str) -> tuple[int, int]:
    try:
        with Image.open(path) as image:
            image.load()
            size = image.size
    except (OSError, ValueError) as error:
        raise VerificationError(f"{label} decode failed: {error}") from error
    require(all(dimension > 0 for dimension in size), f"{label} invalid size")
    return size


def verify_checksums(root: Path, receipt: dict, source: Path, web_sha: str) -> None:
    checksum_path = repository_file(root, receipt.get("deliveryChecksums"), "delivery checksums")
    delivered: dict[Path, str] = {}
    for line in checksum_path.read_text(encoding="utf-8-sig").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        require(match is not None, "delivery checksum entry malformed")
        assert match is not None
        expected, name = match.groups()
        path = (checksum_path.parent / name).resolve()
        require(path.is_relative_to(checksum_path.parent), "delivery checksum path escapes package")
        require(path not in delivered, "duplicate delivery checksum entry")
        require(path.is_file(), f"delivery file missing: {name}")
        require(sha256(path) == expected, f"delivery file hash mismatch: {name}")
        delivered[path] = expected
    require(source in delivered, "source missing from delivery checksums")
    require(web_sha in delivered.values(), "web export missing from delivery checksums")


def verify_desktop_originals(manifest: dict) -> None:
    reference = manifest["referencePdf"]
    require(nonempty(reference.get("path")), "reference PDF path missing")
    pdf = Path(reference["path"])
    require(pdf.is_file(), "reference PDF file missing")
    require(sha256(pdf) == reference.get("sha256"), "reference PDF hash mismatch")
    require(pdf.stat().st_size == reference.get("bytes"), "reference PDF byte size mismatch")
    originals = manifest.get("originalDesktopFiles")
    require(isinstance(originals, list) and originals, "desktop original file list missing")
    for item in originals:
        require(nonempty(item.get("path")), "desktop original path missing")
        path = Path(item["path"])
        require(path.is_file(), f"desktop original missing: {path}")
        require(sha256(path) == item.get("sha256"), f"desktop original hash mismatch: {path}")


def verify_page_evidence(root: Path, manifest: dict) -> None:
    evidence = manifest.get("pageEvidence")
    require(isinstance(evidence, dict), "page evidence missing")
    require(evidence.get("task") == "M1-T5", "page evidence task mismatch")
    require(evidence.get("trace") == "docs/brand-content/company-page-trace.json", "page evidence trace mismatch")
    trace = read_json(repository_file(root, evidence["trace"], "page trace"), "page trace")
    artwork = manifest["artworks"][0]
    web_file = str(artwork["web"]["path"]).replace("\\", "/")
    require(web_file.startswith("public/"), "artwork web file is outside public")
    require(trace.get("webPath") == web_file[len("public"):], "page trace web path mismatch")
    require(trace.get("mappingModule") == "src/lib/brand/company-media.ts", "page trace mapping mismatch")
    require(str(trace.get("webPath", "")).startswith("/brand/company/"), "page trace web path is not the company release")
    require(not str(trace.get("webPath")).endswith((".svg", ".pdf")), "page trace web path is a source file")
    fact_map = trace.get("factMap")
    require(fact_map == "docs/brand-content/company-fact-map.json", "page trace fact map mismatch")
    repository_file(root, fact_map, "fact map")


def verify(root: Path, *, verify_originals: bool = False) -> dict:
    root = root.resolve()
    manifest = read_json(repository_file(root, MANIFEST, "manifest"), "manifest")
    require(manifest.get("assetSet") == "company-visual-assets", "asset set mismatch")
    require(manifest.get("status") == "complete", "asset set is not complete")
    verify_page_evidence(root, manifest)
    require(manifest.get("integrationTask") == "M1-T5", "integration task mismatch")

    dot, software = manifest["dot"], manifest["software"]
    session_id = dot.get("sessionId") or dot.get("invocationId")
    require(dot.get("reachable") is True and nonempty(session_id), "actual Dot session missing")
    require(software.get("sessionId") == session_id, "software session mismatch")
    require(nonempty(software.get("name")) and nonempty(software.get("version")), "software identity missing")
    operation_path = dot.get("operationRecord")
    require(software.get("sessionRecord") == operation_path, "software operation record mismatch")
    operation_file = repository_file(root, operation_path, "software operation record")
    workflow = read_json(operation_file, "software operation record")
    require(workflow.get("parent_conversation_session_id") == session_id, "workflow session mismatch")
    require(workflow.get("actual_software") == f"{software['name']} {software['version']}", "software version mismatch")
    steps = workflow.get("performed_steps")
    require(isinstance(steps, list) and steps and all(nonempty(step) for step in steps), "software steps missing")
    step_text = " ".join(steps).lower()
    require(all(action in step_text for action in ("open", "edit", "und", "export", "reopen")), "software operation steps incomplete")

    owner_path = manifest["ownerAttestation"].get("path")
    owner = read_json(checked_file(root, manifest["ownerAttestation"], "owner attestation"), "owner attestation")
    require(owner.get("basisKind") == "direct_user_statement", "owner attestation basis missing")
    require(nonempty(owner.get("quote")), "owner attestation quote missing")
    require(isinstance(owner.get("confirmedClaims"), list) and owner["confirmedClaims"], "owner confirmed claims missing")

    master = ET.parse(checked_file(root, manifest["logoMaster"], "logo master")).getroot()
    logo_paths = [(path.get("d"), path.get("fill")) for path in master.iter(SVG + "path")]
    require(len(logo_paths) == 8, "official logo master path count mismatch")
    artworks = manifest.get("artworks")
    require(isinstance(artworks, list) and len(artworks) in (1, 2), "artwork count must be one or two")
    for artwork in artworks:
        asset_id = artwork["id"]
        source = checked_file(root, artwork["source"], f"{asset_id} source")
        web = checked_file(root, artwork["web"], f"{asset_id} web")
        width, height = decoded_size(web, f"{asset_id} web")
        registered_size = (artwork["web"].get("width"), artwork["web"].get("height"))
        require(all(type(value) is int and value > 0 for value in registered_size), f"{asset_id} dimensions invalid")
        require((width, height) == registered_size, f"{asset_id} decoded size mismatch")
        for language in ("en", "ru"):
            require(nonempty(artwork.get("alt", {}).get(language)), f"{asset_id} alt.{language} missing")
        require(artwork.get("reference") and nonempty(artwork.get("factBasis")), f"{asset_id} reference/fact basis missing")

        document = ET.parse(source).getroot()
        objects = {element.get("id"): element for element in document.iter() if element.get("id")}
        logo = objects.get(artwork.get("logoImportObject"))
        require(logo is not None, f"{asset_id} logo import object missing")
        assert logo is not None
        imported_paths = [(path.get("d"), path.get("fill")) for path in logo.iter(SVG + "path")]
        require(imported_paths == logo_paths, f"{asset_id} official logo paths differ")
        edited = objects.get(artwork.get("editedObject"))
        editable_tags = {SVG + name for name in ("text", "path", "rect", "circle", "ellipse", "line", "polygon", "polyline")}
        require(edited is not None and edited.tag in editable_tags, f"{asset_id} editable object missing")

        receipt = read_json(repository_file(root, artwork.get("productionRecord"), "production receipt"), "production receipt")
        require(receipt.get("source") == artwork["source"] and receipt.get("web") == artwork["web"], f"{asset_id} receipt asset mismatch")
        require(receipt.get("dotSessionId") == session_id, "receipt session mismatch")
        require(receipt.get("operationRecord") == operation_path, "receipt operation record mismatch")
        require(receipt.get("operationRecordSha256") == sha256(operation_file), "receipt operation record hash mismatch")
        require(receipt.get("ownerAttestation") == owner_path, "receipt owner attestation mismatch")
        reopen = receipt.get("reopen", {})
        require(reopen.get("temporaryEditUndone") is True and reopen.get("sourceSha256Unchanged") is True, "source reopen/edit/undo record missing")
        evidence = receipt.get("evidence")
        require(isinstance(evidence, list) and evidence, "software evidence missing")
        evidence_paths = []
        for entry in evidence:
            screenshot = checked_file(root, entry, "software evidence")
            decoded_size(screenshot, "software evidence")
            evidence_paths.append(screenshot)
        listed = workflow.get("evidence")
        require(isinstance(listed, list) and listed, "workflow evidence missing")
        expected_paths = [(operation_file.parent.parent / "evidence" / item["file"]).resolve() for item in listed]
        require(len(set(evidence_paths)) == len(evidence_paths), "duplicate software evidence")
        require(set(evidence_paths) == set(expected_paths), "workflow/receipt evidence mismatch")
        verify_checksums(root, receipt, source, artwork["web"]["sha256"])

    originals = manifest.get("originalMedia")
    require(isinstance(originals, list) and originals, "protected original media list missing")
    for item in originals:
        checked_file(root, item, "protected original media")
    if verify_originals:
        verify_desktop_originals(manifest)
    return {"artworks": len(artworks), "sessionId": session_id, "desktopOriginalsVerified": verify_originals}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="Repository root containing the asset manifest")
    parser.add_argument("--verify-originals", action="store_true", help="Also require and hash the listed desktop originals")
    arguments = parser.parse_args()
    try:
        result = verify(arguments.root, verify_originals=arguments.verify_originals)
    except (OSError, KeyError, TypeError, ET.ParseError, ValueError) as error:
        print(f"FAIL {error}")
        return 1
    originals = "verified" if result["desktopOriginalsVerified"] else "not-requested"
    print(f"PASS asset-files-and-records artworks={result['artworks']} session={result['sessionId']} desktop-originals={originals}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
