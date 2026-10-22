"""Planar replacement of visible early-shot packaging print, frames 114..222.

This helper writes diagnostics only below its own planning directory. Import
process_frame(frame, index) for deterministic BGR input/output during encoding.
"""
from pathlib import Path
import argparse
import hashlib
import json
import cv2
import numpy as np

BASE = Path(__file__).resolve().parent
LOGO_PATH = BASE.parent / 'evidence/exact-logo-reference.png'
LOGO = cv2.imread(str(LOGO_PATH), cv2.IMREAD_UNCHANGED)
assert LOGO is not None and LOGO.shape[2] == 4


def order_quad(points):
    points = np.asarray(points, np.float32)
    ordered = sorted(points.tolist(), key=lambda p: p[0])
    left = sorted(ordered[:2], key=lambda p: p[1])
    right = sorted(ordered[2:], key=lambda p: p[1])
    return np.array([left[0], right[0], right[1], left[1]], np.float32)


def red_support(frame):
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    return (cv2.inRange(hsv, (0, 65, 55), (12, 255, 255)) |
            cv2.inRange(hsv, (170, 65, 55), (179, 255, 255)))


def inspect_frame(frame, index):
    raw = red_support(frame)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    contours, _ = cv2.findContours(raw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    labels = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < 100:
            continue
        rect = cv2.minAreaRect(contour)
        major, minor = sorted(rect[1], reverse=True)
        x_center, y_center = rect[0]
        frame_edge_fragment = ((x_center < 30 or x_center > frame.shape[1] - 30)
                               and y_center > 550 and minor > 7 and major > 12)
        partial_brand_slot = ((y_center > 760 and minor > 18 and major / max(minor, 1) > 1.15)
                              or (x_center > 1450 and 650 < y_center < 800
                                  and minor > 20 and major / max(minor, 1) > 1.15)
                              or frame_edge_fragment)
        if minor < 1 or (major < 35 and not frame_edge_fragment) or (major / minor < 2.3 and not partial_brand_slot):
            continue
        quad = order_quad(cv2.boxPoints(rect))
        y = float(rect[0][1])
        angle = np.degrees(np.arctan2(*(quad[1] - quad[0])[::-1]))
        if not 390 < y < 1030 or not -3 < angle < 17:
            continue
        small_far_slot = ((y < 470 or (rect[0][0] > 1750 and 530 < y < 580))
                          and minor > 7 and major > 40)
        thickness_min = max(7, .066 * y - 20) * (.5 if frame_edge_fragment else (.80 if partial_brand_slot else 1))
        if (minor < thickness_min and not small_far_slot) or area / (major * minor) < .58:
            continue
        bx, by, bw, bh = cv2.boundingRect(np.round(quad).astype(np.int32))
        bx, by = max(0, bx - 3), max(0, by - 3)
        bw = min(frame.shape[1] - bx, bw + 7)
        bh = min(frame.shape[0] - by, bh + 7)
        offset = np.array([bx, by], np.float32)
        local_quad = quad - offset
        qmask = np.zeros((bh, bw), np.uint8)
        cv2.fillConvexPoly(qmask, np.round(local_quad).astype(np.int32), 255)
        component = np.zeros_like(qmask)
        cv2.drawContours(component, [contour - offset.astype(np.int32)], -1, 255, -1)
        local_raw = raw[by:by + bh, bx:bx + bw]
        local_hsv = hsv[by:by + bh, bx:bx + bw]
        # A guide crossing the strip is a neutral region that reaches both
        # longitudinal edges. Printed glyph cavities remain inside those edges.
        w, h = max(8, int(round(major))), max(6, int(round(minor)))
        target = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
        rectify = cv2.getPerspectiveTransform(local_quad, target)
        red_plane = cv2.warpPerspective(local_raw, rectify, (w, h), flags=cv2.INTER_NEAREST)
        neutral = (red_plane == 0).astype(np.uint8)
        count_cc, components, stats, _ = cv2.connectedComponentsWithStats(neutral, 8)
        foreground_plane = np.zeros((h, w), np.uint8)
        for cc in range(1, count_cc):
            cx, cy, cw, ch, ca = stats[cc]
            reaches_edges = cy <= 1 and cy + ch >= h - 1
            if reaches_edges and ca >= max(8, h * .6):
                foreground_plane[components == cc] = 255
        inverse = cv2.getPerspectiveTransform(target, local_quad)
        foreground = cv2.warpPerspective(foreground_plane, inverse, (bw, bh), flags=cv2.INTER_NEAREST)
        foreground = cv2.bitwise_and(foreground, qmask)
        # The diagonal rail clips just one corner of this narrow near-left
        # exposure, so it need not span both long edges of the strip.
        near_left_rail_fragment = (150 < x_center < 550 and 750 < y_center < 850
                                   and major < 150)
        rail_foreground_pixels = 0
        if near_left_rail_fragment:
            dark = ((qmask > 0) & (local_raw == 0) &
                    (local_hsv[:, :, 1] < 65) & (local_hsv[:, :, 2] < 185)).astype(np.uint8)
            boundary = qmask - cv2.erode(qmask, np.ones((3, 3), np.uint8))
            dark_count, dark_parts, dark_stats, _ = cv2.connectedComponentsWithStats(dark, 8)
            for part in range(1, dark_count):
                pixels = dark_parts == part
                if dark_stats[part, cv2.CC_STAT_AREA] >= 4 and np.any(pixels & (boundary > 0)):
                    rail_foreground_pixels += int(np.sum(pixels & (foreground == 0)))
                    foreground[pixels] = 255
        surface = cv2.bitwise_and(qmask, cv2.bitwise_not(foreground))
        neutral_white = ((local_hsv[:, :, 1] < 120) & (local_hsv[:, :, 2] > 175))
        cavity_white = (component > 0) & (local_raw == 0) & neutral_white
        if int(cavity_white.sum()) >= 4:
            white = cavity_white
        else:
            # At a cut-off label end, a few printed glyph strokes join the
            # surrounding white paper. Restrict that fallback to the known
            # branding rows, never the thin red border below ruler rails.
            x = float(rect[0][0])
            known_clipped_slot = ((620 < y < 735 and 450 < x < 1500)
                                  or (560 < y < 630 and x < 350)
                                  or (390 < y < 470)
                                  or (530 < y < 580 and x > 1750)
                                  or (major / minor > 6 and area > 1500)
                                  or partial_brand_slot)
            if not known_clipped_slot:
                continue
            # Motion-blurred cream/white strokes can still have enough red
            # saturation to belong to the red substrate component. They must
            # not be required to form threshold-mask holes.
            white = (surface > 0) & neutral_white
        count = int(white.sum())
        dominant_brand_strip = area > 1500 and major / minor > 5.5
        if count < max(4, area * .0015) and not dominant_brand_strip:
            continue
        ys, xs = np.where(white)
        if not len(xs):
            xs = np.array([int(rect[0][0]) - bx])
            ys = np.array([int(rect[0][1]) - by])
        labels.append({'quad': quad, 'surface': surface, 'foreground': foreground,
                       'railForegroundPixels': rail_foreground_pixels,
                       'oldWhiteMask': white.astype(np.uint8) * 255,
                       'rect': [bx, by, bw, bh],
                       'whiteBounds': [int(xs.min()) + bx, int(ys.min()) + by,
                                       int(xs.max()) + bx + 1, int(ys.max()) + by + 1],
                       'whitePixels': count, 'thickness': float(minor), 'area': float(area),
                       'solidity': float(area / (major * minor)), 'angle': float(angle)})
    labels.sort(key=lambda item: (float(item['quad'][:, 1].mean()), float(item['quad'][:, 0].mean())))
    return labels


def replace_label(frame, label):
    quad = label['quad']
    bx, by, bw, bh = label['rect']
    local_frame = frame[by:by + bh, bx:bx + bw]
    local_quad = quad - np.array([bx, by], np.float32)
    w = max(8, int(round(np.linalg.norm(quad[1] - quad[0]))))
    image_h = max(6, int(round(np.linalg.norm(quad[3] - quad[0]))))
    # The artwork is authored in the sheet plane; its depth axis is compressed
    # by the oblique camera. It is not upright screen-space text pasted on top.
    h = image_h * 2
    target = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    rectify = cv2.getPerspectiveTransform(local_quad, target)
    patch = cv2.warpPerspective(local_frame, rectify, (w, h), flags=cv2.INTER_CUBIC)
    raw = red_support(patch)
    # Brand replacement is limited to the existing red strip. Use a pale
    # paper-color panel so the exact black/coral master retains its colors.
    paper = np.array([231., 239., 241.], np.float32)  # BGR warm paper, no tint to logo.
    luminance = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY).astype(np.float32)
    valid_red = raw > 0
    red_values = luminance[valid_red]
    local = float(np.median(red_values)) if red_values.size else 150.
    shade = np.clip(cv2.GaussianBlur(luminance, (0, 0), max(1., h / 6)) / max(local, 1), .84, 1.04)
    clean = np.clip(paper[None, None, :] * shade[:, :, None], 0, 255).astype(np.uint8)
    # Centre the newly authored brand consistently in its visible strip rather
    # than following a brightness centroid that jumps during fast paper feeds.
    center_x = w * .50
    logo_h = max(4, min(h - 4, int(round(h * .46))))
    logo_w = max(1, int(round(logo_h * LOGO.shape[1] / LOGO.shape[0])))
    x = int(round(center_x - logo_w / 2))
    y = max(1, int(round((h - logo_h) / 2)))
    logo = cv2.resize(LOGO, (logo_w, logo_h), interpolation=cv2.INTER_AREA)
    # A narrow exposed fragment clips the same-size physical print; it does not
    # squeeze an entire miniature wordmark into the gap beside a roller.
    left, right = max(0, x), min(w, x + logo_w)
    part = logo[:, left - x:right - x]
    a = part[:, :, 3:4].astype(np.float32) / 255
    region = clean[y:y + logo_h, left:right].astype(np.float32)
    clean[y:y + logo_h, left:right] = np.clip(part[:, :, :3] * a + region * (1 - a), 0, 255).astype(np.uint8)
    # Match the optical softness of each physical depth plane.
    blur = .9 if image_h < 25 else (1.5 if image_h < 40 else 2.4)
    clean = cv2.GaussianBlur(clean, (0, 0), sigmaX=blur, sigmaY=blur * 2)
    inverse = cv2.getPerspectiveTransform(target, local_quad)
    overlay = cv2.warpPerspective(clean, inverse, (bw, bh), flags=cv2.INTER_CUBIC,
                                  borderMode=cv2.BORDER_REPLICATE)
    matte = label['surface'].astype(np.float32) / 255
    matte = cv2.GaussianBlur(matte, (0, 0), .45)
    matte[label['surface'] == 0] = 0
    matte[label['foreground'] > 0] = 0
    alpha = matte[:, :, None]
    result = frame.copy()
    result[by:by + bh, bx:bx + bw] = np.clip(overlay * alpha + local_frame * (1 - alpha), 0, 255).astype(np.uint8)
    return result


