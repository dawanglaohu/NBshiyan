"""Select the one completed T10 run by log markers and confined directory identity."""

from pathlib import Path
import re
import sys

RUN_NAME = re.compile(r'run-\d{8}T\d{6}Z-w\d+-r0-[0-9a-f]{6}')


def select(log_path, evidence_root):
    root = evidence_root.resolve(strict=True)
    lines = log_path.read_text(encoding='utf-8', errors='replace').splitlines()
    markers = []
    for prefix in ('T10_STATE_RUN_DIR=', 'T10_STATE_RUN_CLOSED='):
        values = [line[len(prefix):] for line in lines if line.startswith(prefix)]
        if len(values) != 1:
            raise ValueError('marker count')
        markers.append(values[0])
    if markers[0] != markers[1]:
        raise ValueError('marker mismatch')
    candidate = Path(markers[0])
    if not candidate.is_absolute() or candidate.parent != root or not RUN_NAME.fullmatch(candidate.name):
        raise ValueError('invalid run path')
    directories = [path for path in root.iterdir() if path.name.startswith('run-')]
    if directories != [candidate] or candidate.is_symlink() or not candidate.is_dir():
        raise ValueError('unexpected run directories')
    return candidate


if __name__ == '__main__':
    try:
        print(select(Path(sys.argv[1]), Path(sys.argv[2])))
    except (IndexError, OSError, ValueError):
        sys.exit('T10_RUN_MARKER_REJECTED')
