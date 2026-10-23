# iOS sharing and importing

Current live terminal sharing is implemented separately from the older preview
flows recorded below. A host-approved `shareAccess` grant lets iPhone request a
strict complete-context ZIP, display its transient QR/code, approve fingerprints
and revoke the offer. Recipient CLI imports into its actual cwd through encrypted
Relay. See [current transfer contract](../../BZZY-CORE/docs/PROJECT-SHARING.md).
Agent packages and mobile project import remain unimplemented. The following
sections describe historical local demo/import validation, not current gateway
capabilities; see [current validation](full-line-validation.md).

Implemented only in BZZY-IOS, 2026-10-22. Both agent and terminal chat headers expose Share. Both primary tabs expose Import. The existing connection guide and Relay implementation define real invitations; this change does not add a service, another runtime, invitation URLs or a portable package protocol.

## Available now

- Share defaults to Copy. Live access separately previews the resource, view-only scope, ten-minute invitation and required host approval. Neither option grants runtime access.
- Import supports camera scanning after an explicit tap and secure typed/pasted codes. Real AGENT and TERMINAL invitations are checked for the expected kind, canonical 32-byte code, version, published endpoint, future expiry and valid signed sender certificate. PAIR invitations, URLs, mismatched kinds, modified certificates, extra fields, oversized input and malformed encodings are rejected. Typed codes provide no sender identity or verified expiry until host lookup. QR certificate validation alone is not independent trust in a sender.
- Real invitation inspection is read-only. It makes no Relay claim, consumes no invitation, pins no sender, grants no permissions and transmits no account data. The app explains that host sharing support is required. A structurally valid code is not proof it is still available.
- Built-in examples offer an explicit local demo with a native Core Image QR. The distinct `BZZY-DEMO-AGENT-…` / `BZZY-DEMO-TERMINAL-…` codes and `BZZY:DEMO:1:` QR prefix cannot be mistaken for deployed Relay invitations. Demo codes have 32 secure random bytes, ten-minute expiry, explicit revocation, a bounded in-memory registry and single-use redemption on the main actor. They are not persisted, sent to Relay or redeemable on another device. Closing Share keeps a code available so the user can navigate to Import; quitting the app clears the registry.
- The immutable sample registry supplies the definition at redemption. Mutable draft text, private paths, accounts, permissions, messages, memory and runtime data cannot enter demo exports. A preview object cannot substitute a different definition. This internal type is not a proposed Core package schema.
- Review shows instructions and example access requirements. Import creates a fresh local inactive draft, without granted permissions, accounts, schedule activation or sample chat replies. Duplicate names get a numeric suffix. Both agent and terminal drafts persist; later messages belong only to the new conversation. A storage failure rolls back the draft without consuming its code.
- On iOS, Copy writes demo codes to the local clipboard with the ticket's expiration time. Codes are never logged or placed in notifications. Camera failure leaves code entry available. The app never automatically executes imported instructions.

## Actual transfer dependency

`BZZY-CORE/src/relay/gateway.js` now implements the encrypted `bzzy-core` v1 protocol, documented in `BZZY-CORE/docs/RELAY-PROTOCOL.md`. Both gateway metadata and `session.get` advertise `portableSharing: false`. Its allowlist has no export, package transfer, import or invitation administration operations. The current protocol also has no attachment/chunk transfer.

Relay has AGENT/TERMINAL invitation routing and grants, but those alone do not serialize or import an agent/terminal definition. Only an enrolled host can create real invitations; the iPhone must not elevate itself into a host or reuse a PAIR grant as permission administration. The current iOS client does not install the Core application payload handler. No backend changes or unverified end-to-end transfer claims are included here.

To enable real transfers, the host implementation must provide an allowlisted portable definition contract with deterministic validation and credential/data separation; explicit resource/mode/action/expiry authorization; host-issued invitation creation and revocation; recipient/sender trust approval; bounded encrypted transfer with integrity checking; and idempotent inactive import with the recipient's own account/workspace authorization. Live access needs separate recipient/resource/action grants and authoritative revocation. Reuse Core and Relay rather than adding another runtime. Apply the reusable policy and runtime boundaries in `../../SECURITY.md` to future generated behavior.

Until that contract exists, the app deliberately does not redeem real import codes: a claim may consume a single-use invitation even when a later unsupported operation fails.

## Validation

Model checks cover kind isolation, immutable sample definitions, fresh identities, absent history/fake replies, expiry, revocation, single use, registry capacity, restart persistence and rollback after a failed save. Relay unit tests cover real invitation validation and certificate/endpoint/encoding tampering. Native iOS UI checks cover both local share/import flows, Copy/Live access separation, rejection of PAIR codes, the unredeemed real-code state, independent chats and relaunch persistence. Physical camera scanning and transfers between actual hosts/devices remain unverified.
