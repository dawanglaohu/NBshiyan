"""Animate the approved illustration with deterministic motion; never modify its source."""

import hashlib
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/brand-media/static'
SOURCE = BASE / 'held/packjoyu-papercraft-city-v2.png'
ORIGINAL = Path('C:/Users/admin/Desktop/video_1654824102804.gif')
OUTPUT = BASE / 'held/packjoyu-papercraft-city-loop.gif'
POSTER = BASE / 'held/packjoyu-papercraft-city-loop-poster.png'
REPORT = BASE / 'approved-image-gif-record.json'
WIDTH, HEIGHT = 1384, 720


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sky_and_airship(rgb):
    """Separate the existing airship from its simple sky, preserving its logo pixels."""
    h, w = rgb.shape[:2]
    x0, y0, x1, y1 = 202, 14, 625, 207
    roi = rgb[y0:y1, x0:x1]
    r, g, b = np.moveaxis(roi.astype(np.int16), -1, 0)
    sky = (b > r + 6) & (b > g + 1) & (b > 160)
    region = np.zeros(roi.shape[:2], np.uint8)
    polygon = np.array([(0, 20), (223, 0), (422, 0), (422, 155),
                        (340, 192), (198, 192), (198, 163),
                        (108, 163), (33, 173), (0, 149)], np.int32)
    cv2.fillPoly(region, [polygon], 255)
    foreground = ((~sky) & (region > 0)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(foreground, 8)
    if count < 2:
        raise RuntimeError('No airship layer could be extracted')
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (labels == largest).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    alpha = cv2.GaussianBlur(cv2.dilate(mask, np.ones((3, 3), np.uint8)), (3, 3), 0.55)
    erase = cv2.dilate(mask, np.ones((9, 9), np.uint8))
    yy, xx = np.mgrid[0:roi.shape[0], 0:roi.shape[1]].astype(np.float32)
    xx, yy = xx / roi.shape[1], yy / roi.shape[0]
    features = np.stack([np.ones_like(xx), xx, yy, xx * xx, xx * yy, yy * yy], -1)
    fit = sky & (erase == 0)
    coefficients = np.linalg.lstsq(features[fit], roi[fit].astype(np.float32), rcond=None)[0]
    reconstructed = np.clip(features @ coefficients, 0, 255)
    blend = cv2.GaussianBlur(erase.astype(np.float32) / 255, (7, 7), 1.2)[..., None]
    background = rgb.copy().astype(np.float32)
    background[y0:y1, x0:x1] = reconstructed * blend + roi * (1 - blend)
    sprite = np.zeros((h, w, 4), np.uint8)
    sprite[y0:y1, x0:x1, :3] = roi
    sprite[y0:y1, x0:x1, 3] = alpha
    return background, sprite


def main():
    if OUTPUT.exists():
        raise FileExistsError('Preserve the existing GIF; choose a new output filename for a revision.')
    source_hash, original_hash = digest(SOURCE), digest(ORIGINAL)
    durations = []
    with Image.open(ORIGINAL) as original:
        original_loop = original.info.get('loop')
        for index in range(original.n_frames):
            original.seek(index)
            durations.append(original.info.get('duration', 0))
    total = sum(durations)
    if len(durations) != 361 or total != 30080 or original_loop != 0:
        raise RuntimeError('Original GIF timing differs from the recorded source')
    rgb = np.asarray(Image.open(SOURCE).convert('RGB'))
    background, sprite = sky_and_airship(rgb)
    sh, sw = rgb.shape[:2]
    background = cv2.resize(background, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
    sprite = cv2.resize(sprite, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
    scale_x, scale_y = WIDTH / sw, HEIGHT / sh
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float32)
    base_u8 = np.clip(background, 0, 255).astype(np.uint8)
    rr, gg, bb = np.moveaxis(base_u8.astype(np.int16), -1, 0)
    water = ((gg > rr + 28) & (bb > rr + 24) & (gg > 130)
             & (yy > HEIGHT * .48) & (xx < WIDTH * .77)).astype(np.uint8)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(water, 8)
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    water = cv2.erode((labels == largest).astype(np.uint8), np.ones((5, 5), np.uint8))
    water = cv2.GaussianBlur(water.astype(np.float32), (5, 5), 1)
    glow = np.zeros((HEIGHT, WIDTH), np.float32)
    lamp_points = [(459, 178), (485, 176), (236, 411), (379, 420),
                   (520, 528), (779, 502), (891, 578), (956, 622),
                   (991, 669), (846, 690), (1252, 714), (1459, 776)]
    for x, y in lamp_points:
        cx, cy = x * scale_x, y * scale_y
        glow += np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * 2.7 ** 2))
    glow = np.clip(glow, 0, 1)
    original_resized = Image.fromarray(cv2.resize(rgb, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA))
    palette = original_resized.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    frames = []
    timestamps = []
    elapsed = 0
    for index, duration in enumerate(durations):
        phase = 2 * math.pi * elapsed / total
        frame = background.copy()
        shimmer = (np.sin(xx / 23 + yy / 8 - 4 * phase) +
                   .5 * np.sin(xx / 41 - yy / 13 + 3 * phase)) * 2.4 * water
        frame += shimmer[..., None] * np.array([.3, .85, 1], np.float32)
        pulse = 8 + 13 * (.5 + .5 * math.sin(6 * phase))
        frame += glow[..., None] * pulse * np.array([1, .66, .12], np.float32)
        transform = np.float32([[1, 0, 36 * scale_x * math.sin(phase)],
                                [0, 1, 3 * scale_y * math.sin(2 * phase)]])
        moved = cv2.warpAffine(sprite, transform, (WIDTH, HEIGHT), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
        alpha = moved[..., 3:4].astype(np.float32) / 255
        frame = np.clip(frame * (1 - alpha) + moved[..., :3] * alpha, 0, 255).astype(np.uint8)
        rendered = Image.fromarray(frame).quantize(palette=palette, dither=Image.Dither.NONE)
        frames.append(rendered)
        timestamps.append(elapsed)
        if index in (0, 90, 180, 270, 360):
            rendered.convert('RGB').save(BASE / f'evidence/gif-preview-{index:03d}.png')
        elapsed += duration
        if index % 60 == 0:
            print(f'rendered {index + 1}/361', flush=True)
    frames[0].save(OUTPUT, save_all=True, append_images=frames[1:], duration=durations,
                   loop=0, disposal=1, optimize=True)
    report = {
        'kind': 'new_animation_from_user_approved_image',
        'tool': 'Deterministic Python/OpenCV animation and Pillow GIF encoding; no video-generation API',
        'approvedImage': {'path': SOURCE.relative_to(ROOT).as_posix(), 'sha256': source_hash},
        'originalGif': {'path': str(ORIGINAL), 'sha256': original_hash, 'frameCount': 361,
                        'durationsMs': durations, 'durationMs': total, 'loop': 0},
        'motion': {'camera': 'fixed', 'airship': 'periodic translation; logo moves with original sprite',
                   'airshipMaxTranslationSourcePixels': [36, 3],
                   'lighting': 'restrained periodic glow of existing warm lamps',
                   'water': 'small luminance shimmer inside eroded river mask',
                   'periodMs': total},
        'palette': {'colors': 255, 'mode': 'one global palette', 'dither': 'none',
                    'deltaOptimization': True},
        'frameStartMs': timestamps,
        'output': {'path': OUTPUT.relative_to(ROOT).as_posix(), 'sha256': digest(OUTPUT),
                   'width': WIDTH, 'height': HEIGHT, 'bytes': OUTPUT.stat().st_size},
        'releaseAllowed': False,
        'boundary': 'New authorized style animation, not a claim of frame-by-frame identity with the supplied original GIF; M1-T6 is not marked landed.',
    }
    with Image.open(OUTPUT) as encoded:
        encoded_durations = []
        for index in range(encoded.n_frames):
            encoded.seek(index)
            encoded.convert('RGB').load()
            encoded_durations.append(encoded.info.get('duration', 0))
        encoded.seek(0)
        encoded.convert('RGB').save(POSTER)
        report['output'].update(frameCount=encoded.n_frames, durationMs=sum(encoded_durations),
                                durationsMs=encoded_durations, loop=encoded.info.get('loop'))
    if encoded_durations != durations:
        raise RuntimeError('Encoded GIF changed the supplied frame timing')
    if digest(SOURCE) != source_hash or digest(ORIGINAL) != original_hash:
        raise RuntimeError('An original source changed')
    report['pauseFrame'] = {'path': POSTER.relative_to(ROOT).as_posix(), 'sha256': digest(POSTER),
                             'width': WIDTH, 'height': HEIGHT}
    REPORT.write_bytes((json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf8'))
    print(json.dumps({key: value for key, value in report['output'].items() if key != 'durationsMs'}), flush=True)


if __name__ == '__main__':
    main()
