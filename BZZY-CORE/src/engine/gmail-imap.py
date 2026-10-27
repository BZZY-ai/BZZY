#!/usr/bin/env python3
"""Private, bounded, read-only Gmail transport. One JSON request on stdin.

The host owns credentials and authorization. This process accepts no credential
paths or command-line options and never writes messages or attachment files.
Reading requires the complete MIME message to fit within 1 MiB, including any
encoded attachments; larger messages are rejected before their bodies are read.
Attachments have metadata only in the response, with no download operation.
"""

import email
from email import policy
from email.utils import getaddresses
from html.parser import HTMLParser
import imaplib
import json
import re
import socket
import ssl
import sys
import time


HOST = "imap.gmail.com"
PORT = 993
MAX_REQUEST_BYTES = 128 * 1024
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_HEADER_BYTES = 32 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 256 * 1024
SOCKET_TIMEOUT = 10
SESSION_TIMEOUT = 25

ERRORS = {
    "INVALID_REQUEST": "The Gmail request is invalid.",
    "AUTH_FAILED": "Gmail rejected the account or app password.",
    "FOLDER_UNAVAILABLE": "The requested Gmail folder is unavailable.",
    "UIDVALIDITY_CHANGED": "The folder changed. List its messages again before reading one.",
    "MESSAGE_NOT_FOUND": "The requested message is unavailable in this folder.",
    "MESSAGE_TOO_LARGE": "This message exceeds the read-only Gmail size limit.",
    "RECIPIENT_NOT_ALLOWED": "This message is outside the approved recipient aliases.",
    "CONNECTION_FAILED": "The read-only Gmail connection failed.",
    "TIMEOUT": "The read-only Gmail request timed out.",
    "PROTOCOL_ERROR": "Gmail returned an unsupported response.",
    "RESPONSE_TOO_LARGE": "The Gmail response exceeds the read-only size limit.",
}


class MailError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(ERRORS[code])


class BoundedIMAP(imaplib.IMAP4_SSL):
    """Reject oversized server literals before imaplib allocates their bodies."""

    def __init__(self, host, port, ssl_context=None, timeout=SOCKET_TIMEOUT):
        self._bytes_left = MAX_RESPONSE_BYTES
        self._deadline = time.monotonic() + SESSION_TIMEOUT
        self._literal_limit = MAX_MESSAGE_BYTES
        super().__init__(host, port, ssl_context=ssl_context, timeout=timeout)

    def _before_io(self):
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise MailError("TIMEOUT")
        connection = getattr(self, "sock", None)
        if connection is not None:
            connection.settimeout(min(SOCKET_TIMEOUT, remaining))

    def _consume(self, value):
        self._bytes_left -= len(value)
        if self._bytes_left < 0:
            raise MailError("RESPONSE_TOO_LARGE")
        return value

    def read(self, size):
        self._before_io()
        if not isinstance(size, int) or size < 0 or size > self._literal_limit or size > self._bytes_left:
            raise MailError("RESPONSE_TOO_LARGE")
        return self._consume(super().read(size))

    def readline(self):
        self._before_io()
        # imaplib bounds each line itself; account for lines as well as literals.
        return self._consume(super().readline())


def _text(value, maximum, allow_empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not value and not allow_empty):
        raise MailError("INVALID_REQUEST")
    if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value):
        raise MailError("INVALID_REQUEST")
    return value


def _address(value):
    value = _text(value, 254)
    # A mailbox is a plain address, never a display name or an IMAP argument.
    if not re.fullmatch(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+", value):
        raise MailError("INVALID_REQUEST")
    local, domain = value.rsplit("@", 1)
    if len(local) > 64 or local.startswith(".") or local.endswith(".") or ".." in local:
        raise MailError("INVALID_REQUEST")
    if "." not in domain or any(not label or label.startswith("-") or label.endswith("-") for label in domain.split(".")):
        raise MailError("INVALID_REQUEST")
    return value


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise MailError("INVALID_REQUEST")
    return value


def _uid(value):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,9}", value) or int(value) > 4294967295:
        raise MailError("INVALID_REQUEST")
    return value


