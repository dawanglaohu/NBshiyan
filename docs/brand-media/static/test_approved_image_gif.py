"""The GIF report must describe the actual encoded animation, not just a poster."""

import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('gif_media_check', Path(__file__).with_name('verify-static-media.py'))
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class ApprovedGifChecks(unittest.TestCase):
    def test_encoded_frame_count_duration_and_loop_cannot_be_spoofed(self):
        read = CHECK.read
        for key, value, message in [('frameCount', 360, 'GIF frame count differs'),
                                    ('durationMs', 30070, 'GIF duration differs'),
                                    ('loop', 1, 'GIF loop differs')]:
            with self.subTest(field=key):
                manifest = copy.deepcopy(read('brand-static-media.json'))
                row = next(row for row in manifest['files'] if row['path'].endswith('-loop.gif'))
                row[key] = value
                with patch.object(CHECK, 'read', side_effect=lambda name:
                                  manifest if name == 'brand-static-media.json' else read(name)):
                    with self.assertRaisesRegex(ValueError, message):
                        CHECK.verify()

    def test_equal_total_duration_does_not_hide_retimed_frames(self):
        loads = CHECK.json.loads

        def retimed(text, *args, **kwargs):
            record = loads(text, *args, **kwargs)
            if isinstance(record, dict) and record.get('kind') == 'new_animation_from_user_approved_image':
                record['originalGif']['durationsMs'][0] += 10
                record['originalGif']['durationsMs'][1] -= 10
            return record

        with patch.object(CHECK.json, 'loads', side_effect=retimed):
            with self.assertRaisesRegex(ValueError, 'GIF original frame timing differs'):
                CHECK.verify()


if __name__ == '__main__':
    unittest.main()
