"""Read-only checks for recorded media; --require-release also rejects incomplete work."""

import argparse
import hashlib
import json
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'docs/brand-media/static'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(name):
    return json.loads((BASE / name).read_text(encoding='utf-8'))


def local_path(value):
    target = (ROOT / value).resolve()
    require(target.is_relative_to(ROOT), f'Not a repository evidence path: {value}')
    require(target.is_file(), f'Missing evidence: {value}')
    return target


def check_hash(row):
    target = local_path(row['path'])
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    require(digest == row['sha256'], f'Hash mismatch: {row["path"]}')
    return target


def release_blockers(manifest, identity, production):
    blockers = list(manifest['missingDeliverables'])
    if manifest['taskStatus'] != 'complete':
        blockers.append('TASK_INCOMPLETE')
    if not manifest['releaseFiles']:
        blockers.append('EMPTY_RELEASE_SET')
    if any(row['status'] != 'complete' or not row['oldLogoAbsentVerified'] or not row['afterPath']
           for row in manifest['jpgReplacements']):
        blockers.append('JPG_REPLACEMENT_NOT_VERIFIED')
    if identity['corporateAuthorship']['identity'] != 'OWN_VERIFIED':
        blockers.append('VIDEO_CORPORATE_IDENTITY_NOT_VERIFIED')
    if any(row['role'] != 'equipment' and
           (row['identity'] != 'OWN_VERIFIED' or row.get('relationshipToPackJoyU') == 'UNKNOWN')
           for row in identity['observations']):
        blockers.append('NON_EQUIPMENT_IDENTITY_NOT_VERIFIED')
    if production['taskStatus'] != 'complete' or any(
            row['status'] == 'not_executed' for row in production['operations']):
        blockers.append('PRODUCTION_NOT_COMPLETE')
    if any(not data['releaseAllowed'] for data in [manifest, identity, production]):
        blockers.append('RELEASE_HELD')
    return sorted(set(blockers))


