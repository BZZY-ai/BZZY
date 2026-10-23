"""Bounded ZIP materialization for Core skills. Never execute imported code."""
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 512 or sum(item.file_size for item in entries) > 20 * 1024 * 1024:
        raise ValueError('Archive limits exceeded')
    seen = set()
    for item in entries:
        parts = PurePosixPath(item.filename).parts
        mode = item.external_attr >> 16
        if (not parts or item.filename.startswith('/') or '\\' in item.filename
                or any(part in ('.', '..') or ':' in part or '\0' in part for part in parts)
                or item.flag_bits & 1 or item.file_size > 1024 * 1024
                or stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)
                or item.filename.casefold().rstrip('/') in seen):
            raise ValueError('Unsafe archive entry')
        seen.add(item.filename.casefold().rstrip('/'))
    target = Path(sys.argv[2])
    for item in entries:
        destination = target.joinpath(*PurePosixPath(item.filename).parts)
        if item.is_dir():
            destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with archive.open(item) as source, open(destination, 'xb') as output:
                data = source.read(1024 * 1024 + 1)
                if len(data) != item.file_size:
                    raise ValueError('Invalid archive size')
                output.write(data)
            os.chmod(destination, 0o600)
