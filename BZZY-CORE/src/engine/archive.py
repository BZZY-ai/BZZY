"""Streaming ZIP transport for bzzy project bundles (Python standard library)."""
import json
import os
import shutil
import stat
import sys
import zipfile
import hashlib
import re
from pathlib import PurePosixPath

PRIVATE_NAMES = {'.env', '.ssh', '.aws', '.azure', '.gnupg', '.codex', '.claude', '.git',
                 'auth.json', 'credentials.json', 'credentials', 'cookies', 'cookies.sqlite',
                 'login data', 'keychain', 'keychains', 'host.identity.json', 'listener.json',
                 '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials', '.boto', '.claude.json',
                 'credentials.db', 'cookies.txt', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.kube'}
PRIVATE_NAMES.update({'.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile',
                      '.bash_login', '.bash_logout', '.profile', '.gitconfig', '.envrc'})
SECRET = re.compile(rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-[a-zA-Z0-9_-]{16,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})')


def private_name(name):
    parts = name.lower().split('/')
    return (any(part in PRIVATE_NAMES or part.startswith(('.env.', '._'))
                or part.endswith(('.pem', '.key', '.p12', '.pfx', '.keychain', '.keychain-db')) for part in parts)
            or any(part == '.config' and parts[index + 1] in ('gcloud', 'gh')
                   or part == '.docker' and parts[index + 1] == 'config.json'
                   for index, part in enumerate(parts[:-1])))


def safe_link(name, target):
    if not target or '\\' in target or '\x00' in target or target.startswith('/') or ':' in target:
        raise ValueError('Shared project contains an unsafe symbolic link')
    resolved = os.path.normpath(os.path.join(os.path.dirname(name), target)).replace(os.sep, '/')
    if resolved.startswith('../') or resolved.split('/')[0] != name.split('/')[0] or private_name(resolved):
        raise ValueError('Shared project contains an escaping symbolic link')


def create(spec):
    destination, temporary = spec['destination'], spec['temporary']
    excluded = {os.path.abspath(item) for item in spec.get('exclude', [])}
    names = set()
    count = 0
    portable = spec.get('portable', False)
    limits = spec.get('limits', {})
    total = 0
    excluded_names, inventory = [], {}
    secrets = [value.encode('utf-8') for value in spec.get('secrets', [])]

    def add(archive, source, name, parent_fd=None, child_name=None):
        nonlocal count, total
        if os.path.abspath(source) in excluded:
            return
        if portable and (private_name(name) or name.endswith('/.DS_Store')):
            excluded_names.append(name)
            if len(excluded_names) > limits['entries']:
                raise ValueError('Shared project has too many excluded entries')
            return
        info = (os.stat(child_name, dir_fd=parent_fd, follow_symlinks=False)
                if parent_fd is not None else os.lstat(source))
        if name in names:
            return
        names.add(name)
        if portable and (count >= limits['entries'] or info.st_size > limits['fileBytes'] and stat.S_ISREG(info.st_mode)):
            raise ValueError('Shared project exceeds the bounded file count or file size')
        if stat.S_ISLNK(info.st_mode):
            link = (os.readlink(child_name, dir_fd=parent_fd) if parent_fd is not None else os.readlink(source))
            if portable:
                safe_link(name, link)
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            data = link.encode('utf-8')
            archive.writestr(entry, data)
            if portable:
                inventory[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        elif stat.S_ISDIR(info.st_mode):
            if portable:
                flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
                descriptor = os.open(child_name if parent_fd is not None else source, flags, dir_fd=parent_fd)
                try:
                    pinned = os.fstat(descriptor)
                    if (pinned.st_dev, pinned.st_ino) != (info.st_dev, info.st_ino):
                        raise ValueError('Shared project directory changed while packaging')
                    entry = zipfile.ZipInfo(name.rstrip('/') + '/')
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFDIR | 0o700) << 16
                    archive.writestr(entry, b'')
                    # Resolve each child relative to the still-open directory.
                    # Renaming/replacing an ancestor cannot redirect enumeration
                    # into private host directories after the scope check.
                    with os.scandir(descriptor) as children:
                        child_names = sorted(child.name for child in children)
                    for child in child_names:
                        add(archive, os.path.join(source, child), name.rstrip('/') + '/' + child, descriptor, child)
                finally:
                    os.close(descriptor)
            else:
                archive.write(source, name.rstrip('/') + '/')
                for child in sorted(os.scandir(source), key=lambda item: item.name):
                    add(archive, child.path, name.rstrip('/') + '/' + child.name)
        elif stat.S_ISREG(info.st_mode):
            if portable:
                if info.st_nlink != 1:
                    raise ValueError('Shared project contains a hard-linked file')
                flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                descriptor = os.open(child_name if parent_fd is not None else source, flags, dir_fd=parent_fd)
                with os.fdopen(descriptor, 'rb') as stream:
                    before = os.fstat(stream.fileno())
                    if not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino):
                        raise ValueError('Shared project changed while being packaged')
                    data = stream.read(limits['fileBytes'] + 1)
                    after = os.fstat(stream.fileno())
                    if len(data) > limits['fileBytes'] or len(data) != before.st_size or (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
                        raise ValueError('Shared project changed or exceeds its file bound')
                total += len(data)
                if total > limits['bytes']:
                    raise ValueError('Shared project exceeds its uncompressed size bound')
                if SECRET.search(data) or any(secret in data for secret in secrets):
                    raise ValueError('Sharing blocked: a selected file contains a credential')
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | (0o700 if info.st_mode & 0o111 else 0o600)) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, data)
                inventory[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
            else:
                archive.write(source, name)
        else:
            raise ValueError('Cannot export special filesystem entry: ' + source)
        count += 1

    try:
        with open(temporary, 'xb') as stream:
            os.chmod(temporary, 0o600)
            with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True, strict_timestamps=False) as archive:
                if not portable:
                    archive.writestr('bundle.json', json.dumps(spec['manifest'], ensure_ascii=False))
                for entry in spec['entries']:
                    add(archive, entry['source'], entry['archive'])
                if portable:
                    manifest = spec['manifest']
                    manifest['sharing']['excluded'] = excluded_names
                    manifest['sharing']['inventory'] = inventory
                    data = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
                    if len(data) > limits['fileBytes'] or total + len(data) > limits['bytes']:
                        raise ValueError('Shared project manifest exceeds its size bound')
                    archive.writestr('bundle.json', data)
            stream.flush()
            os.fsync(stream.fileno())
        # Never replace an existing export, even if another process creates it meanwhile.
        os.link(temporary, destination)
        print(json.dumps({'entries': count, 'bytes': os.path.getsize(destination), **({'excluded': excluded_names} if portable else {})}))
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def extract(spec):
    root = spec['directory']
    portable = spec.get('portable', False)
    limits = spec.get('limits', {})
    with zipfile.ZipFile(spec['archive']) as archive:
        if portable and (len(archive.infolist()) > limits['entries'] + 1
                         or sum(item.file_size for item in archive.infolist()) > limits['bytes']):
            raise ValueError('Shared archive exceeds its entry or uncompressed size bound')
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
            if portable and (private_name(name) or item.file_size > limits['fileBytes']):
                raise ValueError('Shared archive contains a private authentication path or oversized file')
            mode = item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                raise ValueError('Unsupported bundle entry: ' + name)
            if stat.S_ISLNK(mode):
                links.add(name)
            entries.append((item, name, mode))
        inventory = None
        if portable:
            manifest = json.loads(archive.read('bundle.json'))
            inventory = manifest.get('sharing', {}).get('inventory')
            if not isinstance(inventory, dict):
                raise ValueError('Shared archive has no integrity inventory')
            expected = {name for item, name, _mode in entries if not item.is_dir() and name != 'bundle.json'}
            if set(inventory) != expected:
                raise ValueError('Shared archive integrity inventory does not match its files')
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
                data = archive.read(item)
                if portable:
                    safe_link(name, data.decode('utf-8'))
                    if inventory[name] != {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}:
                        raise ValueError('Shared archive link failed its integrity check')
                os.symlink(data.decode('utf-8'), target)
            else:
                digest = hashlib.sha256()
                with archive.open(item) as source, open(target, 'xb') as output:
                    while True:
                        data = source.read(1024 * 1024)
                        if not data:
                            break
                        digest.update(data)
                        if portable and SECRET.search(data):
                            raise ValueError('Shared archive contains an embedded credential')
                        output.write(data)
                if portable and name != 'bundle.json' and inventory[name] != {'sha256': digest.hexdigest(), 'bytes': item.file_size}:
                    raise ValueError('Shared archive file failed its integrity check')
                os.chmod(target, (0o700 if mode & 0o111 else 0o600) if portable else mode & 0o777 if stat.S_IFMT(mode) else 0o600)
        for target, mode in reversed(directories):
            os.chmod(target, 0o700 if portable else mode & 0o777 if stat.S_IFMT(mode) else 0o700)
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
