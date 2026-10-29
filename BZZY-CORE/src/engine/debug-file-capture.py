"""Read-only large diagnostic capture. Private scratch never enters the ZIP.

Work on a checked disk snapshot, not a live memory mapping of user files.
Redaction spans live in SQLite and file buffers are bounded. JSON is walked as
tokens; strings larger than the working buffer are decoded/redacted on disk.
"""
import codecs
import hashlib
import json
import mmap
import os
import re
import sqlite3
import stat
import sys
import time
from contextlib import contextmanager

BLOCK = 1024 * 1024
SMALL = 256 * 1024
spec = json.load(sys.stdin)
scratch = spec['scratch']
last_progress = 0.0
source_bytes = 0
inspected_bytes = 0
sequence = 0


class Omission(Exception):
    pass


def progress(force=False):
    global last_progress
    clock = time.monotonic()
    if force or clock - last_progress >= 0.25:
        print(json.dumps({'type': 'progress', 'inspectedBytes': inspected_bytes}), flush=True)
        last_progress = clock


def private_file(name):
    return os.fdopen(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb')


def temporary():
    global sequence
    sequence += 1
    return os.path.join(scratch, 'part-' + str(sequence))


@contextmanager
def mapped(name):
    with open(name, 'rb') as stream:
        size = os.fstat(stream.fileno()).st_size
        if size:
            with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
                yield data
        else:
            yield b''


def copy_range(data, start, end, target):
    global inspected_bytes
    while start < end:
        stop = min(start + BLOCK, end)
        target.write(data[start:stop])
        inspected_bytes += stop - start
        start = stop
        progress()


def checked_snapshot():
    global source_bytes, inspected_bytes
    source_path, root = spec['source'], spec['sourceRoot']
    def inside():
        return os.path.commonpath([os.path.realpath(root), os.path.realpath(source_path)]) == os.path.realpath(root)
    try:
        root = os.path.abspath(root)
        source_path = os.path.abspath(source_path)
        if os.path.commonpath([root, source_path]) != root or not inside():
            raise Omission('outside_capture_root')
        # Open each directory relative to its pinned descriptor. Replacing a
        # parent with a symlink cannot redirect this read into private storage.
        directory = os.open(os.path.sep, os.O_RDONLY | os.O_DIRECTORY)
        try:
            components = source_path.strip(os.path.sep).split(os.path.sep)
            for component in components[:-1]:
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
            fd = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        finally:
            os.close(directory)
    except OSError:
        raise Omission('changed_or_unreadable_source')
    snapshot, digest = temporary(), hashlib.sha256()
    decoder = codecs.getincrementaldecoder('utf-8')('strict')
    text, prefix = True, b''
    with os.fdopen(fd, 'rb', buffering=0) as source_stream, private_file(snapshot) as target:
        before = os.fstat(source_stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise Omission('link_or_special_file')
        while source_bytes < before.st_size:
            try:
                data = source_stream.read(min(BLOCK, before.st_size - source_bytes))
            except OSError:
                raise Omission('changed_or_unreadable_source')
            if not data:
                raise Omission('changed_or_unreadable_source')
            if not prefix:
                prefix = data[:16]
                if prefix.startswith((b'PK\x03\x04', b'\x1f\x8b', b'SQLite format 3\0')):
                    raise Omission('opaque_archive_or_database')
            if text:
                try:
                    decoder.decode(data)
                    if b'\0' in data:
                        text = False
                except UnicodeDecodeError:
                    text = False
            digest.update(data)
            target.write(data)
            source_bytes += len(data)
            inspected_bytes += len(data)
            progress()
        if text:
            try:
                decoder.decode(b'', final=True)
            except UnicodeDecodeError:
                text = False
        try:
            after = os.fstat(source_stream.fileno())
            unchanged = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, 1) == (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink)
            unchanged = unchanged and inside()
        except OSError:
            unchanged = False
        if not unchanged:
            raise Omission('changed_or_unreadable_source')
        target.flush()
        os.fsync(target.fileno())
    return snapshot, digest.hexdigest(), text


secrets = [value.encode('utf-8', 'surrogatepass') for value in spec['secrets'] if value]
roots = [(value.encode('utf-8'), label.encode('ascii')) for value, label in spec['roots'] if value]
private_field = re.compile(spec['privateField'], re.I)
private_suffix = re.compile(spec['privateSuffix'], re.I)
reasoning_type = re.compile(r'^(?:reasoning|thinking|analysis)$', re.I)


def private_key(value):
    # JS `$` also admits a final CR, CRLF or Unicode line separator. Trimming
    # final separators is conservative and keeps the Python path from exposing
    # fields that the shared JS policy would suppress.
    normalized = value.rstrip('\r\n\u2028\u2029')
    return private_field.search(normalized) or private_suffix.search(normalized)


# JS whitespace includes these Unicode characters in addition to ASCII space.
WS = rb'(?:[\s\xa0]|\xc2\xa0|\xe1\x9a\x80|\xe2\x80[\x80-\x8a\xa8\xa9\xaf]|\xe2\x81\x9f|\xe3\x80\x80|\xef\xbb\xbf)'
assignment = re.compile(rb'\b(?:api[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|auth[_-]?tokens?|passwords?|passwd|secrets?|cookie|authorization|token|account[_-]?id|[a-z][a-z0-9_]*(?:api_key|token|secret|password|credentials))["\']?' + WS + rb'*[:=]' + WS + rb'*', re.I)
flags = re.compile(rb'--(?:api[-_]key|(?:access[-_]|auth[-_])?token|password|passwd|secret|cookie)(?:=|' + WS + rb'+)', re.I)
auth = re.compile(rb'\b(?:Bearer|Basic)' + WS + rb'+', re.I)
reasoning = re.compile(rb'<(?:think|analysis|reasoning)\b[^>]*>', re.I)
reasoning_end = re.compile(rb'</(?:think|analysis|reasoning)>', re.I)
pem = re.compile(rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----')
pem_end = re.compile(rb'-----END (?:[A-Z ]+ )?PRIVATE KEY-----')
headers = re.compile(rb'\b(?:set-cookie|cookie|authorization)["\']?[ \t]*:[^\r\n]*', re.I)
tokens = re.compile(rb'\bsk-[A-Za-z0-9_-]{12,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', re.I)
codes = re.compile(rb'\bBZZY-(?:LIBRARY|TERMINAL|AGENT|PAIR)-[A-Za-z0-9_.-]+')
email = re.compile(rb'\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', re.I)
home_path = re.compile(rb'/(?:Users|home)/[^\s/"\'<>]+')
url_binding = re.compile(rb'\b([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@', re.I)
delimiter = re.compile(rb'[\r\n,;]')
token_end = re.compile(rb'[\s"\']')


def value_end(data, start, line=False):
    if start >= len(data):
        return start
    if data[start] in (34, 39):
        quote, cursor = bytes([data[start]]), start + 1
        while cursor < len(data):
            found = data.find(quote, cursor)
            if found < 0:
                return len(data)
            back = found
            while back > start and data[back - 1] == 92:
                back -= 1
            if (found - back) % 2 == 0:
                cursor = found + 1
                break
            cursor = found + 1
        else:
            return len(data)
    else:
        cursor = start
    match = (delimiter if line else token_end).search(data, cursor)
    return match.start() if match else len(data)


def collect_spans(data, emit, binary=False):
    # Every search sees the complete disk-backed value. Credential/quote/tag
    # boundaries therefore cannot be defeated by placing them between reads.
    for secret in secrets:
        cursor = 0
        while True:
            start = data.find(secret, cursor)
            if start < 0:
                break
            emit(start, start + len(secret), b'[redacted]')
            cursor = start + 1
        progress()
    for pattern in (assignment, flags, auth):
        for match in pattern.finditer(data):
            emit(match.start(), value_end(data, match.end(), pattern is assignment), b'[redacted-binding]')
        progress()
    for begin, end, label in ((pem, pem_end, b'[redacted]'), (reasoning, reasoning_end, b'[omitted: private-reasoning]')):
        cursor = 0
        while True:
            match = begin.search(data, cursor)
            if not match:
                break
            close = end.search(data, match.end())
            cursor = close.end() if close else len(data)
            emit(match.start(), cursor, label)
        progress()
    for pattern, replacement in ((headers, b'[redacted-header]'), (tokens, b'[redacted]'), (codes, b'[redacted-code]')):
        for match in pattern.finditer(data):
            emit(match.start(), match.end(), replacement)
        progress()
    if binary:
        return
    for pattern, replacement in ((email, b'[redacted-account]'), (home_path, b'[home]')):
        for match in pattern.finditer(data):
            emit(match.start(), match.end(), replacement)
        progress()
    for match in url_binding.finditer(data):
        emit(match.end(1), match.end(), b'[redacted]@')
    for root, label in roots:
        cursor = 0
        while True:
            start = data.find(root, cursor)
            if start < 0:
                break
            emit(start, start + len(root), label)
            cursor = start + 1
        progress()


def merged_spans(rows):
    pending = None
    for start, end, replacement, file in rows:
        if pending is not None and start < pending[1]:
            # Union overlaps so a second credential's tail can never survive
            # the replacement of an earlier, overlapping match.
            if end > pending[1]:
                pending = (pending[0], end, b'[redacted]', None)
            continue
        if pending is not None:
            yield pending
        pending = (start, end, replacement, file)
    if pending is not None:
        yield pending


def write_spans(data, target, rows):
    cursor = 0
    for start, end, replacement, file in merged_spans(rows):
        copy_range(data, cursor, start, target)
        if file:
            with open(file, 'rb') as content:
                while True:
                    block = content.read(BLOCK)
                    if not block:
                        break
                    target.write(block)
        else:
            target.write(replacement)
        cursor = end
    copy_range(data, cursor, len(data), target)


def redact_small(value):
    raw = value.encode('utf-8', 'surrogatepass')
    spans = []
    collect_spans(raw, lambda start, end, replacement: spans.append((start, end, replacement, None)))
    if not spans:
        return None
    import io
    output = io.BytesIO()
    write_spans(raw, output, sorted(spans, key=lambda row: (row[0], -row[1])))
    return output.getvalue().decode('utf-8', 'surrogatepass')


def redact_file(source, destination, db, unit):
    with mapped(source) as data:
        collect_spans(data, lambda start, end, replacement: db.execute('INSERT INTO spans VALUES (?,?,?,?,?,NULL)', (unit, start, end, replacement, None)))
        rows = db.execute('SELECT start,end,replacement,file FROM spans WHERE unit=? ORDER BY start,end DESC', (unit,))
        with private_file(destination) as target:
            write_spans(data, target, rows)
    db.execute('DELETE FROM spans WHERE unit=?', (unit,))


special = re.compile(rb'["\\\x00-\x1f]')
number = re.compile(rb'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')
space_end = re.compile(rb'[^ \t\r\n]')
hex_digits = frozenset(b'0123456789abcdefABCDEF')
escapes = {34: b'"', 92: b'\\', 47: b'/', 98: b'\b', 102: b'\f', 110: b'\n', 114: b'\r', 116: b'\t'}


def string_end(data, start, limit):
    cursor, reported = start + 1, start
    while True:
        if cursor - reported >= BLOCK:
            progress()
            reported = cursor
        match = special.search(data, cursor, limit)
        if not match or data[match.start()] < 32:
            raise Omission('unparseable_structured_data')
        cursor = match.start()
        if data[cursor] == 34:
            return cursor + 1
        if cursor + 1 >= limit:
            raise Omission('unparseable_structured_data')
        if data[cursor + 1] == 117:
            if cursor + 6 > limit or any(value not in hex_digits for value in data[cursor + 2:cursor + 6]):
                raise Omission('unparseable_structured_data')
            cursor += 6
        elif data[cursor + 1] in escapes:
            cursor += 2
        else:
            raise Omission('unparseable_structured_data')


def decode_string(data, start, end, destination):
    escape = re.compile(rb'\\')
    cursor, stop = start + 1, end - 1
    with private_file(destination) as target:
        while cursor < stop:
            match = escape.search(data, cursor, stop)
            if not match:
                copy_range(data, cursor, stop, target)
                break
            offset = match.start()
            copy_range(data, cursor, offset, target)
            code = data[offset + 1]
            if code == 117:
                point = int(data[offset + 2:offset + 6], 16)
                cursor = offset + 6
                if 0xD800 <= point <= 0xDBFF and data[cursor:cursor + 2] == b'\\u':
                    low = int(data[cursor + 2:cursor + 6], 16)
                    if 0xDC00 <= low <= 0xDFFF:
                        point = 0x10000 + ((point - 0xD800) << 10) + low - 0xDC00
                        cursor += 6
                target.write(chr(point).encode('utf-8', 'surrogatepass'))
            else:
                target.write(escapes[code])
                cursor = offset + 2


def encode_string(source, destination):
    decoder = codecs.getincrementaldecoder('utf-8')('surrogatepass')
    with open(source, 'rb') as value, private_file(destination) as target:
        target.write(b'"')
        while True:
            data = value.read(BLOCK)
            text = decoder.decode(data, final=not data)
            target.write(json.dumps(text, ensure_ascii=True)[1:-1].encode('ascii'))
            progress()
            if not data:
                break
        target.write(b'"')


class JsonProjection:
    def __init__(self, data, db):
        self.data, self.db = data, db
        self.position, self.limit = 0, len(data)

    def span(self, start, end, replacement=None, file=None, priority=0):
        self.db.execute('INSERT INTO spans VALUES (0,?,?,?,?,?)', (start, end, replacement, file, priority))

    def string(self, start, end):
        if end - start <= SMALL:
            value = json.loads(self.data[start:end])
            clean = redact_small(value)
            if clean is not None:
                self.span(start, end, json.dumps(clean, ensure_ascii=True).encode('ascii'))
            return value
        decoded, cleaned, encoded = temporary(), temporary(), temporary()
        decode_string(self.data, start, end, decoded)
        redact_file(decoded, cleaned, self.db, start + 1)
        encode_string(cleaned, encoded)
        os.unlink(decoded)
        os.unlink(cleaned)
        self.span(start, end, file=encoded)
        return None

    def finish(self, frame, start, end, value=None, string=False):
        if frame['kind'] == 'object':
            key = frame['key']
            if key is None or private_key(key):
                self.span(start, end, b'"[redacted]"', priority=2)
            if key == 'type' and string and value is not None and reasoning_type.search(value.rstrip('\r\n\u2028\u2029')):
                frame['reasoning'] = True
            if key == 'name' and string and value is not None and private_key(value):
                frame['privateName'] = True
            if key == 'value':
                self.db.execute('INSERT INTO object_values VALUES (?,?,?)', (frame['start'], start, end))
        frame['state'] = 'done' if frame['kind'] == 'root' else 'comma'

    def parse(self, start, end):
        self.position, self.limit = start, end
        stack = [{'kind': 'root', 'state': 'value'}]
        while stack:
            frame = stack[-1]
            match = space_end.search(self.data, self.position, end)
            self.position = match.start() if match else end
            state, kind = frame['state'], frame['kind']
            if state == 'done':
                if self.position != end:
                    raise Omission('unparseable_structured_data')
                return
            if self.position >= end:
                raise Omission('unparseable_structured_data')
            token, pos = self.data[self.position], self.position
            closing = kind == 'object' and token == 125 or kind == 'array' and token == 93
            if closing and state in ('first', 'comma'):
                self.position += 1
                if kind == 'object':
                    if frame['reasoning']:
                        self.span(frame['start'], self.position, b'{"omitted":"private-reasoning"}', priority=3)
                    if frame['privateName']:
                        for (begin, stop) in self.db.execute('SELECT start,end FROM object_values WHERE object=?', (frame['start'],)):
                            self.span(begin, stop, b'"[redacted]"', priority=2)
                    self.db.execute('DELETE FROM object_values WHERE object=?', (frame['start'],))
                stack.pop()
                self.finish(stack[-1], frame['start'], self.position)
                continue
            if state == 'comma':
                if token != 44:
                    raise Omission('unparseable_structured_data')
                self.position += 1
                frame['state'] = 'key' if kind == 'object' else 'value'
                continue
            if kind == 'object' and state in ('first', 'key'):
                if token != 34:
                    raise Omission('unparseable_structured_data')
                stop = string_end(self.data, pos, end)
                frame['key'] = self.string(pos, stop)
                self.position, frame['state'] = stop, 'colon'
                continue
            if state == 'colon':
                if token != 58:
                    raise Omission('unparseable_structured_data')
                self.position += 1
                frame['state'] = 'value'
                continue
            if token in (123, 91):
                stack.append({'kind': 'object' if token == 123 else 'array', 'state': 'first', 'start': pos,
                              'key': None, 'reasoning': False, 'privateName': False})
                self.position += 1
                continue
            if token == 34:
                self.position = string_end(self.data, pos, end)
                value = self.string(pos, self.position)
                self.finish(frame, pos, self.position, value, True)
                continue
            found = False
            for literal in (b'true', b'false', b'null'):
                if self.data[pos:pos + len(literal)] == literal:
                    self.position += len(literal)
                    found = True
                    break
            if not found:
                match = number.match(self.data, pos, end)
                if not match:
                    raise Omission('unparseable_structured_data')
                self.position = match.end()
            self.finish(frame, pos, self.position)
            progress()


def hash_file(name):
    digest, size = hashlib.sha256(), 0
    with open(name, 'rb') as stream:
        while True:
            data = stream.read(BLOCK)
            if not data:
                break
            digest.update(data)
            size += len(data)
            progress()
    return digest.hexdigest(), size


def run():
    snapshot, source_hash, text = checked_snapshot()
    destination = spec['destination']
    database = temporary()
    with private_file(database):
        pass
    with sqlite3.connect(database) as db:
        db.execute('PRAGMA cache_size=-2048')
        db.execute('PRAGMA temp_store=FILE')
        db.execute('CREATE TABLE spans (unit INTEGER, start INTEGER, end INTEGER, replacement BLOB, file TEXT, reserved INTEGER)')
        db.execute('CREATE INDEX span_order ON spans(unit,start,end DESC)')
        db.execute('CREATE TABLE object_values (object INTEGER, start INTEGER, end INTEGER)')
        db.execute('CREATE INDEX object_order ON object_values(object)')
        if not text:
            with mapped(snapshot) as data:
                def reject(*_):
                    raise Omission('credential_in_binary')
                collect_spans(data, reject, binary=True)
            os.link(snapshot, destination)
            os.unlink(snapshot)
            encoding = 'binary'
        else:
            with mapped(snapshot) as data:
                match = space_end.search(data)
                first = data[match.start()] if match else None
                name = spec['name'].lower()
                forced = name.endswith(('.json', '.har', '.jsonl'))
                structured = forced or first in (123, 91)
                if structured:
                    projection = JsonProjection(data, db)
                    try:
                        if name.endswith('.jsonl'):
                            cursor = 0
                            while cursor < len(data):
                                stop = data.find(b'\n', cursor)
                                stop = len(data) if stop < 0 else stop
                                if space_end.search(data, cursor, stop):
                                    projection.parse(cursor, stop)
                                cursor = stop + 1
                        else:
                            projection.parse(0, len(data))
                    except Omission:
                        if forced:
                            raise
                        structured = False
                        db.execute('DELETE FROM spans WHERE unit=0')
                        db.execute('DELETE FROM object_values')
                    if structured:
                        with private_file(destination) as target:
                            rows = db.execute('SELECT start,end,replacement,file FROM spans WHERE unit=0 ORDER BY start,end DESC,reserved DESC')
                            write_spans(data, target, rows)
                    encoding = 'jsonl' if name.endswith('.jsonl') else 'utf8'
                else:
                    encoding = 'utf8'
            if not structured:
                redact_file(snapshot, destination, db, 0)
    with mapped(destination) as exported:
        # Include record boundaries and text newly joined by replacements in
        # the final check, as the in-process complete-value scrubber does.
        if any(exported.find(secret) >= 0 for secret in secrets) or tokens.search(exported) or pem.search(exported):
            raise Omission('credential_in_binary' if not text else 'credential_content')
    exported_hash, size = hash_file(destination)
    progress(True)
    print(json.dumps({'type': 'complete', 'value': {'bytes': size, 'sourceBytes': source_bytes, 'sha256': exported_hash,
        'sourceSha256': source_hash, 'encoding': encoding, 'redacted': exported_hash != source_hash}}), flush=True)


try:
    run()
except Omission as error:
    print(json.dumps({'type': 'omitted', 'reason': str(error)}), flush=True)
except (ValueError, UnicodeError, RecursionError):
    print(json.dumps({'type': 'omitted', 'reason': 'unparseable_structured_data'}), flush=True)
except OSError as error:
    import errno
    category = 'SPACE' if error.errno in (errno.ENOSPC, errno.EDQUOT) else 'ACCESS' if error.errno in (errno.EACCES, errno.EPERM) else 'FAILED'
    print(json.dumps({'type': 'error', 'code': 'SESSION_DEBUG_' + category}), flush=True)
except sqlite3.Error as error:
    full = getattr(error, 'sqlite_errorcode', None) == getattr(sqlite3, 'SQLITE_FULL', 13) or 'database or disk is full' in str(error).lower()
    print(json.dumps({'type': 'error', 'code': 'SESSION_DEBUG_SPACE' if full else 'SESSION_DEBUG_FAILED'}), flush=True)
except BaseException:
    print(json.dumps({'type': 'error', 'code': 'SESSION_DEBUG_FAILED'}), flush=True)