def verify(originals_root=None):
    manifest, identity, production = map(read, [
        'brand-static-media.json', 'video-identity.json', 'production-record.json'])
    require(manifest['task'] == production['task'] == 'M1-T3', 'Wrong task')
    video_source = next((row for row in manifest['originals']
                         if row['path'] == identity['originalPath']), None)
    require(video_source is not None, 'Identity source video is not registered')
    require(identity['originalSha256'] == video_source['sha256'], 'Identity source hash differs')
    audit = read('logo-source-audit.json')
    for key in ['path', 'sha256', 'viewBox']:
        require(manifest['logoMaster'][key] == audit['export'][key], f'Master {key} differs')
    require(manifest['logoMaster']['sourceFiles'] == audit['sourceFiles'], 'Master source list differs')
    require(manifest['logoMaster']['font'] == audit['font'], 'Master font source differs')
    require(manifest['logoMaster']['styleSources'] == audit['styleSources'], 'Master style sources differ')
    for row in audit['sourceFiles'] + [audit['export']]:
        check_hash(row)
    svg = ET.parse(local_path(audit['export']['path'])).getroot()
    require(svg.attrib['viewBox'] == audit['export']['viewBox'], 'SVG viewBox differs')
    require(len(list(svg)) == 8, 'SVG must contain eight outlined letters')
    for node in svg.iter():
        require(node.tag.rsplit('}', 1)[-1] in {'svg', 'path'}, 'Unexpected SVG element')
        allowed = {'viewBox', 'width', 'height'} if node is svg else {'d', 'fill'}
        require(set(node.attrib) <= allowed, 'Unexpected SVG attributes or external reference')
    image_paths = set()
    file_by_path = {row['path']: row for row in manifest['files']}
    require(len(file_by_path) == len(manifest['files']), 'Duplicate media path')

    def check_registered_record(row):
        check_hash(row)
        canonical = file_by_path.get(row['path'])
        require(canonical is not None, 'Media record is not registered')
        for key in ['sha256', 'width', 'height', 'frameCount', 'fps']:
            if key in row:
                require(row[key] == canonical.get(key), f'Registered media {key} differs')

    for row in manifest['files']:
        target = check_hash(row)
        image_paths.add(row['path'])
        if target.suffix == '.svg':
            code = "import sharp from 'sharp'; const {info}=await sharp(process.argv[1]).raw().toBuffer({resolveWithObject:true}); console.log(JSON.stringify(info));"
            result = subprocess.run(['node', '--input-type=module', '-e', code, str(target)],
                                    cwd=ROOT, capture_output=True, text=True, check=True)
            info = json.loads(result.stdout)
            size = (info['width'], info['height'])
        elif target.suffix.lower() == '.mp4':
            import cv2
            decoded = cv2.VideoCapture(str(target))
            try:
                require(decoded.isOpened(), f'Cannot decode video: {row["path"]}')
                size = (int(decoded.get(cv2.CAP_PROP_FRAME_WIDTH)),
                        int(decoded.get(cv2.CAP_PROP_FRAME_HEIGHT)))
                decoded_count = 0
                while True:
                    ok, _ = decoded.read()
                    if not ok:
                        break
                    decoded_count += 1
                require(decoded_count > 0, f'Video has no decoded frames: {row["path"]}')
                if 'frameCount' in row:
                    require(decoded_count == row['frameCount'], f'Video frame count differs: {row["path"]}')
                if 'fps' in row:
                    require(decoded.get(cv2.CAP_PROP_FPS) == row['fps'], f'Video fps differs: {row["path"]}')
            finally:
                decoded.release()
        else:
            with Image.open(target) as decoded:
                decoded.load()
                size = decoded.size
        require(size == (row['width'], row['height']), f'Decoded dimensions differ: {row["path"]}')
    actual_images = {p.relative_to(ROOT).as_posix() for p in (BASE / 'evidence').iterdir()
                     if p.suffix.lower() in {'.png', '.jpg'}}
    actual_images.add('public/brand/packjoyu-logo-master.svg')
    for held_path in manifest.get('heldFiles', []):
        require(held_path.startswith('docs/brand-media/static/held/'), 'Held media must stay outside public assets')
        local_path(held_path)
        require(held_path in image_paths, f'Held file missing from hash/dimension manifest: {held_path}')
        require(held_path not in manifest['releaseFiles'], 'Held media entered release set')
        require(file_by_path[held_path]['releaseAllowed'] is False, 'Held file was marked releasable')
        actual_images.add(held_path)
    for release_path in manifest['releaseFiles']:
        local_path(release_path)
        require(release_path in image_paths, f'Release file missing from hash/dimension manifest: {release_path}')
        actual_images.add(release_path)
    for replacement in manifest['jpgReplacements']:
        if replacement['afterPath']:
            local_path(replacement['afterPath'])
            require(replacement['afterPath'] in manifest['releaseFiles'], 'JPG output missing from release set')
        if replacement.get('candidatePath'):
            require(replacement['candidatePath'] in manifest.get('heldFiles', []), 'JPG candidate is not held')
    require(actual_images == image_paths, 'Manifest omits an image or lists an extra image')
    if manifest.get('generationRecordPath'):
        generation = json.loads(local_path(manifest['generationRecordPath']).read_text(encoding='utf-8'))
        check_hash(generation['master'])
        require(all(generation['master'][key] == manifest['logoMaster'][key] for key in ['path', 'sha256']),
                'Image edit master differs from verified master')
        for call in generation['calls']:
            require(call['tool'] == 'image_gen.imagegen' and call['result'] == 'succeeded',
                    'Image editing record does not describe an actual successful tool call')
            check_hash(call['prompt'])
            check_registered_record(call['output'])
            require(call['output']['path'] in image_paths, 'Generated output missing from file manifest')
            for source in call['inputs']:
                if source['role'] == 'edit_target':
                    require(any(source['path'] == row['path'] and source['sha256'] == row['sha256']
                                for row in manifest['originals']), 'Image edit source differs from original')
                else:
                    check_hash(source)
        check_registered_record(generation['selectedOutput'])
        require(generation['selectedOutput'] in [call['output'] for call in generation['calls']],
                'Selected image is not an actual tool output')
        check_registered_record(generation['jpegExport'])
        require(generation['jpegExport']['sourcePngPath'] == generation['selectedOutput']['path'],
                'JPEG source differs from selected tool output')
        require(generation['jpegExport']['path'] in manifest.get('heldFiles', []), 'Unaccepted JPG is not held')
    frames = read('evidence/video-frames.json')
    frame_by_path = {frame['path']: frame for frame in frames}
    require(len(frame_by_path) == len(frames), 'Duplicate frame evidence path')

    def check_frame(frame):
        check_hash(frame)
        canonical = frame_by_path.get(frame['path'])
        require(canonical is not None, 'Identity frame is not registered')
        for key in ['sha256', 'frameIndex', 'atMs', 'width', 'height']:
            require(frame[key] == canonical[key], f'Identity frame {key} differs from source-frame record')

    for row in frames:
        check_hash(row)
        require(row['path'] in image_paths, 'Frame missing from file manifest')
        require(abs(row['atMs'] - row['frameIndex'] / identity['fps'] * 1000) < 0.001,
                'Frame timestamp differs from source PTS')
    for row in identity['observations'] + [identity['corporateAuthorship']]:
        require(0 <= row['fromMs'] < row['toMs'] <= identity['movieDurationMs'], 'Identity time out of range')
        require(row['identity'] in {'OWN_VERIFIED', 'THIRD_PARTY', 'UNKNOWN'}, 'Invalid identity')
        for basis in row['basisPaths']:
            local_path(basis)
        for frame in row['evidence']:
            check_frame(frame)
            require(row['fromMs'] <= frame['atMs'] < row['toMs'], 'Evidence frame outside identity range')
    check_frame(identity['posterCandidate'])
    require(identity['posterCandidate']['releaseAllowed'] is False or identity['releaseAllowed'],
            'Held source video has a released poster candidate')
    if 'heldDerivatives' in identity:
        for derivative in identity['heldDerivatives']:
            check_registered_record(derivative)
            require(derivative['path'] in manifest.get('heldFiles', []), 'Unreleased derivative missing from held set')
            require(derivative['releaseAllowed'] is False, 'Held video derivative was marked released')
            require(derivative['sourceSha256'] == identity['originalSha256'], 'Derivative source video hash differs')
            if derivative['kind'] == 'poster':
                frame = frame_by_path[derivative['sourceFramePath']]
                require(derivative['sha256'] == frame['sha256'], 'Poster differs from its original frame export')
                require(derivative['frameIndex'] == frame['frameIndex']
                        and derivative['atMs'] == frame['atMs'], 'Poster time differs from original frame')
    coverage = read('evidence/all-frame-coverage.json')
    next_frame = 0
    for sheet in coverage['sheets']:
        check_hash(sheet)
        require(sheet['fromFrame'] == next_frame, 'Gap or overlap in full-frame contact sheets')
        next_frame = sheet['toFrame'] + 1
    require(next_frame == identity['frameCount'] == coverage['decodedFrames'], 'Frame coverage differs')
    timing = read('evidence/video-timing.json')
    require(identity['movieDurationMs'] == timing['movie']['durationMs'], 'Movie duration differs')
    for row in manifest['originals']:
        require(row['sha256Before'] == row['sha256After'] == row['sha256'], 'Original hash changed')
        if originals_root:
            original = originals_root / Path(row['path']).name
            require(hashlib.sha256(original.read_bytes()).hexdigest() == row['sha256'], 'Live original hash differs')
    if originals_root:
        import cv2
        video_path = originals_root / Path(identity['originalPath']).name
        video = cv2.VideoCapture(str(video_path))
        require(video.isOpened(), 'Original video cannot be decoded')
        targets = {frame['frameIndex']: frame for frame in frames}
        count = 0
        try:
            require(video.get(cv2.CAP_PROP_FPS) == identity['fps'], 'Source frame rate differs')
            while True:
                ok, pixels = video.read()
                if not ok:
                    break
                if count in targets:
                    encoded, jpeg = cv2.imencode('.jpg', pixels, [cv2.IMWRITE_JPEG_QUALITY, 92])
                    require(encoded, 'Source frame encoding failed')
                    require(hashlib.sha256(jpeg.tobytes()).hexdigest() == targets[count]['sha256'],
                            f'Evidence does not reproduce original frame {count}')
                count += 1
        finally:
            video.release()
        require(count == identity['frameCount'], 'Source full decode count differs')
    blockers = release_blockers(manifest, identity, production)
    if blockers:
        require(all(data['releaseAllowed'] is False for data in [manifest, identity, production]),
                'Incomplete or unverified work was marked releasable')
        require(manifest['releaseFiles'] == [], 'Held media entered release set')
    return {'integrity': 'pass', 'mediaFilesChecked': len(image_paths),
            'imageFilesChecked': sum(not path.endswith('.mp4') for path in image_paths),
            'originalsReRead': bool(originals_root), 'releaseAllowed': not blockers,
            'taskStatus': manifest['taskStatus'], 'releaseBlockers': blockers}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--originals-root', type=Path)
    parser.add_argument('--require-release', action='store_true')
    args = parser.parse_args()
    result = verify(args.originals_root)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(2 if args.require_release and not result['releaseAllowed'] else 0)