def validate_request(value):
    fields = {"operation", "address", "appPassword", "folder", "last", "search", "uid", "uidValidity", "maxChars", "recipientAliases"}
    if not isinstance(value, dict) or set(value) - fields:
        raise MailError("INVALID_REQUEST")
    operation = value.get("operation")
    if operation not in ("check", "list", "read"):
        raise MailError("INVALID_REQUEST")
    address = _address(value.get("address"))
    password = _text(value.get("appPassword"), 128).replace(" ", "")
    if not password or not password.isascii():
        raise MailError("INVALID_REQUEST")
    folder = _text(value.get("folder", "INBOX"), 240)
    aliases = value.get("recipientAliases", [])
    if not isinstance(aliases, list) or len(aliases) > 32:
        raise MailError("INVALID_REQUEST")
    aliases = [_address(alias).lower() for alias in aliases]
    if len(aliases) != len(set(aliases)):
        raise MailError("INVALID_REQUEST")
    request = {"operation": operation, "address": address, "appPassword": password,
               "folder": folder, "recipientAliases": aliases}
    if operation == "list":
        request["last"] = _integer(value.get("last", 10), 1, 25)
        request["search"] = _text(value.get("search", ""), 1000, allow_empty=True)
    elif operation == "read":
        request["uid"] = _uid(value.get("uid"))
        request["uidValidity"] = _uid(value.get("uidValidity"))
        request["maxChars"] = _integer(value.get("maxChars", 12000), 1, 16000)
    # Reject fields that look accepted but have no meaning for this operation.
    allowed = {"operation", "address", "appPassword", "folder", "recipientAliases"}
    allowed.update({"last", "search"} if operation == "list" else {"uid", "uidValidity", "maxChars"} if operation == "read" else set())
    if set(value) - allowed:
        raise MailError("INVALID_REQUEST")
    return request


def _folder_argument(folder):
    # IMAP4rev1 mailbox names use modified UTF-7; folder input remains Unicode.
    def encoded(match):
        import base64
        return "&" + base64.b64encode(match.group(0).encode("utf-16-be")).decode("ascii").rstrip("=").replace("/", ",") + "-"
    folder = folder.replace("&", "&-")
    folder = re.sub(r"[^\x20-\x7e]+", encoded, folder)
    return '"' + folder.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _ok(status, data, error="PROTOCOL_ERROR"):
    if status != "OK" or not isinstance(data, list):
        raise MailError(error)
    return data


def _uid_validity(client):
    kind, data = client.response("UIDVALIDITY")
    if kind != "UIDVALIDITY" or not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], bytes):
        raise MailError("PROTOCOL_ERROR")
    try:
        return _uid(data[0].decode("ascii"))
    except (UnicodeError, MailError):
        raise MailError("PROTOCOL_ERROR") from None


def _fetch(client, uid, section, maximum):
    client._literal_limit = maximum
    data = _ok(*client.uid("FETCH", uid, "(UID RFC822.SIZE BODY.PEEK[" + section + "]<0." + str(maximum) + ">)"), error="MESSAGE_NOT_FOUND")
    literals = [entry for entry in data if isinstance(entry, tuple)]
    if not literals:
        raise MailError("MESSAGE_NOT_FOUND")
    if len(literals) != 1 or len(literals[0]) != 2:
        raise MailError("PROTOCOL_ERROR")
    metadata, content = literals[0]
    if not isinstance(metadata, bytes) or not isinstance(content, bytes) or len(content) > maximum:
        raise MailError("PROTOCOL_ERROR")
    returned_uid = re.search(rb"\bUID ([0-9]+)\b", metadata, re.I)
    size = re.search(rb"\bRFC822\.SIZE ([0-9]+)\b", metadata, re.I)
    if returned_uid is None or returned_uid.group(1).decode("ascii") != uid or size is None:
        raise MailError("PROTOCOL_ERROR")
    return content, int(size.group(1))


HEADER_SECTION = "HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID DELIVERED-TO X-ORIGINAL-TO)"


def _display_text(value, maximum):
    return re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", value)[:maximum]


