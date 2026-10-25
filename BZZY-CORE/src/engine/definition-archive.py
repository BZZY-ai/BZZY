"""Bounded ZIP transport for reviewed reusable definitions. Never execute content."""
import hashlib
import ctypes
import errno
import json
import os
from pathlib import Path
import stat
import sys
import uuid
import unicodedata
import zipfile

MAX_BYTES = 64 * 1024 * 1024
MAX_FILE = 1024 * 1024
MAX_ENTRIES = 4096


def path_key(value):
    return unicodedata.normalize('NFC', value).casefold()


def publish_exclusive_copy(directory, source, destination):
    """Fallback for a filesystem lacking exclusive rename; never replace data."""
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    with os.fdopen(source_fd, 'rb') as original:
        source_info = os.fstat(original.fileno())
        if not stat.S_ISREG(source_info.st_mode) or source_info.st_nlink != 1 or source_info.st_size > MAX_BYTES:
            raise ValueError('Unsafe staged archive')
        output_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        opened = os.fstat(output_fd)
        try:
            with os.fdopen(output_fd, 'wb') as output:
                data = original.read(MAX_BYTES + 1)
                if len(data) != source_info.st_size:
                    raise ValueError('Staged archive changed')
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
        except BaseException:
            # Remove only the file we just created, never an existing or
            # concurrently replaced destination. An interrupted process may
            # leave its incomplete new file; it can never overwrite one.
            try:
                current = os.stat(destination, dir_fd=directory, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == (opened.st_dev, opened.st_ino):
                    os.unlink(destination, dir_fd=directory)
            except FileNotFoundError:
                pass
            raise


def publish_exclusive(directory, source, destination):
    """Publish without replacing a name, including on filesystems without links."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        # Darwin SDK sys/stdio.h: RENAME_EXCL=0x00000004, available since 10.12.
        rename = libc.renameatx_np
        flag = 0x00000004
    elif sys.platform.startswith('linux'):
        # Linux renameat2(2), RENAME_NOREPLACE. Supported host targets use glibc.
        rename = getattr(libc, 'renameat2', None)
        if rename is None:
            return publish_exclusive_copy(directory, source, destination)
        flag = 1
    else:
        raise OSError(errno.ENOSYS, 'Unsupported archive publication host')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(directory, os.fsencode(source), directory, os.fsencode(destination), flag) != 0:
        code = ctypes.get_errno()
        if code in {errno.ENOSYS, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EINVAL}:
            return publish_exclusive_copy(directory, source, destination)
        raise OSError(code, os.strerror(code))


def safe_name(name):
    return (isinstance(name, str) and 0 < len(name) <= 360 and not name.startswith('/')
            and '\\' not in name and ':' not in name
            and not any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in name)
            and all(part and part not in ('.', '..') and not part.startswith('.') for part in name.split('/')))


def regular(file, maximum):
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    stream = os.fdopen(descriptor, 'rb')
    info = os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
        stream.close()
        raise ValueError('Expected a bounded regular file without links')
    return stream


def unpack(spec):
    names, total = set(), 0
    with regular(spec['source'], MAX_BYTES) as source, zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > MAX_ENTRIES:
            raise ValueError('Archive entry limit exceeded')
        for item in entries:
            mode = item.external_attr >> 16
            total += item.file_size
            if (not safe_name(item.filename) or path_key(item.filename) in names or item.flag_bits & 1
                    or item.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG)
                    or item.file_size < 0 or item.file_size > MAX_FILE or total > MAX_BYTES
                    or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise ValueError('Unsafe archive entry or size')
            names.add(path_key(item.filename))
        target = Path(spec['target'])
        for item in entries:
            destination = target.joinpath(*item.filename.split('/'))
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with archive.open(item) as data, open(destination, 'xb') as output:
                os.chmod(destination, 0o600)
                content = data.read(MAX_FILE + 1)
                if len(content) != item.file_size:
                    raise ValueError('Invalid archive size')
                output.write(content)
    return {'files': sorted(item.filename for item in entries)}


def create(spec):
    name = spec['name']
    if not safe_name(name) or '/' in name or not name.lower().endswith('.zip'):
        raise ValueError('Unsafe output name')
    descriptor = os.open(spec['cwd'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = '.bzzy-definitions-' + str(uuid.uuid4()) + '.tmp'
    try:
        info = os.fstat(descriptor)
        if str(info.st_dev) + ':' + str(info.st_ino) != spec['fingerprint']:
            raise ValueError('Destination directory changed')
        fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        with os.fdopen(fd, 'w+b') as output:
            with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                total, names = 0, set()
                if not spec['files'] or len(spec['files']) > MAX_ENTRIES:
                    raise ValueError('Archive entry limit exceeded')
                for entry in spec['files']:
                    if not safe_name(entry['path']) or path_key(entry['path']) in names:
                        raise ValueError('Unsafe archive entry')
                    names.add(path_key(entry['path']))
                    with regular(Path(spec['source']).joinpath(*entry['path'].split('/')), MAX_FILE) as source:
                        data = source.read(MAX_FILE + 1)
                    total += len(data)
                    if total > MAX_BYTES or len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                        raise ValueError('Reviewed content changed')
                    item = zipfile.ZipInfo(entry['path'])
                    item.create_system = 3
                    item.external_attr = (stat.S_IFREG | 0o600) << 16
                    item.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(item, data)
            output.flush()
            if os.fstat(output.fileno()).st_size > MAX_BYTES:
                raise ValueError('Archive byte limit exceeded')
            os.fsync(output.fileno())
            output.seek(0)
            content = output.read(MAX_BYTES + 1)
            expected_hash = hashlib.sha256(content).hexdigest()
            expected_bytes = len(content)
            opened = os.fstat(output.fileno())
            temporary_info = os.stat(temporary, dir_fd=descriptor, follow_symlinks=False)
            if not stat.S_ISREG(temporary_info.st_mode) or (opened.st_dev, opened.st_ino) != (temporary_info.st_dev, temporary_info.st_ino):
                raise ValueError('Temporary archive identity changed')
        current = os.stat(spec['cwd'], follow_symlinks=False)
        if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('Destination directory changed')
        # Atomic exclusive rename also works on ExFAT, which has no hard links.
        publish_exclusive(descriptor, temporary, name)
        published_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        with os.fdopen(published_fd, 'rb') as published:
            published_info = os.fstat(published.fileno())
            data = published.read(MAX_BYTES + 1)
            if (not stat.S_ISREG(published_info.st_mode) or published_info.st_nlink != 1
                    or published_info.st_size != expected_bytes or len(data) != expected_bytes
                    or hashlib.sha256(data).hexdigest() != expected_hash):
                raise ValueError('Published archive changed')
        try:
            os.fsync(descriptor)
        except OSError as error:
            if error.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP}:
                raise
    finally:
        try:
            os.unlink(temporary, dir_fd=descriptor)
        except FileNotFoundError:
            pass
        os.close(descriptor)
    return {'published': True, 'sha256': expected_hash, 'bytes': expected_bytes,
            'device': str(published_info.st_dev), 'inode': str(published_info.st_ino)}


try:
    spec = json.load(sys.stdin)
    operation = {'extract': unpack, 'create': create}.get(spec.get('operation'))
    if operation is None:
        raise ValueError('Unsupported operation')
    print(json.dumps(operation(spec)))
except Exception:
    # Paths, archive comments and private host errors never enter CLI output.
    print('Definition archive failed validation or changed during publication.', file=sys.stderr)
    sys.exit(1)
