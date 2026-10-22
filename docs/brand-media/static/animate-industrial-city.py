"""Layered animation of the requested static revision; preserve source files and logos."""

import hashlib
import importlib.util
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/brand-media/static'
SOURCE = BASE / 'held/packjoyu-industrial-city-v3.png'
ORIGINAL_GIF = Path('C:/Users/admin/Desktop/video_1654824102804.gif')
OUTPUT = BASE / 'held/packjoyu-industrial-city-v3-loop.gif'
POSTER = BASE / 'held/packjoyu-industrial-city-v3-loop-poster.png'
RECORD = BASE / 'industrial-city-animation-record.json'
WIDTH, HEIGHT = 1384, 720


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sky_layer(rgb, box, cloud=False):
    x0, y0, x1, y1 = box
    roi = rgb[y0:y1, x0:x1]
    r, g, b = np.moveaxis(roi.astype(np.int16), -1, 0)
    sky = (b > r + 9) & (b > g + 1) & (b > 165)
    foreground = (~sky).astype(np.uint8)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(foreground, 8)
    label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (labels == label).astype(np.uint8) * 255
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(mask, contours, -1, 255, cv2.FILLED)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255, (5, 5), 1 if cloud else .6)
    erased = cv2.dilate(mask, np.ones((11, 11), np.uint8))
    yy, xx = np.mgrid[0:roi.shape[0], 0:roi.shape[1]].astype(np.float32)
    xx, yy = xx / roi.shape[1], yy / roi.shape[0]
    features = np.stack([np.ones_like(xx), xx, yy, xx * xx, xx * yy, yy * yy], -1)
    sample = sky & (erased == 0)
    if sample.sum() < 50:
        raise ValueError('Sky layer needs enough clear-sky samples')
    coefficients = np.linalg.lstsq(features[sample], roi[sample].astype(np.float32), rcond=None)[0]
    patch = np.clip(features @ coefficients, 0, 255)
    blend = cv2.GaussianBlur(erased.astype(np.float32) / 255, (7, 7), 1)[..., None]
    background = rgb.astype(np.float32).copy()
    background[y0:y1, x0:x1] = roi * (1 - blend) + patch * blend
    return background, np.dstack([roi, (alpha * 255).astype(np.uint8)]), (x0, y0)


