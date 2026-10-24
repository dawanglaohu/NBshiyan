"""File-backed release checks for the selected artwork and edited video, not source history."""
import hashlib
import json
from functools import lru_cache
from pathlib import Path

import cv2
from PIL import Image

REQUIRED_ROLES = {'static_image', 'animated_gif', 'gif_pause_still', 'gif_preview', 'video_1080p', 'video_720p', 'video_poster'}
VIDEO_ROLES = {'video_1080p', 'video_720p'}
VERIFIED_PRODUCTION = {'complete', 'executed_verified', 'executed_verified_animation',
                       'executed_verified_local_media', 'executed_verified_release', 'user_accepted_saved'}
OBSERVATION_ROLES = {'opening', 'ending', 'watermark', 'product_print', 'product_brand', 'equipment'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


@lru_cache(maxsize=96)
def encoded_frame_hash(path, content_sha256, frame_index, extension, quality):
    # The caller hashes the complete movie on every check; content, not mtime, keys reuse.
    video = cv2.VideoCapture(path)
    try:
        require(video.isOpened(), 'Selected video cannot be decoded')
        video.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        ok, pixels = video.read()
        require(ok, 'Selected frame cannot be decoded')
        options = [cv2.IMWRITE_JPEG_QUALITY, quality] if extension == '.jpg' else []
        ok, data = cv2.imencode(extension, pixels, options)
        require(ok, 'Selected frame cannot be encoded')
        return hashlib.sha256(data.tobytes()).hexdigest(), pixels.shape[1], pixels.shape[0]
    finally:
        video.release()


class Records:
    def __init__(self, root, manifest):
        self.root = root.resolve()
        self.registered = {row['path']: row for row in manifest['files']}

    def path(self, value):
        target = (self.root / value).resolve()
        require(target.is_relative_to(self.root), 'Selected evidence is outside repository')
        require(target.is_file(), f'Missing evidence: {value}')
        return target

    def file(self, row, registered=False):
        target = self.path(row['path'])
        require(hashlib.sha256(target.read_bytes()).hexdigest() == row['sha256'],
                f'Hash mismatch: {row["path"]}')
        if registered:
            actual = self.registered.get(row['path'])
            require(actual is not None, 'Selected file is not registered')
            for key in ['sha256', 'width', 'height', 'fps', 'frameCount']:
                if key in row:
                    require(row[key] == actual.get(key), f'Selected registered {key} differs')
        return target

    def basis(self, rows):
        require(isinstance(rows, list) and rows, 'Selected review lacks basis files')
        for row in rows:
            self.file(row)
        return {row['path'] for row in rows}

    def frame(self, frame, output):
        target = self.file(frame, registered=True)
        require(type(frame['frameIndex']) is int and 0 <= frame['frameIndex'] < output['frameCount'],
                'Selected frame index out of range')
        require(abs(frame['atMs'] - frame['frameIndex'] / output['fps'] * 1000) < .001,
                'Selected frame timestamp differs')
        extension = target.suffix.lower()
        require(extension in {'.png', '.jpg', '.jpeg'}, 'Selected frame encoding is unsupported')
        extension = '.jpg' if extension == '.jpeg' else extension
        quality = frame.get('jpegQuality', 95)
        require(type(quality) is int and 1 <= quality <= 100, 'Invalid selected JPEG quality')
        digest, width, height = encoded_frame_hash(str(self.path(output['path'])), output['sha256'],
                                                  frame['frameIndex'], extension, quality)
        require(digest == frame['sha256'], 'Selected frame does not reproduce from selected movie')
        require((width, height) == (frame['width'], frame['height'])
                == (output['width'], output['height']), 'Selected frame dimensions differ')


def verify_deliverables(records, manifest, selection):
    rows = manifest.get('selectedDeliverables', [])
    require(rows and rows == selection.get('deliverables'), 'Selected deliverables disagree')
    by_role = {row['role']: row for row in rows}
    require(len(by_role) == len(rows) and set(by_role) == REQUIRED_ROLES, 'Selected roles are incomplete or duplicated')
    paths = [row['path'] for row in rows]
    require(len(set(paths)) == len(paths), 'Duplicate selected release path')
    require(len(manifest['releaseFiles']) == len(paths) and set(manifest['releaseFiles']) == set(paths),
            'Release set differs from selected deliverables')
    for row in rows:
        require(row['path'].startswith('public/brand/'), 'Selected release must use public brand assets')
        public_file = records.file(row, registered=True)
        require(public_file.is_relative_to((records.root / 'public/brand').resolve()),
                'Selected release resolves outside public brand assets')
        records.file(row['source'], registered=True)
        require(row['sha256'] == row['source']['sha256'], 'Published copy differs from selected source')
        require(records.registered[row['path']].get('releaseAllowed') is True, 'Selected public file is not releasable')
        require(row['source']['path'] in manifest.get('heldFiles', []), 'Selected original derivative is not preserved')
    saved = read_json(records.path('docs/brand-media/static/saved-media-index.json'))
    require(saved.get('registeredMedia') == manifest['files']
            and saved.get('registeredMediaCount') == len(manifest['files']), 'Saved media index registry differs')
    require(saved.get('releaseFiles') == manifest['releaseFiles'], 'Saved media index release set differs')
    saved_rows = saved.get('selectedAssets', [])
    require(len(saved_rows) == len(rows), 'Saved media index selection differs')
    saved_by_role = {row['role']: row for row in saved_rows}
    require(set(saved_by_role) == set(by_role), 'Saved media index roles differ')
    for role, row in by_role.items():
        require(all(saved_by_role[role].get(key) == row[key] for key in ['path', 'sha256', 'width', 'height']),
                'Saved media index selection differs')
    return by_role


def verify_static(records, manifest, selection, by_role, accepted):
    review = selection['staticReview']
    static = by_role['static_image']
    expected = next(row for row in accepted['assets'] if row['role'] == 'static_image')
    require(review['source'] == static['source'], 'Static review source differs')
    require(all(static['source'][key] == expected[key] for key in ['path', 'sha256']), 'Static selection is not accepted industrial artwork')
    require(all(review['master'][key] == manifest['logoMaster'][key] for key in ['path', 'sha256']), 'Static master differs')
    records.file(review['master'])
    basis = records.basis(review['basis'])
    require('docs/brand-media/static/accepted-industrial-assets.json' in basis
            and 'docs/brand-media/static/style-generation-record.json' in basis,
            'Static acceptance/production basis is missing')
    generation = read_json(records.path('docs/brand-media/static/style-generation-record.json'))
    require(generation.get('tool') == 'image_gen.imagegen' and generation.get('result') == 'succeeded',
            'Selected static production was not executed')
    require(all(generation['latestOutput'][key] == static['source'][key] for key in ['path', 'sha256']),
            'Selected static is not the actual generated output')
    locations = review.get('brandLocations', [])
    require({row['id'] for row in locations} == {'airship', 'factory'} and len(locations) == 2,
            'Static brand location review is incomplete')
    with Image.open(records.file(static['source'])) as image:
        require(image.size == (static['width'], static['height']), 'Static selected dimensions differ')
        for row in locations:
            require(row.get('text') == 'PackJoyU', 'Static brand text differs')
            require(row.get('oldLogoReview') == 'no_residual', 'Static old-mark review is missing')
            bounds = row['bounds']
            require(len(bounds) == 4 and all(type(x) is int for x in bounds), 'Static crop bounds invalid')
            x, y, width, height = bounds
            require(0 <= x < x + width <= image.width and 0 <= y < y + height <= image.height,
                    'Static brand crop out of range')
            path = records.file(row['evidence'], registered=True)
            with Image.open(path) as crop:
                require(crop.size == (width, height) == (row['evidence']['width'], row['evidence']['height']),
                        'Static brand crop dimensions differ')
                require(crop.convert('RGBA').tobytes() == image.crop((x, y, x + width, y + height)).convert('RGBA').tobytes(),
                        'Static brand evidence does not reproduce selected artwork')
    for role, source in [('animated_gif', next(row for row in accepted['assets'] if row['role'] == 'animated_gif')),
                         ('gif_preview', accepted['preview'])]:
        require(all(by_role[role]['source'][key] == source[key] for key in ['path', 'sha256']),
                'Animation selection differs from accepted artwork')


def verify_observations(records, output):
    evidence = output.get('evidence', [])
    require(evidence, 'Selected movie lacks frame evidence')
    frame_by_path = {frame['path']: frame for frame in evidence}
    require(len(frame_by_path) == len(evidence), 'Duplicate selected movie frame evidence')
    for frame in evidence:
        records.frame(frame, output)
    observations = output.get('observations', [])
    require({row['role'] for row in observations} >= OBSERVATION_ROLES, 'Selected identity observations are incomplete')
    for row in observations:
        require(0 <= row['fromMs'] < row['toMs'] <= output['movieDurationMs'], 'Selected observation time out of range')
        records.basis(row.get('basis', []))
        paths = row.get('evidencePaths', [])
        require(paths, 'Selected observation lacks frame evidence')
        for path in paths:
            require(path in frame_by_path, 'Selected observation frame is unregistered')
            require(row['fromMs'] - .001 <= frame_by_path[path]['atMs'] < row['toMs'] + .001,
                    'Selected observation evidence time differs')
        if row['role'] == 'equipment':
            require(row['identity'] in {'OWN_VERIFIED', 'THIRD_PARTY', 'UNKNOWN'}
                    and row.get('replacementStatus') == 'preserved_equipment', 'Equipment review is invalid')
        else:
            require(row['identity'] == 'OWN_VERIFIED', 'Final visible identity is not verified')
            if row['role'] in {'product_print', 'product_brand'}:
                require(row.get('text') == 'PackJoyU', 'Final product brand text differs')
            expected = 'replaced_no_residual' if row['role'] in {'product_print', 'product_brand'} else 'no_signature'
            require(row.get('replacementStatus') == expected, 'Final replacement/signature review is incomplete')
    require(any(row['role'] == 'opening' and row['fromMs'] == 0 for row in observations),
            'Selected opening coverage incomplete')
    require(any(row['role'] == 'watermark' and row['fromMs'] == 0 and row['toMs'] == output['movieDurationMs']
                for row in observations), 'Selected watermark coverage incomplete')
    require(any(row['role'] == 'ending' and row['toMs'] >= (output['frameCount'] - 1) / output['fps'] * 1000
                for row in observations), 'Selected ending coverage incomplete')


def verify_video(records, manifest, identity, by_role, replacement):
    review = identity.get('selectedFinalReview')
    require(isinstance(review, dict), 'Selected final video review is missing')
    require(review.get('source') == {'path': identity['originalPath'], 'sha256': identity['originalSha256']}, 'Selected original binding differs')
    source_file = Path(review['source']['path'])
    require(source_file.is_file(), 'Original source video is missing')
    require(hashlib.sha256(source_file.read_bytes()).hexdigest() == review['source']['sha256'], 'Original source video hash differs')
    require(review.get('sourceIdentity') == 'OWN_VERIFIED', 'Selected video source identity is not verified')
    require(review.get('finalCorporateIdentity') == 'OWN_VERIFIED', 'Final corporate identity is not verified')
    require(all(review['finalLogoMaster'][key] == manifest['logoMaster'][key] for key in ['path', 'sha256']), 'Final logo master differs')
    records.file(review['finalLogoMaster'])
    attestation_row = review.get('attestation')
    require(isinstance(attestation_row, dict), 'Selected source attestation is missing')
    require(attestation_row['path'] == 'docs/brand-media/static/source-attestation.json', 'Selected source attestation path differs')
    attestation = read_json(records.file(attestation_row))
    require(attestation.get('basisKind') == 'direct_user_statement' and bool(attestation.get('statement', '').strip()), 'Source attestation statement is missing')
    require(attestation.get('source') == review['source'], 'Source attestation is for another original')
    basis = records.basis(review.get('basis', []))
    require(attestation_row['path'] in basis and 'docs/brand-media/static/video-product-replacement.json' in basis,
            'Selected source/production basis is missing')
    require(replacement.get('revision') == 'v3' and replacement['source'] == review['source'], 'Selected revision/source differs')
    require(all(replacement['master'][key] == manifest['logoMaster'][key] for key in ['path', 'sha256']),
            'Selected production master differs')
    for row in replacement['codeAndData']:
        records.file(row)
    outputs = review.get('outputs', [])
    require(len(outputs) == 2, 'Selected final video outputs are incomplete')
    for role in VIDEO_ROLES:
        selected = by_role[role]
        output = next((row for row in outputs if row['path'] == selected['path']), None)
        require(output is not None, 'Selected video review refers to another output')
        for key in ['sha256', 'width', 'height', 'fps', 'frameCount']:
            require(output[key] == selected[key], f'Selected video review {key} differs')
        require(any(all(selected['source'][key] == row[key] for key in ['path', 'sha256']) for row in replacement['outputs']),
                'Unselected historical video cannot be released')
        records.file(output, registered=True)
        expected_size = (1920, 1080) if role == 'video_1080p' else (1280, 720)
        require((output['width'], output['height']) == expected_size, 'Selected video role dimensions differ')
        require(output['frameCount'] == identity['frameCount'] and output['fps'] == identity['fps'], 'Selected movie timeline differs')
        verify_observations(records, output)
    poster = review['poster']
    require(all(poster[key] == by_role['video_poster'][key] for key in ['path', 'sha256', 'width', 'height']), 'Selected poster differs')
    require(all(by_role['video_poster']['source'][key] == replacement['poster'][key] for key in ['path', 'sha256']), 'Unselected historical poster cannot be released')
    full = next(row for row in outputs if row['path'] == by_role['video_1080p']['path'])
    require((poster['sourceVideoPath'], poster['sourceVideoSha256']) == (full['path'], full['sha256']), 'Poster movie binding differs')
    records.frame(poster, full)


def verify_production(production, by_role, records):
    operations = {row['id']: row for row in production['operations']}
    require(len(operations) == len(production['operations']), 'Duplicate production operation id')
    required = production.get('requiredOperationIds', [])
    require(required and len(set(required)) == len(required), 'Selected production operations are missing or duplicated')
    outputs = set()
    for key in required:
        operation = operations.get(key)
        require(operation is not None and not operation.get('historical', False), 'Selected production operation is missing or historical')
        require(operation['status'] in VERIFIED_PRODUCTION and bool(operation.get('tool')), 'Selected production is not verified')
        outputs.update(operation.get('outputs', []))
        for field in ['recordPath', 'reviewPath']:
            if operation.get(field):
                records.path(operation[field])
    require(all(row['path'] in outputs or row['source']['path'] in outputs for row in by_role.values()),
            'Selected deliverable lacks an actual production operation')


def verify_selected_release(manifest, identity, production, root):
    records = Records(root, manifest)
    selection = read_json(records.path(manifest['selectionRecordPath']))
    by_role = verify_deliverables(records, manifest, selection)
    accepted = read_json(records.path('docs/brand-media/static/accepted-industrial-assets.json'))
    replacement = read_json(records.path('docs/brand-media/static/video-product-replacement.json'))
    verify_static(records, manifest, selection, by_role, accepted)
    verify_video(records, manifest, identity, by_role, replacement)
    verify_production(production, by_role, records)
    return sorted(row['path'] for row in by_role.values())
