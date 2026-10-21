"""Selected output acceptance and tamper cases, backed by the real registered files."""
import copy
import importlib.util
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('selected_media_gate', Path(__file__).with_name('verify-static-media.py'))
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class SelectedReleaseChecks(unittest.TestCase):
    def setUp(self):
        self.manifest = copy.deepcopy(CHECK.read('brand-static-media.json'))
        self.identity = copy.deepcopy(CHECK.read('video-identity.json'))
        self.production = copy.deepcopy(CHECK.read('production-record.json'))

    def check_selection(self):
        return CHECK.release_blockers(self.manifest, self.identity, self.production)

    def test_qualified_selected_output_allows_preserved_third_party_source_history(self):
        self.assertEqual(self.identity['corporateAuthorship']['identity'], 'UNKNOWN')
        self.assertTrue(any(row['identity'] == 'THIRD_PARTY' and row['role'] == 'product_brand'
                            for row in self.identity['observations']))
        self.assertTrue(any(row['historical'] and row['afterPath'] is None
                            for row in self.manifest['jpgReplacements']))
        self.assertEqual(self.check_selection(), [])

    def test_actual_complete_selected_set_is_releasable(self):
        result = CHECK.verify()
        self.assertEqual(result['integrity'], 'pass')
        self.assertTrue(result['releaseAllowed'])
        self.assertEqual(result['releaseBlockers'], [])

    def test_tampered_selected_video_hash_is_rejected(self):
        review = self.identity['selectedFinalReview']
        review['outputs'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'review sha256 differs'):
            self.check_selection()

    def test_missing_source_attestation_is_rejected(self):
        self.identity['selectedFinalReview']['attestation']['path'] = 'docs/brand-media/static/missing-source.json'
        with self.assertRaisesRegex(ValueError, 'attestation path differs|Missing evidence'):
            self.check_selection()

    def test_empty_source_statement_is_rejected(self):
        read = CHECK.selected_checks.read_json

        def missing_statement(path):
            value = read(path)
            if path.name == 'source-attestation.json':
                value.pop('statement', None)
            return value

        with patch.object(CHECK.selected_checks, 'read_json', side_effect=missing_statement):
            with self.assertRaisesRegex(ValueError, 'Source attestation statement is missing'):
                self.check_selection()

    def test_wrong_actual_frame_hash_is_rejected(self):
        self.identity['selectedFinalReview']['outputs'][0]['evidence'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Hash mismatch'):
            self.check_selection()

    def test_unknown_source_identity_is_rejected(self):
        self.identity['selectedFinalReview']['sourceIdentity'] = 'UNKNOWN'
        with self.assertRaisesRegex(ValueError, 'source identity is not verified'):
            self.check_selection()

    def test_missing_or_changed_actual_selected_file_is_rejected(self):
        row = self.manifest['selectedDeliverables'][0]
        planning = CHECK.ROOT.parent / '.codex-plans/NBshiyan-m1-t3'
        with tempfile.TemporaryDirectory(dir=planning, prefix='selected-file-negative-') as directory:
            root = Path(directory).resolve()
            self.assertTrue(root.is_relative_to(planning.resolve()))
            records = CHECK.selected_checks.Records(root, {'files': [row]})
            with self.assertRaisesRegex(ValueError, 'Missing evidence'):
                records.file(row, registered=True)
            path = root / row['path']
            path.parent.mkdir(parents=True)
            path.write_bytes(b'changed bytes are not an approved PNG')
            with self.assertRaisesRegex(ValueError, 'Hash mismatch'):
                records.file(row, registered=True)

    def test_missing_actual_frame_file_is_rejected(self):
        self.identity['selectedFinalReview']['outputs'][0]['evidence'][0]['path'] = 'docs/brand-media/static/evidence/missing-final-frame.png'
        with self.assertRaisesRegex(ValueError, 'Missing evidence'):
            self.check_selection()

    def test_missing_observation_frame_basis_is_rejected(self):
        self.identity['selectedFinalReview']['outputs'][0]['observations'][0]['evidencePaths'] = []
        with self.assertRaisesRegex(ValueError, 'observation lacks frame evidence'):
            self.check_selection()

    def test_wrong_frame_timestamp_is_rejected(self):
        self.identity['selectedFinalReview']['outputs'][0]['evidence'][0]['atMs'] += 1
        with self.assertRaisesRegex(ValueError, 'Selected frame timestamp differs'):
            self.check_selection()

    def test_frame_from_another_moment_is_rejected(self):
        self.identity['selectedFinalReview']['outputs'][0]['evidence'][0]['frameIndex'] += 1
        frame = self.identity['selectedFinalReview']['outputs'][0]['evidence'][0]
        frame['atMs'] = frame['frameIndex'] / 60 * 1000
        with self.assertRaisesRegex(ValueError, 'does not reproduce'):
            self.check_selection()

    def test_release_flags_cannot_replace_final_output_review(self):
        self.manifest.update(taskStatus='complete', releaseAllowed=True)
        self.production.update(taskStatus='complete', releaseAllowed=True)
        self.identity['releaseAllowed'] = True
        self.identity.pop('selectedFinalReview')
        with self.assertRaisesRegex(ValueError, 'Selected final video review is missing'):
            self.check_selection()

    def test_unknown_final_corporate_identity_is_rejected(self):
        self.identity['selectedFinalReview']['finalCorporateIdentity'] = 'UNKNOWN'
        with self.assertRaisesRegex(ValueError, 'Final corporate identity is not verified'):
            self.check_selection()

    def test_unselected_old_video_cannot_enter_release_set(self):
        old = next(path for path in self.manifest['heldFiles'] if path.endswith('video2-packjoyu-products-v2.mp4'))
        self.manifest['releaseFiles'].append(old)
        with self.assertRaisesRegex(ValueError, 'Release set differs'):
            self.check_selection()

    def test_missing_selected_deliverable_is_rejected(self):
        self.manifest['selectedDeliverables'].pop()
        with self.assertRaisesRegex(ValueError, 'deliverables disagree|roles are incomplete'):
            self.check_selection()

    def test_wrong_selected_file_hash_is_rejected(self):
        self.manifest['selectedDeliverables'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'deliverables disagree|Hash mismatch'):
            self.check_selection()

    def test_unverified_required_production_is_rejected(self):
        key = self.production['requiredOperationIds'][0]
        next(row for row in self.production['operations'] if row['id'] == key)['status'] = 'not_executed'
        with self.assertRaisesRegex(ValueError, 'Selected production is not verified'):
            self.check_selection()

    def test_historical_incomplete_operations_are_not_current_requirements(self):
        for row in self.production['operations']:
            if row.get('historical'):
                row['status'] = 'not_executed'
        self.assertEqual(self.check_selection(), [])

    def test_missing_required_source_basis_is_rejected(self):
        review = self.identity['selectedFinalReview']
        review['basis'] = [row for row in review['basis']
                           if row['path'] != 'docs/brand-media/static/source-attestation.json']
        with self.assertRaisesRegex(ValueError, 'basis is missing|lacks basis files'):
            self.check_selection()

    def test_missing_observation_basis_is_rejected(self):
        self.identity['selectedFinalReview']['outputs'][0]['observations'][0]['basis'] = []
        with self.assertRaisesRegex(ValueError, 'lacks basis files'):
            self.check_selection()

    def test_wrong_basis_file_hash_is_rejected(self):
        self.identity['selectedFinalReview']['outputs'][0]['observations'][0]['basis'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Hash mismatch'):
            self.check_selection()

    def test_poster_from_unselected_video_is_rejected(self):
        self.identity['selectedFinalReview']['poster']['sourceVideoPath'] = 'docs/brand-media/static/held/video2-packjoyu-products-v2.mp4'
        with self.assertRaisesRegex(ValueError, 'Poster movie binding differs'):
            self.check_selection()

    def test_selected_source_cannot_lose_its_preserved_held_record(self):
        source = self.manifest['selectedDeliverables'][0]['source']['path']
        self.manifest['heldFiles'].remove(source)
        with self.assertRaisesRegex(ValueError, 'original derivative is not preserved'):
            self.check_selection()

    def test_required_operation_must_cover_selected_outputs(self):
        for operation in self.production['operations']:
            if operation['id'] in self.production['requiredOperationIds']:
                operation['outputs'] = []
        with self.assertRaisesRegex(ValueError, 'lacks an actual production operation'):
            self.check_selection()

    def test_watermark_review_must_cover_the_complete_movie(self):
        watermark = next(row for row in self.identity['selectedFinalReview']['outputs'][0]['observations']
                         if row['role'] == 'watermark')
        watermark['toMs'] -= 1
        # Keep a valid existing evidence time inside the shortened interval.
        watermark['evidencePaths'] = [self.identity['selectedFinalReview']['outputs'][0]['evidence'][0]['path']]
        with self.assertRaisesRegex(ValueError, 'watermark coverage incomplete|evidence time differs'):
            self.check_selection()

    def test_stale_saved_media_index_is_rejected(self):
        read = CHECK.selected_checks.read_json

        def old_index(path):
            value = read(path)
            if path.name == 'saved-media-index.json':
                value['selectedAssets'][0]['sha256'] = '0' * 64
            return value

        with patch.object(CHECK.selected_checks, 'read_json', side_effect=old_index):
            with self.assertRaisesRegex(ValueError, 'Saved media index selection differs'):
                self.check_selection()

    def test_static_crop_must_match_the_selected_png(self):
        selected = copy.deepcopy(CHECK.selected_checks.read_json(CHECK.local_path(self.manifest['selectionRecordPath'])))
        selected['staticReview']['brandLocations'][0]['bounds'][0] += 1
        read = CHECK.selected_checks.read_json
        with patch.object(CHECK.selected_checks, 'read_json', side_effect=lambda path:
                          selected if path == CHECK.local_path(self.manifest['selectionRecordPath']) else read(path)):
            with self.assertRaisesRegex(ValueError, 'does not reproduce selected artwork'):
                self.check_selection()


if __name__ == '__main__':
    unittest.main()
