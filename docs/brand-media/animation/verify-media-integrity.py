"""Read-only M1-T6 integrity/decode check. Requires Python and Pillow.

Run from any directory; JSON goes to stdout. This checks encoded files and
timing, not a new all-frame human visual review. Desktop originals are optional.
"""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageSequence

ROOT = Path(__file__).resolve().parents[3]
STATIC = ROOT / 'docs/brand-media/static'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(original_gif=None):
    selected = json.loads((STATIC / 'selected-media-release.json').read_text(encoding='utf-8-sig'))
    animation = json.loads((STATIC / 'industrial-city-animation-record.json').read_text(encoding='utf-8-sig'))
    result = {'scope': 'read-only selected media integrity and full GIF decode; not new human visual review',
              'deliverables': [], 'gifs': []}
    for item in selected['deliverables']:
        path = ROOT / item['path']
        digest = sha(path)
        require(digest == item['sha256'], 'Selected SHA differs: ' + item['path'])
        require(sha(ROOT / item['source']['path']) == digest, 'Held SHA differs: ' + item['path'])
        result['deliverables'].append({'path': item['path'], 'sha256': digest, 'publicMatchesSelectedAndHeld': True})
        if item['role'] not in ('animated_gif', 'gif_preview'):
            continue
        durations, sequence = [], hashlib.sha256()
        with Image.open(path) as image:
            size, loop = image.size, image.info.get('loop')
            for frame in ImageSequence.Iterator(image):
                sequence.update(frame.convert('RGB').tobytes())
                durations.append(frame.info.get('duration', 0))
        require(size == (item['width'], item['height']), 'GIF size differs: ' + item['path'])
        require(len(durations) == item['frameCount'], 'GIF frame count differs: ' + item['path'])
        require(sum(durations) == item['durationMs'] and loop == item['loop'], 'GIF timing/loop differs: ' + item['path'])
        require(durations == animation['output']['durationsMs'], 'GIF frame timeline differs: ' + item['path'])
        result['gifs'].append({'path': item['path'], 'dimensions': size, 'decodedFrames': len(durations),
                               'durationMs': sum(durations), 'loop': loop, 'allFrameDurationsMatchAnimationRecord': True,
                               'allDecodedRgbSequenceSha256': sequence.hexdigest()})
    pause = animation['pauseFrame']
    require(sha(ROOT / pause['path']) == pause['sha256'], 'Pause frame SHA differs')
    with Image.open(ROOT / pause['path']) as image:
        require(image.size == (pause['width'], pause['height']), 'Pause frame size differs')
    result['pauseFrame'] = {**pause, 'actualHashAndDimensionsMatch': True}
    result['originalGif'] = {'checked': original_gif is not None, 'recordedSha256': animation['originalGif']['sha256']}
    if original_gif is not None:
        digest = sha(original_gif)
        require(digest == animation['originalGif']['sha256'], 'Original GIF SHA differs')
        result['originalGif'].update(path=str(original_gif), present=True, actualSha256=digest)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-gif', type=Path, help='Optional local original; never changed')
    print(json.dumps(verify(parser.parse_args().original_gif), ensure_ascii=False, indent=2))