def _header_text(message, field, maximum=2048):
    try:
        text = str(message.get(field, ""))
    except (ValueError, LookupError, UnicodeError):
        text = ""
    return _display_text(text, maximum)


def _headers(message, uid):
    return {"uid": uid, "from": _header_text(message, "From"), "to": _header_text(message, "To"),
            "subject": _header_text(message, "Subject"), "date": _header_text(message, "Date", 128),
            "messageId": _header_text(message, "Message-ID", 512)}


def _recipient_allowed(message, aliases):
    if not aliases:
        return True
    fields = []
    for key in ("To", "Cc", "Delivered-To", "X-Original-To"):
        fields.extend(str(value) for value in message.get_all(key, []))
    return any(address.lower() in aliases for _, address in getaddresses(fields))


class PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.links = []
        self.hidden = 0
        self.anchor = None

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1
        if self.hidden:
            return
        if tag in ("br", "p", "div", "tr", "li", "h1", "h2", "h3"):
            self.parts.append("\n")
        if tag == "a":
            href = dict(attrs).get("href", "")
            # Links are inert output data; no URLs are ever requested here.
            if len(href) <= 2048 and re.match(r"https?://", href, re.I) and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in href):
                self.anchor = {"url": href, "text": ""}

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.hidden:
            self.hidden -= 1
            return
        if self.hidden:
            return
        if tag == "a" and self.anchor is not None:
            if len(self.links) < 16:
                self.anchor["text"] = re.sub(r"\s+", " ", _display_text(self.anchor["text"], 256)).strip()
                self.links.append(self.anchor)
                self.parts.append(" (" + self.anchor["url"] + ")")
            self.anchor = None
        if tag in ("p", "div", "tr", "li", "h1", "h2", "h3"):
            self.parts.append("\n")

    def handle_data(self, value):
        if not self.hidden:
            self.parts.append(value)
            if self.anchor is not None:
                self.anchor["text"] = (self.anchor["text"] + value)[:256]

    def result(self):
        text = "".join(self.parts)
        text = re.sub(r"[^\S\n]+", " ", text)
        return re.sub(r"\n\s*\n+", "\n\n", text).strip(), self.links


def _decode_text(part):
    try:
        text = part.get_content()
    except (LookupError, UnicodeError, ValueError, KeyError):
        payload = part.get_payload(decode=True)
        text = payload.decode("utf-8", "replace") if isinstance(payload, bytes) else ""
    return text if isinstance(text, str) else ""


def _message_body(message, max_chars):
    body = message.get_body(preferencelist=("plain", "html"))
    text, links = _decode_text(body) if body is not None else "", []
    html = message.get_body(preferencelist=("html",))
    if html is not None:
        parser = PlainHTML()
        parser.feed(_decode_text(html))
        parser.close()
        rendered, links = parser.result()
        if body is html:
            text = rendered
    attachments = []
    for part in message.iter_attachments():
        if len(attachments) >= 32:
            break
        # Do not decode, write, or fetch attachment contents separately.
        filename = part.get_filename()
        if filename:
            attachments.append({"filename": _display_text(str(filename), 256), "contentType": part.get_content_type()[:128]})
    text = text.strip()
    return {"body": text[:max_chars], "bodyTruncated": len(text) > max_chars,
            "links": links, "attachments": attachments}


def _search(client, query, aliases):
    if aliases:
        terms = []
        for alias in aliases:
            # Address validation excludes quotes/backslashes, but quote each
            # search value to keep Gmail query operators out of owner aliases.
            terms.extend(('to:"' + alias + '"', 'cc:"' + alias + '"', 'deliveredto:"' + alias + '"'))
        query = ("(" + query + ") " if query else "") + "{" + " ".join(terms) + "}"
    if query:
        # A single IMAP literal preserves UTF-8 and cannot inject a command or
        # additional SEARCH arguments, even when Gmail search uses quotes.
        client.literal = query.encode("utf-8")
        data = _ok(*client.uid("SEARCH", "CHARSET", "UTF-8", "X-GM-RAW"))
    else:
        data = _ok(*client.uid("SEARCH", "ALL"))
    if len(data) != 1 or not isinstance(data[0], bytes):
        raise MailError("PROTOCOL_ERROR")
    tokens = data[0].split()
    if any(not re.fullmatch(rb"[1-9][0-9]{0,9}", token) or int(token) > 4294967295 for token in tokens):
        raise MailError("PROTOCOL_ERROR")
    return sorted(set(int(token) for token in tokens), reverse=True)


