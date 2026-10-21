"""Composite user-authorized product branding, retaining the full video and source audio."""
import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/brand-media/static'
PARTS = BASE / 'product-video'
SOURCE_SHA = '4fb4b5b362fc3fde5cf0245b3d736eed517d8d9b0ffee838a9d1e2545343960f'
MASTER_SHA = '7b585370f85ceabd7ff221dfa0c9dbcc36a9c9c7b3480c0aebc99e05e308e099'
RASTER_SHA = 'a574cb98ca4c31fdb3ca642e336ca70dfeec464563203a886d065cf6a2ce9f5f'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wsl_path(path):
    resolved = path.resolve()
    return '/mnt/' + resolved.drive[0].lower() + resolved.as_posix()[2:]


def render(source, output, record_path, review_dir):
    assert digest(source) == SOURCE_SHA, 'Input is not the registered original video'
    master = ROOT / 'public/brand/packjoyu-logo-master.svg'
    raster = BASE / 'evidence/exact-logo-reference.png'
    assert digest(master) == MASTER_SHA and digest(raster) == RASTER_SHA
    assert not output.exists(), 'Preserving existing output'
    assert output.parent.is_dir() and record_path.parent.is_dir()
    review_dir.mkdir(exist_ok=True)
    early = load_module('brand_early', PARTS / 'brand_earlyshot.py')
    late = load_module('brand_late', PARTS / 'brand_lateshot.py')
    tracks = json.loads((PARTS / 'late-tracks.json').read_text(encoding='utf-8'))
    cap = cv2.VideoCapture(str(source))
    assert cap.isOpened() and cap.get(cv2.CAP_PROP_FPS) == 60
    assert (cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) == (1920, 1080)
    command = ['wsl.exe', '--exec', 'ffmpeg', '-hide_banner', '-nostdin', '-n',
        '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s:v', '1920x1080', '-r', '60', '-i', 'pipe:0',
        '-i', wsl_path(source), '-map', '0:v:0', '-map', '1:a:0',
        '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-maxrate', '6M', '-bufsize', '12M',
        '-profile:v', 'high', '-level:v', '4.2', '-g', '120', '-bf', '2', '-threads', '6', '-vsync', '0',
        '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-c:a', 'copy', '-map_metadata', '-1', '-movflags', '+faststart',
        '-video_track_timescale', '60000', wsl_path(output)]
    log_path = record_path.with_suffix('.encode.log')
    records = []
    summary = {'inputFrames': 0, 'earlyFrames': 0, 'lateFrames': 0, 'unchangedFramesBeforeEncoding': 0,
               'earlyLabelInstances': 0, 'protectedForegroundChangedPixels': 0}
    chosen = {604, 605, 606, 663, 705, 708, 709, 733, 114, 150, 179, 180, 181, 210, 222, 600, 609, 612, 642, 654, 657, 660,
              666, 669, 672, 684, 714, 717, 726, 734}
    with log_path.open('w', encoding='utf-8') as log:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                   stderr=log, bufsize=4 * 1024 * 1024)
        try:
            index = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if 114 <= index <= 222:
                    edited, row, surface, foreground = early.process_frame_with_record(frame, index)
                    stats = row['pixelVerification']
                    assert stats['changedOutsideSurfaceAntialiasMargin'] == 0
                    assert stats['changedProtectedForegroundPixels'] == 0
                    summary['earlyLabelInstances'] += len(row['labels'])
                    summary['earlyFrames'] += 1
                    if index in [179, 180, 181]:
                        assert np.array_equal(edited[780, 310], frame[780, 310]), 'Diagonal rail occlusion regression'
                elif 600 <= index <= 734:
                    edited, info = late.compose(frame, index, tracks[str(index)])
                    foreground = late.machine_mask(frame, index) > 0
                    changed_protected = int(np.any(edited[foreground] != frame[foreground], axis=1).sum())
                    assert changed_protected == 0
                    summary['lateFrames'] += 1
                    row = {'index': index, 'atMs': index / 60 * 1000, 'paperInstances': tracks[str(index)],
                           'brandRegions': info, 'changedProtectedForegroundPixels': changed_protected}
                else:
                    edited = frame
                    assert np.array_equal(edited, frame)
                    summary['unchangedFramesBeforeEncoding'] += 1
                    row = None
                if row is not None:
                    row['compositedFrameRawBgrSha256'] = hashlib.sha256(edited.tobytes()).hexdigest()
                    records.append(row)
                if index in chosen:
                    assert cv2.imwrite(str(review_dir / f'composite-{index:04d}.png'), edited)
                process.stdin.write(edited.tobytes())
                index += 1
                if index % 120 == 0:
                    print('rendered', index, 'frames', flush=True)
            assert index == 735
            process.stdin.close()
            assert process.wait() == 0, 'FFmpeg failed; inspect encoder log'
        except BaseException:
            if process.poll() is None:
                process.kill()
                process.wait()
            raise
        finally:
            cap.release()
    summary['inputFrames'] = 735
    assert summary['earlyFrames'] == 109 and summary['lateFrames'] == 135
    assert summary['unchangedFramesBeforeEncoding'] == 491
    assert digest(source) == SOURCE_SHA and digest(master) == MASTER_SHA and digest(raster) == RASTER_SHA
    record = {'kind': 'product_brand_video_composition', 'task': 'M1-T3',
        'source': {'path': str(source), 'sha256': SOURCE_SHA},
        'master': {'path': master.relative_to(ROOT).as_posix(), 'sha256': MASTER_SHA},
        'rasterReference': {'path': raster.relative_to(ROOT).as_posix(), 'sha256': RASTER_SHA},
        'output': {'path': str(output), 'sha256': digest(output), 'bytes': output.stat().st_size},
        'actualTools': {'python': 'existing local Python', 'opencv': cv2.__version__,
                        'videoEncoder': 'existing WSL FFmpeg 4.2.7 / libx264; original AAC stream copied'},
        'command': command, 'summary': summary, 'frames': records,
        'accountVideoGenerationClaimed': False,
        'videoReencoded': True, 'audioReencoded': False,
        'equipmentMarks': 'Original device-maker scenes are unchanged before H264 encoding.',
        'releaseAllowed': False, 'integrityStatus': 'rendered; encoded media verification pending'}
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--record', type=Path, required=True)
    parser.add_argument('--review-dir', type=Path, required=True)
    args = parser.parse_args()
    render(args.source, args.output, args.record, args.review_dir)
