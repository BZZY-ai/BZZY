"""Offline coverage for the private stdlib Gmail transport."""

import importlib.util
from email.message import EmailMessage
import io
import json
from pathlib import Path
import ssl
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("bzzy_gmail_imap", Path(__file__).parents[1] / "src/engine/gmail-imap.py")
gmail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gmail)

ADDRESS = "mailbox@example.invalid"
ALIAS = "fixture+1@example.invalid"
PASSWORD = "private-fixture-app-password"


def request(operation="read", **options):
    value = {"operation": operation, "address": ADDRESS, "appPassword": PASSWORD}
    if operation == "read":
        value.update({"uid": "7", "uidValidity": "42"})
    value.update(options)
    return value


def message(recipient=ALIAS, html=False, attachment=False):
    value = EmailMessage()
    value["From"] = "Fixture sender <sender@example.invalid>"
    value["To"] = recipient
    value["Subject"] = "Verification fixture"
    value["Date"] = "Tue, 27 Oct 2026 12:00:00 +0000"
    value["Message-ID"] = "<fixture@example.invalid>"
    if html:
        value.set_content('<p>Hello &amp; welcome</p><script>hidden-script</script><style>hidden-style</style>'
                          '<a href="https://example.invalid/verify?t=fixture&amp;next=1"><strong>Verify</strong> account</a>'
                          '<a href="javascript:invalid()">Unsafe link</a>', subtype="html")
    else:
        value.set_content("Read-only verification fixture.")
    if attachment:
        value.add_attachment(b"do not write attachment bytes", maintype="application", subtype="octet-stream", filename="fixture.bin")
    return value.as_bytes()


class FakeIMAP:
    def __init__(self, raw=None, headers=None, size=None, validity=b"42", auth_error=False, returned_uid="7"):
        self.raw = raw if raw is not None else message()
        self.headers = headers if headers is not None else self.raw.split(b"\n\n", 1)[0] + b"\n\n"
        self.size = len(self.raw) if size is None else size
        self.validity = validity
        self.auth_error = auth_error
        self.returned_uid = returned_uid
        self.calls = []
        self.literal = None

    def login(self, address, password):
        self.calls.append(("login", address, password))
        if self.auth_error:
            raise gmail.imaplib.IMAP4.error("raw-server-reply " + PASSWORD + " " + ADDRESS)
        return "OK", [b"authenticated"]

    def select(self, folder, readonly=False):
        self.calls.append(("select", folder, readonly))
        return "OK", [b"1"]

    def response(self, code):
        self.calls.append(("response", code))
        return code, [self.validity]

    def uid(self, command, *arguments):
        self.calls.append(("uid", command, arguments, self.literal))
        self.literal = None
        if command == "SEARCH":
            return "OK", [b"7"]
        if command != "FETCH":
            raise AssertionError("Unexpected IMAP command")
        uid, section = arguments
        content = self.raw if "BODY.PEEK[]" in section else self.headers
        metadata = ("1 (UID " + self.returned_uid + " RFC822.SIZE " + str(self.size) + " BODY[] {" + str(len(content)) + "}").encode("ascii")
        return "OK", [(metadata, content), b")"]

    def logout(self):
        self.calls.append(("logout",))
        return "BYE", [b"done"]

    def close(self):
        raise AssertionError("CLOSE must never be used")