def paste(frame, sprite, left, top):
    ix, iy = math.floor(left), math.floor(top)
    fx, fy = left - ix, top - iy
    h, w = sprite.shape[:2]
    shifted = cv2.warpAffine(sprite, np.float32([[1, 0, fx], [0, 1, fy]]),
                            (w + 2, h + 2), flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    x0, y0 = max(0, ix), max(0, iy)
    x1, y1 = min(frame.shape[1], ix + shifted.shape[1]), min(frame.shape[0], iy + shifted.shape[0])
    if x1 <= x0 or y1 <= y0:
        return
    tile = shifted[y0 - iy:y1 - iy, x0 - ix:x1 - ix]
    alpha = tile[..., 3:4].astype(np.float32) / 255
    frame[y0:y1, x0:x1] = frame[y0:y1, x0:x1] * (1 - alpha) + tile[..., :3] * alpha


def main():
    if OUTPUT.exists():
        raise FileExistsError('Preserve existing animation; choose a new filename for a revision')
    source_sha, original_sha = sha(SOURCE), sha(ORIGINAL_GIF)
    rgb = np.asarray(Image.open(SOURCE).convert('RGB'))
    if rgb.shape != (905, 1737, 3):
        raise ValueError('Recalibrate the scene masks for another source image')
    spec = importlib.util.spec_from_file_location('industrial_forklift', BASE / 'extract-industrial-forklift.py')
    extraction = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(extraction)
    clean, forklift, forklift_meta = extraction.extract_forklift(rgb)
    layers = []
    for name, box, cloud in [('left_cloud', (0, 53, 246, 204), True),
                             ('high_cloud', (683, 2, 937, 153), True),
                             ('metal_airship', (211, 14, 659, 211), False)]:
        revised, layer, origin = sky_layer(rgb, box, cloud)
        x0, y0, x1, y1 = box
        clean[y0:y1, x0:x1] = np.clip(revised[y0:y1, x0:x1], 0, 255).astype(np.uint8)
        layers.append((name, layer, origin))
        Image.fromarray(layer).save(BASE / f'evidence/industrial-{name}-layer.png')
    Image.fromarray(clean).save(BASE / 'evidence/industrial-clean-plate.png')
    Image.fromarray(forklift).save(BASE / 'evidence/industrial-forklift-layer.png')
    source = cv2.resize(rgb, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
    background = cv2.resize(clean, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA).astype(np.float32)
    sx, sy = WIDTH / rgb.shape[1], HEIGHT / rgb.shape[0]
    scaled_layers = [(name, cv2.resize(layer, None, fx=sx, fy=sy, interpolation=cv2.INTER_AREA),
                      (origin[0] * sx, origin[1] * sy)) for name, layer, origin in layers]
    forklift = cv2.resize(forklift, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float32)
    r, g, b = np.moveaxis(source.astype(np.int16), -1, 0)
    water = ((g > r + 2) & (b > r + 10) & (b > g - 10) & (g > 30)
             & (yy > HEIGHT * .50) & (xx < WIDTH * .72)).astype(np.uint8)
    water = cv2.morphologyEx(water, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8))
    contours, _ = cv2.findContours(water, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    water[:] = 0
    for contour in contours:
        if cv2.contourArea(contour) > 500:
            cv2.drawContours(water, [contour], -1, 1, cv2.FILLED)
    river_region = np.zeros((HEIGHT, WIDTH), np.uint8)
    river_polygon = np.array([(0, 450), (220, 490), (420, 540), (530, 610),
                              (590, 663), (720, 700), (860, 755), (1000, 850),
                              (1120, 905), (0, 905)], np.float32)
    river_polygon *= np.array([sx, sy], np.float32)
    cv2.fillPoly(river_region, [river_polygon.astype(np.int32)], 1)
    water *= river_region
    # Protect the complete vessel and bridge/dock edges from water remapping.
    water[int(640 * sy):, int(30 * sx):int(545 * sx)] = 0
    water[int(552 * sy):int(661 * sy), int(214 * sx):int(626 * sx)] = 0
    water[int(572 * sy):int(741 * sy), int(250 * sx):int(438 * sx)] = 0
    water = cv2.erode(water, np.ones((5, 5), np.uint8))
    water_alpha = np.clip(cv2.distanceTransform(water, cv2.DIST_L2, 3) / 7, 0, 1)
    Image.fromarray((water_alpha * 255).astype(np.uint8)).save(BASE / 'evidence/industrial-water-mask.png')
    occluder = np.zeros(rgb.shape[:2], np.uint8)
    cv2.fillPoly(occluder, [np.array(forklift_meta['foregroundOccluderPolygon'], np.int32)], 255)
    occluder = cv2.resize(occluder, (WIDTH, HEIGHT), interpolation=cv2.INTER_NEAREST) > 0
    rng = np.random.default_rng(73125)
    smoke_texture = cv2.GaussianBlur(rng.random((64, 64), dtype=np.float32), (9, 9), 2)
    smoke_texture = .45 + .8 * smoke_texture / smoke_texture.max()
    gy, gx = np.mgrid[-1:1:64j, -1:1:64j]
    smoke_texture *= np.exp(-(gx * gx + gy * gy) * 2.5).astype(np.float32)
    with Image.open(ORIGINAL_GIF) as original:
        durations = []
        for index in range(original.n_frames):
            original.seek(index)
            durations.append(original.info.get('duration', 0))
    if len(durations) != 361 or sum(durations) != 30080:
        raise ValueError('Original GIF timing changed')
    total = sum(durations)
    palette = Image.fromarray(source).quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    frames, starts, elapsed = [], [], 0
    for index, duration in enumerate(durations):
        phase = 2 * math.pi * elapsed / total
        frame = background.copy()
        # A travelling displacement field transports the existing ripple pixels.
        displacement_x = (9 * np.sin(yy / 20 - 6 * phase)
                          + 3 * np.sin(xx / 29 + yy / 21 - 10 * phase)) * water_alpha
        displacement_y = 4.5 * np.sin(xx / 25 + yy / 31 - 6 * phase) * water_alpha
        water_frame = cv2.remap(source, xx - displacement_x, yy - displacement_y,
                                cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
        frame = frame * (1 - water_alpha[..., None]) + water_frame * water_alpha[..., None]
        for name, layer, (left, top) in scaled_layers:
            if name == 'left_cloud':
                dx, dy = -28 * sx * (.5 - .5 * math.cos(phase)), 0
            elif name == 'high_cloud':
                dx, dy = 20 * sx * math.sin(phase), .7 * sy * math.sin(2 * phase)
            else:
                dx, dy = 29 * sx * math.sin(phase), 2.5 * sy * math.sin(2 * phase)
            paste(frame, layer, left + dx, top + dy)
        q = .5 - .5 * math.cos(4 * phase)
        moved_forklift = cv2.warpAffine(forklift, np.float32([[1, 0, -64 * sx * q], [0, 1, 0]]),
                                        (WIDTH, HEIGHT), flags=cv2.INTER_LINEAR,
                                        borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
        alpha = moved_forklift[..., 3:4].astype(np.float32) / 255
        frame = frame * (1 - alpha) + moved_forklift[..., :3] * alpha
        frame[occluder] = source[occluder]
        # Repeated emission has zero alpha at birth/death, so the loop has no smoke pop.
        for particle in range(18):
            age = ((elapsed / total * 6 + particle / 18) % 1)
            radius = (4 + 18 * age) * sx
            opacity = .27 * math.sin(math.pi * age) ** 2
            diameter = max(4, int(radius * 2))
            texture = cv2.resize(smoke_texture, (diameter, diameter), interpolation=cv2.INTER_LINEAR)
            smoke = np.empty((diameter, diameter, 4), np.uint8)
            smoke[..., :3] = (223, 227, 232)
            smoke[..., 3] = np.clip(texture * opacity * 255, 0, 255).astype(np.uint8)
            smoke_x = (235 - 26 * age + 4 * math.sin(5 * age + particle)) * sx
            smoke_y = (672 - 119 * age) * sy
            paste(frame, smoke, smoke_x - radius, smoke_y - radius)
        rendered = Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8)).quantize(
            palette=palette, dither=Image.Dither.NONE)
        frames.append(rendered)
        starts.append(elapsed)
        if index in [0, 45, 90, 180, 270, 360]:
            rendered.convert('RGB').save(BASE / f'evidence/industrial-gif-preview-{index:03d}.png')
        elapsed += duration
        if index % 60 == 0:
            print(f'rendered {index + 1}/361', flush=True)
    frames[0].save(OUTPUT, save_all=True, append_images=frames[1:], duration=durations,
                   loop=0, disposal=1, optimize=True)
    with Image.open(OUTPUT) as encoded:
        encoded_durations = []
        for index in range(encoded.n_frames):
            encoded.seek(index)
            encoded.convert('RGB').load()
            encoded_durations.append(encoded.info.get('duration', 0))
        encoded.seek(0)
        encoded.convert('RGB').save(POSTER)
        actual_frames, loop = encoded.n_frames, encoded.info.get('loop')
    if encoded_durations != durations or loop != 0:
        raise ValueError('Encoded GIF changed original frame timings or loop')
    if sha(SOURCE) != source_sha or sha(ORIGINAL_GIF) != original_sha:
        raise ValueError('A source was modified')
    record = {
        'kind': 'new_animation_from_requested_static_revision',
        'tool': 'Deterministic layered OpenCV animation and Pillow GIF encoding; no video generation API',
        'approvedImage': {'path': SOURCE.relative_to(ROOT).as_posix(), 'sha256': source_sha},
        'staticReview': 'Root and independent visual review passed the eight requested static corrections before animation.',
        'originalGif': {'path': ORIGINAL_GIF.as_posix(), 'sha256': original_sha,
                        'frameCount': 361, 'durationMs': total, 'durationsMs': durations, 'loop': 0},
        'output': {'path': OUTPUT.relative_to(ROOT).as_posix(), 'sha256': sha(OUTPUT),
                   'width': WIDTH, 'height': HEIGHT, 'bytes': OUTPUT.stat().st_size,
                   'frameCount': actual_frames, 'durationMs': total, 'durationsMs': encoded_durations, 'loop': loop},
        'pauseFrame': {'path': POSTER.relative_to(ROOT).as_posix(), 'sha256': sha(POSTER),
                       'width': WIDTH, 'height': HEIGHT},
        'frameStartMs': starts, 'forkliftLayer': forklift_meta,
        'motion': {'camera': 'fixed', 'clouds': 'two independently translated natural-cloud layers',
                   'airship': 'metal airship and original logo translated as one intact layer',
                   'water': 'travelling remap of existing water texture inside eroded river mask; ship and banks protected',
                   'smoke': '18 seeded, smoothly faded particle textures emitted from ship funnel',
                   'forklift': 'driver, loaded pallet, complete vehicle and shadow move together left64px and reverse, four trips per loop; no mirroring'},
        'seed': 73125, 'palette': {'colors': 255, 'global': True, 'dither': 'none', 'deltaOptimization': True},
        'releaseAllowed': False,
        'boundary': 'Fictional brand animation; no actual-factory claim and no automatic M1-T6 landed status.',
    }
    RECORD.write_bytes((json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode('utf8'))
    print(json.dumps({k: v for k, v in record['output'].items() if k != 'durationsMs'}), flush=True)


if __name__ == '__main__':
    main()
