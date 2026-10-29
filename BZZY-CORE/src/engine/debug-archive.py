"""Package only the already sanitized private diagnostic stage; never execute it."""
import json
import os
import stat
import sys
import time
import zipfile

spec = json.load(sys.stdin)
source, destination = spec['source'], spec['destination']
created = None
packaged_files, copied, last_progress = 0, 0, 0.0

def progress(force=False):
    global last_progress
    clock = time.monotonic()
    if force or clock - last_progress >= 0.25:
        print(json.dumps({'type': 'progress', 'files': packaged_files, 'bytes': copied}), flush=True)
        last_progress = clock

try:
    with open(destination, 'xb') as output:
        created = os.fstat(output.fileno())
        os.chmod(destination, 0o600)
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for directory, directories, files in os.walk(source, followlinks=False):
                for name in directories:
                    if os.path.islink(os.path.join(directory, name)):
                        raise ValueError('Unsafe diagnostic stage directory')
                for name in sorted(files):
                    path = os.path.join(directory, name)
                    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(descriptor, 'rb') as stream:
                        info = os.fstat(stream.fileno())
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                            raise ValueError('Unsafe diagnostic stage file')
                        entry = zipfile.ZipInfo(os.path.relpath(path, source).replace(os.sep, '/'))
                        entry.compress_type = zipfile.ZIP_DEFLATED
                        entry.create_system = 3
                        entry.external_attr = (stat.S_IFREG | 0o600) << 16
                        with archive.open(entry, 'w', force_zip64=True) as target:
                            while True:
                                data = stream.read(1024 * 1024)
                                if not data:
                                    break
                                target.write(data)
                                copied += len(data)
                                progress()
                        packaged_files += 1
                        progress()
        output.flush()
        os.fsync(output.fileno())
    progress(True)
    print(json.dumps({'type': 'complete', 'bytes': os.path.getsize(destination)}), flush=True)
except BaseException:
    if created is not None:
        try:
            current = os.lstat(destination)
            if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                os.unlink(destination)
        except FileNotFoundError:
            pass
    raise