class GmailTransportTests(unittest.TestCase):
    def run_request(self, value, client=None):
        client = client or FakeIMAP()

        def factory(host, port, ssl_context, timeout):
            self.assertEqual(host, "imap.gmail.com")
            self.assertEqual(port, 993)
            self.assertTrue(ssl_context.check_hostname)
            self.assertEqual(ssl_context.verify_mode, ssl.CERT_REQUIRED)
            self.assertLessEqual(timeout, 10)
            return client

        return gmail.run_request(value, client_factory=factory), client

    def test_check_uses_verified_tls_and_readonly_folder_without_fetch(self):
        result, client = self.run_request(request("check"))
        self.assertEqual(result, {"ok": True, "result": {"folder": "INBOX", "uidValidity": "42", "readOnly": True}})
        self.assertIn(("select", '"INBOX"', True), client.calls)
        self.assertFalse(any(call[0] == "uid" for call in client.calls))
        self.assertEqual(client.calls[-1], ("logout",))

    def test_search_is_one_utf8_literal_and_fetches_only_bounded_peek_headers(self):
        result, client = self.run_request(request("list", search='from:"fixture" café', recipientAliases=[ALIAS]))
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["messages"][0]["uid"], "7")
        search = next(call for call in client.calls if call[:2] == ("uid", "SEARCH"))
        self.assertEqual(search[2], ("CHARSET", "UTF-8", "X-GM-RAW"))
        self.assertIn('from:"fixture" café'.encode("utf-8"), search[3])
        self.assertIn(('to:"' + ALIAS + '"').encode("ascii"), search[3])
        fetches = [call for call in client.calls if call[:2] == ("uid", "FETCH")]
        self.assertEqual(len(fetches), 1)
        self.assertIn("BODY.PEEK[HEADER.FIELDS", fetches[0][2][1])
        self.assertIn("<0.32768>", fetches[0][2][1])

    def test_read_includes_uid_context_and_html_links_but_never_attachment_data(self):
        raw = message(html=True, attachment=True)
        result, client = self.run_request(request(recipientAliases=[ALIAS]), FakeIMAP(raw=raw))
        self.assertTrue(result["ok"])
        value = result["result"]
        self.assertEqual((value["uid"], value["uidValidity"], value["folder"]), ("7", "42", "INBOX"))
        self.assertIn("Hello & welcome", value["body"])
        self.assertIn("https://example.invalid/verify?t=fixture&next=1", value["body"])
        self.assertEqual(value["links"], [{"url": "https://example.invalid/verify?t=fixture&next=1", "text": "Verify account"}])
        self.assertNotIn("hidden-script", value["body"])
        self.assertNotIn("hidden-style", value["body"])
        self.assertNotIn("javascript:", json.dumps(value))
        self.assertEqual(value["attachments"], [{"filename": "fixture.bin", "contentType": "application/octet-stream"}])
        self.assertNotIn("do not write attachment bytes", json.dumps(value))
        commands = [call for call in client.calls if call[0] == "uid"]
        self.assertTrue(all(call[1] == "FETCH" and "BODY.PEEK[" in call[2][1] for call in commands))
        self.assertEqual(len(commands), 2)

    def test_stale_uidvalidity_prevents_any_fetch(self):
        result, client = self.run_request(request(uidValidity="41"))
        self.assertEqual(result["error"]["code"], "UIDVALIDITY_CHANGED")
        self.assertFalse(any(call[0] == "uid" for call in client.calls))

    def test_oversized_messages_and_disallowed_recipients_never_fetch_bodies(self):
        for client, code in [(FakeIMAP(size=gmail.MAX_MESSAGE_BYTES + 1), "MESSAGE_TOO_LARGE"),
                             (FakeIMAP(raw=message("other@example.invalid")), "RECIPIENT_NOT_ALLOWED")]:
            result, client = self.run_request(request(recipientAliases=[ALIAS]), client)
            self.assertEqual(result["error"]["code"], code)
            fetches = [call for call in client.calls if call[:2] == ("uid", "FETCH")]
            self.assertEqual(len(fetches), 1)
            self.assertNotIn("BODY.PEEK[]", fetches[0][2][1])

    def test_list_withholds_unapproved_recipients_and_checks_returned_uid(self):
        result, _ = self.run_request(request("list", recipientAliases=[ALIAS]), FakeIMAP(raw=message("other@example.invalid")))
        self.assertEqual(result["result"]["messages"], [])
        result, _ = self.run_request(request(), FakeIMAP(returned_uid="8"))
        self.assertEqual(result["error"]["code"], "PROTOCOL_ERROR")

    def test_auth_errors_are_fixed_and_never_echo_credentials_or_server_reply(self):
        result, client = self.run_request(request("check"), FakeIMAP(auth_error=True))
        self.assertEqual(result, {"ok": False, "error": {"code": "AUTH_FAILED", "message": gmail.ERRORS["AUTH_FAILED"]}})
        self.assertNotIn(PASSWORD, json.dumps(result))
        self.assertNotIn(ADDRESS, json.dumps(result))
        self.assertNotIn("raw-server-reply", json.dumps(result))
        self.assertEqual(client.calls[-1], ("logout",))

    def test_invalid_fields_are_rejected_before_network(self):
        invalid = [request(uid="1:7"), request(uidValidity=None), request(maxChars=16001), request(maxChars=True),
                   request("list", last=26), request("list", search="a" * 1001), request("list", search="ALL\r\nSTORE"),
                   request(folder="INBOX\r\nEXPUNGE"), request(appPassword="fixture\npassword"), request(credentialPath="/private/secret"),
                   request(recipientAliases=[ALIAS, ALIAS.upper()]), request("check", uid="7"), request(address="Name <mailbox@example.invalid>")]
        for value in invalid:
            with self.subTest(value=value):
                result = gmail.run_request(value, client_factory=lambda *a, **k: self.fail("invalid input reached network"))
                self.assertEqual(result["error"]["code"], "INVALID_REQUEST")

    def test_body_truncation_and_bad_charset_have_bounded_plaintext_fallback(self):
        raw = b"To: " + ALIAS.encode() + b"\r\nContent-Type: text/plain; charset=unknown-fixture-charset\r\n\r\nabcdef\xff"
        result, _ = self.run_request(request(maxChars=3), FakeIMAP(raw=raw))
        self.assertEqual(result["result"]["body"], "abc")
        self.assertTrue(result["result"]["bodyTruncated"])

    def test_html_alternative_keeps_verification_urls_when_plain_body_is_preferred(self):
        value = EmailMessage()
        value["To"] = ALIAS
        value.set_content("Plain verification instructions.")
        value.add_alternative('<a href="https://example.invalid/verify">Confirm</a>', subtype="html")
        result, _ = self.run_request(request(), FakeIMAP(raw=value.as_bytes()))
        self.assertEqual(result["result"]["body"], "Plain verification instructions.")
        self.assertEqual(result["result"]["links"], [{"url": "https://example.invalid/verify", "text": "Confirm"}])

    def test_folded_headers_and_html_labels_are_safe_single_line_metadata(self):
        raw = (b"To: " + ALIAS.encode() + b"\r\nSubject: Folded\r\n\tfixture\r\n"
               b"Content-Type: text/html; charset=utf-8\r\n\r\n"
               b'<a href="https://example.invalid/verify">\n\t Confirm \n account \t</a>')
        result, _ = self.run_request(request(), FakeIMAP(raw=raw))
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["subject"], "Folded fixture")
        self.assertEqual(result["result"]["links"][0]["text"], "Confirm account")

    def test_literal_limit_rejects_server_size_before_any_read_allocation(self):
        client = object.__new__(gmail.BoundedIMAP)
        client._literal_limit = 32
        client._bytes_left = 1024
        client._deadline = gmail.time.monotonic() + 20
        with patch.object(gmail.imaplib.IMAP4_SSL, "read", side_effect=AssertionError("must not read")):
            for amount in (33, -1, 104857600):
                with self.assertRaises(gmail.MailError) as error:
                    client.read(amount)
                self.assertEqual(error.exception.code, "RESPONSE_TOO_LARGE")

    def test_total_network_budget_and_deadline_are_enforced(self):
        client = object.__new__(gmail.BoundedIMAP)
        client._literal_limit = 32
        client._bytes_left = 2
        client._deadline = gmail.time.monotonic() + 20
        with patch.object(gmail.imaplib.IMAP4_SSL, "readline", return_value=b"oversized-line\r\n"):
            with self.assertRaises(gmail.MailError) as error:
                client.readline()
            self.assertEqual(error.exception.code, "RESPONSE_TOO_LARGE")
        client._deadline = gmail.time.monotonic() - 1
        with self.assertRaises(gmail.MailError) as error:
            client.read(1)
        self.assertEqual(error.exception.code, "TIMEOUT")

    def test_unicode_folder_uses_modified_utf7_and_quoted_arguments(self):
        result, client = self.run_request(request("check", folder='Fixtures & "/ café'))
        self.assertTrue(result["ok"])
        folder = next(call[1] for call in client.calls if call[0] == "select")
        self.assertEqual(folder, '"Fixtures &- \\"/ caf&AOk-"')


if __name__ == "__main__":
    unittest.main()
