"""Negative cases for evidence mismatches and release holds; originals stay read-only."""

import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('static_media', Path(__file__).with_name('verify-static-media.py'))
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class StaticMediaChecks(unittest.TestCase):
    def setUp(self):
        self.manifest = copy.deepcopy(CHECK.read('brand-static-media.json'))
        self.identity = copy.deepcopy(CHECK.read('video-identity.json'))
        self.production = copy.deepcopy(CHECK.read('production-record.json'))

    def test_master_hash_and_path_cannot_disagree_with_audit(self):
        original_read = CHECK.read
        for key, value in [('sha256', '0' * 64), ('path', 'public/brand/missing-master.svg')]:
            with self.subTest(key=key):
                manifest = copy.deepcopy(self.manifest)
                manifest['logoMaster'][key] = value
                with patch.object(CHECK, 'read', side_effect=lambda name:
                                  manifest if name == 'brand-static-media.json' else original_read(name)):
                    with self.assertRaisesRegex(ValueError, f'Master {key} differs'):
                        CHECK.verify()

    def test_missing_release_file_is_rejected_even_when_listed(self):
        original_read = CHECK.read
        self.manifest['releaseFiles'] = ['public/brand/missing-release.mp4']
        with patch.object(CHECK, 'read', side_effect=lambda name:
                          self.manifest if name == 'brand-static-media.json' else original_read(name)):
            with self.assertRaisesRegex(ValueError, 'Missing evidence'):
                CHECK.verify()

    def test_missing_production_stays_blocked(self):
        blockers = CHECK.release_blockers(self.manifest, self.identity, self.production)
        self.assertIn('PRODUCTION_NOT_COMPLETE', blockers)
        self.assertIn('JPG_REPLACEMENT_NOT_VERIFIED', blockers)
        self.assertIn('VIDEO_CORPORATE_IDENTITY_NOT_VERIFIED', blockers)

    def test_identity_records_match_original_and_registered_frame(self):
        original_read = CHECK.read
        cases = [
            ('source-hash', lambda value: value.update(originalSha256='0' * 64), 'Identity source hash differs'),
            ('frame-time', lambda value: value['observations'][2]['evidence'][0].update(atMs=8000),
             'Identity frame atMs differs'),
            ('poster-hash', lambda value: value['posterCandidate'].update(sha256='0' * 64), 'Hash mismatch'),
        ]
        for name, mutate, error in cases:
            with self.subTest(case=name):
                identity = copy.deepcopy(self.identity)
                mutate(identity)
                with patch.object(CHECK, 'read', side_effect=lambda filename:
                                  identity if filename == 'video-identity.json' else original_read(filename)):
                    with self.assertRaisesRegex(ValueError, error):
                        CHECK.verify()

    def test_equipment_marks_do_not_become_corporate_identity(self):
        self.identity['corporateAuthorship']['identity'] = 'OWN_VERIFIED'
        self.identity['observations'] = [
            {'role': 'equipment', 'identity': 'THIRD_PARTY'},
            {'role': 'equipment', 'identity': 'UNKNOWN'},
        ]
        blockers = CHECK.release_blockers(self.manifest, self.identity, self.production)
        self.assertNotIn('VIDEO_CORPORATE_IDENTITY_NOT_VERIFIED', blockers)
        self.assertNotIn('NON_EQUIPMENT_IDENTITY_NOT_VERIFIED', blockers)
        self.identity['observations'].append({'role': 'product_brand', 'identity': 'UNKNOWN'})
        self.assertIn('NON_EQUIPMENT_IDENTITY_NOT_VERIFIED',
                      CHECK.release_blockers(self.manifest, self.identity, self.production))

    def test_held_media_cannot_be_public_or_released(self):
        original_read = CHECK.read
        cases = [
            ('public-path', lambda value: value.update(heldFiles=['public/brand/not-approved.mp4']),
             'Held media must stay outside public assets'),
            ('release-held', lambda value: value.update(releaseFiles=[value['heldFiles'][1]]),
             'Held media entered release set'),
        ]
        for name, mutate, error in cases:
            with self.subTest(case=name):
                manifest = copy.deepcopy(self.manifest)
                mutate(manifest)
                with patch.object(CHECK, 'read', side_effect=lambda filename:
                                  manifest if filename == 'brand-static-media.json' else original_read(filename)):
                    with self.assertRaisesRegex(ValueError, error):
                        CHECK.verify()

    def test_held_poster_cannot_change_frame_time(self):
        original_read = CHECK.read
        self.identity['heldDerivatives'][1]['atMs'] = 4000
        with patch.object(CHECK, 'read', side_effect=lambda filename:
                          self.identity if filename == 'video-identity.json' else original_read(filename)):
            with self.assertRaisesRegex(ValueError, 'Poster time differs'):
                CHECK.verify()

    def test_held_file_flag_cannot_override_hold(self):
        original_read = CHECK.read
        held_path = self.manifest['heldFiles'][0]
        next(row for row in self.manifest['files'] if row['path'] == held_path)['releaseAllowed'] = True
        with patch.object(CHECK, 'read', side_effect=lambda filename:
                          self.manifest if filename == 'brand-static-media.json' else original_read(filename)):
            with self.assertRaisesRegex(ValueError, 'Held file was marked releasable'):
                CHECK.verify()

    def test_held_derivative_dimensions_match_decoded_file(self):
        original_read = CHECK.read
        self.identity['heldDerivatives'][0]['width'] = 1
        with patch.object(CHECK, 'read', side_effect=lambda filename:
                          self.identity if filename == 'video-identity.json' else original_read(filename)):
            with self.assertRaisesRegex(ValueError, 'Registered media width differs'):
                CHECK.verify()

    def test_generation_selection_and_metadata_are_consistent(self):
        original_loads = CHECK.json.loads
        cases = [
            ('selected-hash', lambda record: record['selectedOutput'].update(sha256='0' * 64), 'Hash mismatch'),
            ('output-width', lambda record: record['calls'][1]['output'].update(width=1), 'Registered media width differs'),
            ('jpeg-source', lambda record: record['jpegExport'].update(sourcePngPath=record['calls'][0]['output']['path']),
             'JPEG source differs'),
        ]
        for name, mutate, error in cases:
            with self.subTest(case=name):
                def altered_record(text, *args, **kwargs):
                    record = original_loads(text, *args, **kwargs)
                    if isinstance(record, dict) and 'selectedOutput' in record:
                        mutate(record)
                    return record
                with patch.object(CHECK.json, 'loads', side_effect=altered_record):
                    with self.assertRaisesRegex(ValueError, error):
                        CHECK.verify()


if __name__ == '__main__':
    unittest.main()