def run_request(value, client_factory=BoundedIMAP):
    client = None
    try:
        request = validate_request(value)
        client = client_factory(HOST, PORT, ssl_context=ssl.create_default_context(), timeout=SOCKET_TIMEOUT)
        try:
            _ok(*client.login(request["address"], request["appPassword"]), error="AUTH_FAILED")
        except imaplib.IMAP4.error:
            raise MailError("AUTH_FAILED") from None
        _ok(*client.select(_folder_argument(request["folder"]), readonly=True), error="FOLDER_UNAVAILABLE")
        uid_validity = _uid_validity(client)
        result = {"folder": request["folder"], "uidValidity": uid_validity, "readOnly": True}
        if request["operation"] == "list":
            messages = []
            for value in _search(client, request["search"], request["recipientAliases"])[:request["last"]]:
                uid = str(value)
                raw, _ = _fetch(client, uid, HEADER_SECTION, MAX_HEADER_BYTES)
                message = email.message_from_bytes(raw, policy=policy.default)
                if _recipient_allowed(message, request["recipientAliases"]):
                    messages.append(_headers(message, uid))
            result["messages"] = messages
        elif request["operation"] == "read":
            if request["uidValidity"] != uid_validity:
                raise MailError("UIDVALIDITY_CHANGED")
            uid = request["uid"]
            raw_headers, size = _fetch(client, uid, HEADER_SECTION, MAX_HEADER_BYTES)
            headers = email.message_from_bytes(raw_headers, policy=policy.default)
            if not _recipient_allowed(headers, request["recipientAliases"]):
                raise MailError("RECIPIENT_NOT_ALLOWED")
            if size > MAX_MESSAGE_BYTES:
                raise MailError("MESSAGE_TOO_LARGE")
            raw, full_size = _fetch(client, uid, "", MAX_MESSAGE_BYTES)
            if full_size > MAX_MESSAGE_BYTES:
                raise MailError("MESSAGE_TOO_LARGE")
            if len(raw) != full_size:
                raise MailError("PROTOCOL_ERROR")
            message = email.message_from_bytes(raw, policy=policy.default)
            if not _recipient_allowed(message, request["recipientAliases"]):
                raise MailError("RECIPIENT_NOT_ALLOWED")
            result.update(_headers(message, uid))
            result.update(_message_body(message, request["maxChars"]))
        response = {"ok": True, "result": result}
        if len(json.dumps(response, ensure_ascii=False).encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise MailError("RESPONSE_TOO_LARGE")
        return response
    except MailError as error:
        return {"ok": False, "error": {"code": error.code, "message": ERRORS[error.code]}}
    except (socket.timeout, TimeoutError):
        return {"ok": False, "error": {"code": "TIMEOUT", "message": ERRORS["TIMEOUT"]}}
    except Exception:
        # Server replies, MIME failures and credentials must not reach logs or
        # the model through exception details, including in debug mode.
        return {"ok": False, "error": {"code": "CONNECTION_FAILED", "message": ERRORS["CONNECTION_FAILED"]}}
    finally:
        if client is not None:
            try:
                # CLOSE can expunge a mailbox. LOGOUT is sufficient and safe.
                client.logout()
            except Exception:
                pass


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise MailError("INVALID_REQUEST")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise MailError("INVALID_REQUEST")


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise MailError("INVALID_REQUEST")
        request = json.loads(raw.decode("utf-8"), object_pairs_hook=_json_object, parse_constant=_invalid_constant)
        result = run_request(request)
    except Exception:
        result = {"ok": False, "error": {"code": "INVALID_REQUEST", "message": ERRORS["INVALID_REQUEST"]}}
    # There is no diagnostic stream: exactly one JSON response is emitted.
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
