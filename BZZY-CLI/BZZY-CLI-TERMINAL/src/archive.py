"""Streaming ZIP transport for bzzy project bundles (Python standard library)."""
import json
import os
import shutil
import stat
import sys
import zipfile
from pathlib import PurePosixPath


def create(spec):
    destination, temporary = spec['destination'], spec['temporary']
    excluded = {os.path.abspath(item) for item in spec.get('exclude', [])}
    names = set()
    count = 0

    def add(archive, source, name):
        nonlocal count
        if os.path.abspath(source) in excluded:
            return
        info = os.lstat(source)
        if name in names:
            return
        names.add(name)
        if stat.S_ISLNK(info.st_mode):
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(entry, os.readlink(source).encode('utf-8'))
        elif stat.S_ISDIR(info.st_mode):
            archive.write(source, name.rstrip('/') + '/')
            for child in sorted(os.scandir(source), key=lambda item: item.name):
                add(archive, child.path, name.rstrip('/') + '/' + child.name)
        elif stat.S_ISREG(info.st_mode):
            archive.write(source, name)
        else:
            raise ValueError('Cannot export special filesystem entry: ' + source)
        count += 1

    try:
        with open(temporary, 'xb') as stream:
            os.chmod(temporary, 0o600)
            with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True, strict_timestamps=False) as archive:
                archive.writestr('bundle.json', json.dumps(spec['manifest'], ensure_ascii=False))
                for entry in spec['entries']:
                    add(archive, entry['source'], entry['archive'])
            stream.flush()
            os.fsync(stream.fileno())
        # Never replace an existing export, even if another process creates it meanwhile.
        os.link(temporary, destination)
        print(json.dumps({'entries': count, 'bytes': os.path.getsize(destination)}))
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def extract(spec):
    root = spec['directory']
    with zipfile.ZipFile(spec['archive']) as archive:
        entries, names, links = [], set(), set()
        for item in archive.infolist():
            name = item.filename.rstrip('/')
            parts = PurePosixPath(name).parts
            if (not name or '\\' in name or '\x00' in name or name.startswith('/')
                    or any(part in ('', '.', '..') or ':' in part for part in name.split('/'))
                    or parts[0] not in ('workspace', 'private', 'native', 'bundle.json')
                    or (parts[0] == 'bundle.json' and name != 'bundle.json')
                    or name in names):
                raise ValueError('Invalid or duplicate bundle entry: ' + item.filename)
            names.add(name)
            mode = item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                raise ValueError('Unsupported bundle entry: ' + name)
            if stat.S_ISLNK(mode):
                links.add(name)
            entries.append((item, name, mode))
        for _item, name, _mode in entries:
            if any('/'.join(name.split('/')[:index]) in links for index in range(1, len(name.split('/')))):
                raise ValueError('Bundle entry traverses a symbolic link: ' + name)
        if 'bundle.json' not in names or 'bundle.json' in links:
            raise ValueError('Not a bzzy project bundle: missing bundle.json')
        if sum(item.file_size for item, _name, _mode in entries) > shutil.disk_usage(root).free:
            raise ValueError('Not enough free disk space for this bundle')
        directories = []
        for item, name, mode in entries:
            target = os.path.join(root, *name.split('/'))
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            if item.is_dir():
                os.makedirs(target, mode=0o700, exist_ok=True)
                directories.append((target, mode))
            elif stat.S_ISLNK(mode):
                os.symlink(archive.read(item).decode('utf-8'), target)
            else:
                with archive.open(item) as source, open(target, 'xb') as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                os.chmod(target, mode & 0o777 if stat.S_IFMT(mode) else 0o600)
        for target, mode in reversed(directories):
            os.chmod(target, mode & 0o777 if stat.S_IFMT(mode) else 0o700)
    print(json.dumps({'entries': len(entries)}))


try:
    specification = json.load(sys.stdin)
    if sys.argv[1] == 'create':
        create(specification)
    elif sys.argv[1] == 'extract':
        extract(specification)
    else:
        raise ValueError('Unknown archive operation')
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
