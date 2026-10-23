# Current production update — 2026-10-23

The actual Debian Relay was upgraded under the authorized operator account to
release `0a568bd17faeb2439805ac5ca78154c031966a65fab31bea6f6c09184000397b`.
The clean self-contained release passed all 24 tests, then passed its checks/tests
on the server as the nonroot `bzzy-relay` account before code activation. Runtime
server SHA256: `523acca9268b81953707d7f861958005175ce9dc98a991aa0b929931681c74f3`.
Local and public TLS health passed; systemd reports the unchanged nonroot service
active. Caddy, firewall, SSH, Node and systemd unit configuration were unchanged.

A consistent stopped-state backup and receipt are retained under
`/var/backups/bzzy-relay/20261023T032622Z-0a568bd17fae/`. Verification returned
`denialsPreserved:true` and `hostEnrolled:true`; the Mac's public certificate is
registered. The code-only rollback package is
`/opt/bzzy-relay.previous.20261023T032622Z-0a568bd17fae`. No old database was restored.
The initial staging-only attempt failed before stopping Relay because the service
user inherited a private root cwd; the final wrapper changes to `/` and includes
a regression for this case. It does not relax process/file permissions.

Actual native Swift -> public Relay -> installed Mac Core pairing, observe-only
session history and typed CPU/RAM passed. Its disposable observer grant was
revoked. Actual public Terminal ZIP transfer also restored files, .bzzy context,
118 events and one historical execution into recipient cwd with fresh IDs and no
active execution/binding/live grant. Local encrypted Agent full-context transfer
and iOS/Core tests pass. A later separate development build was signed, installed
and normally launched on the user's physical iPhone; the user confirmed seeing
BZZY. The user is performing manual pairing. Installation does not establish that
phone's Relay/Core session, background APNs delivery or sustained capacity.
TestFlight/publication is deferred by the user's choice.

The record below describes earlier validation before Mac enrollment and this
production update; its old pending statements are historical.

# Verification record

Local validation on 2026-10-22, macOS/ARM64, Node v24.22.1. The machine's default
Node was v22.22.0; validation explicitly used a Node 24 executable via npm's
temporary package runner. Node was not globally replaced.

```sh
npm exec --yes --package=node@24 --call 'npm run check && npm test && npm run demo && npm run measure'
npm audit --omit=dev
```

JavaScript syntax validation passed. Nineteen real-socket and storage tests
passed. The QR/encryption/revocation demo passed. Dependency audit reported no
known vulnerabilities in the installed dependency set; that result is not a
security audit.

| Boundary | Evidence |
| --- | --- |
| Private content stays outside Relay state/wire | Captured outbound RPC frames exclude a generated private fixture; recipient recovers it exactly; SQLite and audit entries exclude plaintext and raw invitation code |
| Device authentication | Real socket challenge replay on another connection fails; unsupported subprotocol/origin rejected |
| Explicit confirmation | Candidate has no grant before approval; wrong recipient certificate fails before grant creation |
| Single use and lifecycle | Two simultaneous claimants yield exactly one winner; denied/revoked/expired codes fail; offline host cannot redeem |
| Tenant boundaries | Another host and unrelated candidate cannot inspect/revoke a grant; portable recipient cannot become host |
| Durable revocation | Real on-disk SQLite reopen retains consumed code and revoked grant; reconnect cannot restore revoked routing |
| Ciphertext integrity and routing | Modified ciphertext, routing/message ID substitution, stale receiver epoch and duplicate message ID rejected |
| Clock tolerance | Small bounded skew accepted; expired/excessively future messages rejected |
| Reconnect semantics | Reconnect changes endpoint epoch without another application command; stale socket recovery waits instead of taking over |
| Uncertain delivery | No receipt produces an uncertainty event, clears transient state and does not retransmit |
| Bounded state | Delivery cap, device/invitation quotas, request rate, oversized frame closure, finite replay/rate buckets verified |
| Local key handling | Exclusive creation, private modes, symlink rejection, key binding verification and SQLite link rejection verified |
| Sanitized diagnostics | Fixed errors/audit fields do not reflect a supplied private fixture |

The local measurement sent 80 encrypted messages carrying 327,680 application
bytes with five sockets (one host, four recipients). One observed run completed
in 84 ms with approximately 83.6 MiB RSS for the server **and all endpoints in
the same process**, and no pending receipts after delivery. Measurements are
sampled after receipts, not continuous queue/memory peaks. There was no TLS proxy,
network latency, sustained load or on-disk payload storage in that run. These
numbers do not predict the intended 2 GB/1 vCPU VPS's production capacity.

## Deployment status

Deployed on the authorized Debian 13 x86_64 VPS using SSH port 36716. Runtime:
Node v24.22.1, Caddy v2.11.7, dedicated non-root bzzy-relay service. The 19 tests,
demo and local measurement also passed natively there as an unprivileged user.
The VPS smoke measurement delivered 80 messages in 649 ms, sampled approximately
89.5 MiB RSS including server and five endpoints, and left no pending receipts.

Public endpoint: wss://190.114.255.214/v1/socket. Ordinary external TLS validation
passed with a Let's Encrypt IP-SAN certificate; Caddy manages renewal. External
Node endpoints completed 20 encrypted deliveries and verified recipient
confirmation, cross-device denial, single use, opaque wire payloads, replay
rejection, reconnect, pairing/agent/terminal purpose distinctions, code expiry
and revocation. A full VPS reboot into kernel 6.12.113+deb13-amd64 preserved
startup, firewall rules, TLS and consumed/revoked state. All disposable registered
devices were subsequently revoked; the installation has zero active device
registrations and awaits enrollment of the user's actual home-host public key.

The source/templates also target Ubuntu Server 24.04 LTS. All 19 tests and the
demo passed under unprivileged official Ubuntu Base 24.04.5 userspace, inside
separate PID/mount namespaces on the Debian kernel. The initial minimal rootfs
lacked /proc and could not provide RSS metrics; mounting its own proc filesystem
resolved the test-environment issue. No product workaround or weakened check
was added. This is not a separate Ubuntu VM/systemd/TLS boot verification.
macOS server support is not required; no macOS deployment adapter is shipped.

Verified operational controls include loopback-only Relay listener, BPF service
IP restriction, non-root processes, 0700 state directory/0600 database, private
Caddy UNIX administration socket, no Caddy environment dump, service resource
limits, capped isolated journal and synchronized time. See the deployment templates in `../deploy/`.
Certificate issuance/configuration and reboot persistence were verified;
an entire future automatic-renewal cycle and sustained capacity were not observed.

Native iOS crypto/pairing, Core gateway integration, portable package validation,
true end-user remote execution/import and long-duration/ARM64 capacity remain
unverified or unimplemented. The current Core and iOS READMEs describe those integration dependencies. Static-key encryption has no
forward secrecy/ratchet, and there has been no independent protocol/security audit.
VPS hardening and passing tests do not certify that remaining application work.

This historical Relay validation preceded the shared Core extraction. Current
implementation guides and SECURITY.md supersede the removed planning notes.