def process_frame_with_record(frame, index):
    if not 114 <= index <= 222:
        return frame.copy(), {'index': index, 'edited': False, 'labels': []}, None, None
    labels = inspect_frame(frame, index)
    edited = frame.copy()
    surface = np.zeros(frame.shape[:2], np.uint8)
    foreground = np.zeros(frame.shape[:2], np.uint8)
    old_white = np.zeros(frame.shape[:2], np.uint8)
    records = []
    for number, label in enumerate(labels):
        edited = replace_label(edited, label)
        bx, by, bw, bh = label['rect']
        surface[by:by + bh, bx:bx + bw] |= label['surface']
        foreground[by:by + bh, bx:bx + bw] |= label['foreground']
        old_white[by:by + bh, bx:bx + bw] |= label['oldWhiteMask']
        records.append({'number': number + 1, 'quadTLTRBRBL': label['quad'].round(3).tolist(),
                        'visibleOldWhiteGlyphBoundsXYXY': label['whiteBounds'],
                        'oldWhitePixelCount': label['whitePixels'], 'redArea': round(label['area'], 2),
                        'artworkPlaneDepthScale': 2,
                        'diagonalRailForegroundPixels': label['railForegroundPixels'],
                        'thicknessPx': round(label['thickness'], 3),
                        'redSolidity': round(label['solidity'], 4), 'angleDegrees': round(label['angle'], 3)})
    record = {'index': index, 'atMs': round(index / 60 * 1000, 6), 'edited': bool(labels), 'labels': records,
              'surfaceMask': f'masks/surface-f{index:04d}.png', 'foregroundMask': f'masks/foreground-f{index:04d}.png',
              'foregroundMethod': 'Cross-strip neutral obstructions plus boundary-connected dark nonred diagonal-rail pixels in the narrow near-left exposure; original foreground pixels restored.'}
    changed = np.any(edited != frame, axis=2)
    allowed = cv2.dilate(surface, np.ones((5, 5), np.uint8)) > 0
    record['pixelVerification'] = {
        'changedPixels': int(changed.sum()),
        'changedOutsideSurfaceAntialiasMargin': int((changed & ~allowed).sum()),
        'foregroundMaskPixels': int((foreground > 0).sum()),
        'changedProtectedForegroundPixels': int((changed & (foreground > 0)).sum()),
        'originalWhitePrintPixels': int((old_white > 0).sum()),
        'unchangedOriginalWhitePrintPixels': int((~changed & (old_white > 0) & (foreground == 0)).sum())}
    return edited, record, surface, foreground


def process_frame(frame, index):
    return process_frame_with_record(frame, index)[0]
