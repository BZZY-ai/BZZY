# Connection and history validation — 2026-10-24

Build 0.1.0 (15) repairs the iPhone conversation attachment path and adds bounded
local history with Core-owned backward paging. Core/CLI changes are distributed
through the existing CLI updater; the iPhone app is installed separately.

## Defects addressed

- A legacy unresolved input receipt in one resource disabled unrelated chats.
  Receipts now remain durable and reconcile in their original resource.
- A one-shot view attachment could fail during startup and never retry. The
  visible conversation now keeps an observation intent across recovery.
- Optional catalog reads could fail under read pressure, leaving an empty list;
  coalesced refreshes could also lose a newer refresh. Reads now retry/coalesce,
  and the cached catalog does not authorize or prevent a server attachment.
- A retired session could publish over the destination's cached history.
  Publishing now respects the visible destination while persistence/ACKs retain
  their original scope.
- Native transport throttled PAIR data at the administrative 240/minute limit
  and swallowed transient delivery failures. The native budget now matches
  Relay's separately bounded PAIR data budget; receipt failures reconnect.
- Oversized events could repeatedly close history at the same durable cursor.
  Exact bounded chunks reconstruct and verify the full sanitized envelope.
- Lost unsubscribe requests left empty subscriptions occupying slots. Own-phone
  handoff retires the old observations; idle leases reclaim abandoned slots.

## Automated evidence

| Check | Result |
| --- | --- |
| Core syntax/import checks and full suite | 233 passed |
| CLI checks and full compatibility suite | 428 passed, 21 existing platform skips |
| Relay checks and full suite | 30 passed |
| Native Swift suite | 75 passed |
| Model, canonical body, message boundary and draft checks | Passed |
| Native preview, project/plist and privacy checks | Passed |
| Simulator history paging/Latest, goal shortcuts, stable keyboard, offline workspace and fresh-pairing checks | Passed |
| Signed development app/APNs/privacy/signature artifact checks | Passed |

The new real Core/Relay/native regression restores an unresolved legacy receipt
in A, overlaps Refresh with attachment to B, sends once in B, backgrounds and
reattaches without replay. It preserves A's original request ID and completes in
about 1.35 seconds on loopback, including a deliberate 600 ms suspension.

Cache tests cover scope isolation, bootstrap expiry/ambiguous acceptance, exact
replay/conflict rejection, persisted outgoing state, backward windows beyond the
retention bound, live updates during older browsing, checksum failure, ACK-response
reordering and late closure notices. Gateway tests switch through six derived
resources, reject friend-grant handoff and reclaim idle subscription capacity.
Transport tests exceed the former native request cap and inject a failed receipt.

A separate optimized development-Mac measurement verified exact bodies and replay
identities through 100 rollovers of a 2000-delta projection: median 5.14 ms, p95
5.86 ms. This measures projection work, not phone or network latency.

## Device and deployment scope

The signed app was installed in place on the wired iPhone and launched normally;
CoreDevice confirmed app.bzzy.ios version 0.1.0, build 15. App data and Keychain
pairing were retained. No real user messages, goals or provider calls were sent
as part of validation. Real phone chat latency after the host update remains a
manual check, rather than an inferred result from loopback tests.

Public Relay TLS health passed. The recorded deployed server source fingerprint
matches the current server containing the PAIR data budget; no Relay server wire
change or deployment was needed. This work did not independently inspect the
live server over SSH. It did not replace or restart the user's installed Core/CLI;
use the existing CLI Update button for that release.

The default gateway idle polling interval remains 500 ms; successful processed
ACKs trigger the next backlog page immediately. WAN latency, device scheduling
and model startup still contribute to perceived delay. Cached display and selected
session readiness no longer wait for full catalog/history loading, but these
checks do not establish zero latency or availability during an actual outage.
