"""Exercise the release verifier against copies of the actual Dot delivery."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify_company_visuals.py")
REPOSITORY = SCRIPT.parents[3]
MANIFEST = Path("docs/brand-content/company-visuals.json")
PLAN = REPOSITORY.parent / ".codex-plans" / "NBshiyan-m1-t9"
SPEC = importlib.util.spec_from_file_location("company_visual_verifier", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class CompanyVisualVerificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        PLAN.mkdir(parents=True, exist_ok=True)
        cls.directory = tempfile.TemporaryDirectory(prefix="visual-negative-tests-", dir=PLAN)
        cls.root = Path(cls.directory.name).resolve()
        assert cls.root.is_relative_to(PLAN.resolve())
        manifest = json.loads((REPOSITORY / MANIFEST).read_text(encoding="utf-8"))
        if manifest.get("status") != "complete":
            cls.directory.cleanup()
            raise AssertionError("The actual completed Dot manifest must be integrated before testing")
        shutil.copytree(REPOSITORY / "docs/brand-content", cls.root / "docs/brand-content")
        files = [manifest["logoMaster"]["path"]]
        files.extend(item["path"] for item in manifest["originalMedia"])
        files.extend(item["web"]["path"] for item in manifest["artworks"])
        for relative in files:
            destination = cls.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPOSITORY / relative, destination)
        cls.manifest_bytes = (cls.root / MANIFEST).read_bytes()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.directory.cleanup()

    def setUp(self) -> None:
        self.manifest = json.loads(self.manifest_bytes)
        self.changed: dict[Path, bytes] = {}

    def tearDown(self) -> None:
        for path, data in self.changed.items():
            path.write_bytes(data)
        (self.root / MANIFEST).write_bytes(self.manifest_bytes)

    def remember(self, relative: str) -> Path:
        path = self.root / relative
        self.changed.setdefault(path, path.read_bytes())
        return path

    def write_manifest(self) -> None:
        (self.root / MANIFEST).write_text(json.dumps(self.manifest), encoding="utf-8")

    def verify_fails(self, message: str, *, originals: bool = False) -> None:
        with self.assertRaisesRegex(VERIFIER.VerificationError, message):
            VERIFIER.verify(self.root, verify_originals=originals)

    def test_actual_delivery_passes_without_claiming_desktop_verification(self) -> None:
        result = VERIFIER.verify(self.root)
        self.assertEqual(result["artworks"], 1)
        self.assertFalse(result["desktopOriginalsVerified"])

    def test_changed_web_bytes_fail(self) -> None:
        path = self.remember(self.manifest["artworks"][0]["web"]["path"])
        path.write_bytes(path.read_bytes() + b"changed")
        self.verify_fails("web hash")

    def test_incorrect_dimensions_fail(self) -> None:
        self.manifest["artworks"][0]["web"]["width"] += 1
        self.write_manifest()
        self.verify_fails("decoded size")

    def test_missing_russian_alt_fails(self) -> None:
        del self.manifest["artworks"][0]["alt"]["ru"]
        self.write_manifest()
        self.verify_fails("alt.ru")

    def test_missing_software_evidence_fails(self) -> None:
        receipt = json.loads((self.root / self.manifest["artworks"][0]["productionRecord"]).read_text(encoding="utf-8"))
        self.remember(receipt["evidence"][0]["path"]).unlink()
        self.verify_fails("evidence")

    def test_missing_owner_confirmation_fails(self) -> None:
        self.remember(self.manifest["ownerAttestation"]["path"]).unlink()
        self.verify_fails("owner attestation")

    def test_changed_owner_quote_fails_even_when_confirmation_remains_nonempty(self) -> None:
        path = self.remember(self.manifest["ownerAttestation"]["path"])
        owner = json.loads(path.read_text(encoding="utf-8"))
        owner["quote"] += " altered"
        path.write_text(json.dumps(owner, ensure_ascii=False), encoding="utf-8")
        self.verify_fails("owner attestation hash")

    def test_changed_logo_geometry_fails_even_with_reregistered_source_hash(self) -> None:
        artwork = self.manifest["artworks"][0]
        source = self.remember(artwork["source"]["path"])
        document = ET.fromstring(source.read_bytes())
        logo = next(element for element in document.iter() if element.get("id") == artwork["logoImportObject"])
        path = logo.find(".//{http://www.w3.org/2000/svg}path")
        assert path is not None
        path.set("d", path.get("d", "") + " M1 1")
        source.write_bytes(ET.tostring(document, encoding="utf-8", xml_declaration=True))
        artwork["source"]["sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
        self.write_manifest()
        self.verify_fails("official logo paths")

    def test_svg_line_ending_change_fails_raw_hash(self) -> None:
        source = self.remember(self.manifest["artworks"][0]["source"]["path"])
        before = source.read_bytes()
        after = before.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        self.assertNotEqual(before, after)
        source.write_bytes(after)
        self.verify_fails("source hash")

    def test_wrong_dot_session_fails(self) -> None:
        self.manifest["dot"]["sessionId"] = "another-session"
        self.write_manifest()
        self.verify_fails("session")

    def test_explicit_original_verification_does_not_skip_missing_files(self) -> None:
        self.manifest["referencePdf"]["path"] = str(self.root / "absent-original.pdf")
        self.write_manifest()
        self.verify_fails("reference PDF", originals=True)


if __name__ == "__main__":
    unittest.main()
