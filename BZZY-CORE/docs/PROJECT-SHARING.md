# Complete-context Agent and terminal sharing through Relay

Both execution hosts need Node.js 24+ and `python3` on Core's process PATH.
Python's standard-library ZIP helper performs packaging and bounded extraction;
no Python packages or separate runtime service are installed. The CLI installer
provides Node/Core launchers but does not install system Python.

Sharing exports the selected terminal's actual project directory and its allowed
saved BZZY context/history into a private ZIP on the source Core host. The
recipient imports that copy into the recipient terminal's current directory.
Agents use a strictly typed `AGENT` package instead: iPhone requests receipt on
its paired recipient Core, which creates a fresh directory beneath its configured
managed root's `Agents/` folder. CLI remains terminal-only.
This is an explicit full project/context copy. Review it before sharing; history
and ordinary project files can contain private information. Provider accounts,
host identities, credential stores, private bindings and unsafe host records are
excluded or rejected by the strict shared archive policy.

Known credential files, raw Git metadata and shell startup/direnv files are
excluded with an inventory. Embedded known keys/private-key/token patterns block
export. These checks cannot prove arbitrary project data secret-free; review
the selected full context. Sensitive/system import destinations, symlink escapes,
hardlinks and conflicting recipient files are rejected. Imported goal completion
remains historical and cannot generate a fresh completion push merely on rename
or settings changes; an explicit local goal execution starts revalidation.

Use a `BZZY-TERMINAL-...` code or the matching `BZZY:INVITE:1:...` QR payload.
Neither is a URL. Compare both full device fingerprints through a trusted
channel. The source explicitly approves the recipient; the recipient separately
confirms the source fingerprint. The source must remain online.

The source service uses Core's existing Relay socket and libsodium authenticated
encryption. Relay sees routing metadata, never the plaintext ZIP. It stores no
project archive. The transfer has a versioned `bzzy-project-transfer` payload,
bounded manifest and sequential 16 KiB chunks. The recipient checks canonical
encoding, offsets, exact lengths and the final SHA-256 before the stricter ZIP
parser can materialize any file. Imported sessions remain inactive and marked
untrusted; no model, schedule, script or hook starts automatically. Review the
restored project and authorize any subsequent execution.

The host facade exported from `@bzzy/core/relay` is `CoreTerminalSharing`, with
`start`, `createShare`, `status`, `approveShare`, `revokeShare`, and `close`.
`close` detaches the terminal; Core owns an approved transfer. The standalone
`importTerminalShare` function uses a disposable recipient identity, an explicit
trusted source fingerprint, progress callbacks and cancellation. It delegates
archive validation/materialization to `importSharedProject`.

iOS source operations require a separate, explicit host pairing choice,
`shareAccess: true`. Execution and terminal catalog permissions do not imply
file export. `share.create`, `share.status`, `share.approve` and `share.revoke`
are bound to the exact paired device and Core resource. Raw codes and QR values
are held only in the live source helper and transient responses. Durable command
records contain a share ID, never the code. Source daemon restart invalidates
the transient invitation view; it never silently creates another share.

Current bounds are 256 MiB per ZIP, four outstanding offers and one approved
transfer at a time per source host. Reads are paced to at most sixteen 16 KiB
chunks per second. Codes expire in at most ten minutes; an approved portable
transfer grant expires in at most one hour. Expiry, cancellation and Core
shutdown remove the private prepared ZIP. Cancellation cannot recall a copy
already received by an authorized recipient.

Relay must be updated alongside Core for these transfer limits. The updated
Relay permits a separate budget of 4,096 RPCs per minute only for an active
`TERMINAL` or `AGENT`/`portable`/`import` grant's authenticated participants and only for
`grant.inspect`, `route.send` and valid `delivery.ack` operations. Authentication,
invitation enumeration/claims, unrelated grants and guessed IDs keep their
existing rate limits. Frame, connection, queue, concurrency and metadata quotas
remain bounded. Older deployed Relay versions do not support the one-hour
portable transfer lifetime; a working small pairing test does not establish
compatibility with project ZIP transfer.

Automated tests cover an actual encrypted multi-chunk ZIP transfer and strict
import of files, `.bzzy` context and canonical rich history; separate sharing
authorization; code exclusion from events/journals; fingerprint approval;
cancellation; expiry cleanup; and corrupt-chunk rejection before extraction.
These are local real-protocol tests, not evidence that a deployed Relay or a
physical iPhone has been upgraded.

## Portable Agents

Agent copies use `BZZY-AGENT-...` codes or signed QR payloads. Kind is checked in
the invitation/grant, transfer manifest and ZIP manifest; an Agent cannot be
imported as a terminal or vice versa. `importProjectShare` accepts AGENT only
with a trusted Core Agent archive importer. Source sharing requires both explicit
`shareAccess` and `agentAccess` on the parent pairing plus a registered Agent
child context. Receive jobs require `agentAccess` on the base pairing resource.

Exports include the registered name/instructions, project files, `.bzzy` notes,
the complete true descendant session tree and allowed memory/issues/evidence/
history records. A separately imported copy's provenance never brings that
copy's private conversations into the source export. Source filesystem roots
become virtual portable roots. Imports create new Agent/session/context IDs,
detach native threads and apply the recipient's explicitly chosen provider/model/
effort to every restored session. The Agent definition and history commit in one
transaction. Provider endpoints, authentication, bindings, grants and input leases
are not imported. Historical verified claims stay historical; active goals are
paused. Receipt never starts execution, dependency installation or schedules.

The recipient compares the full source fingerprint before submitting a code;
there is no unauthenticated code-only fingerprint lookup. A QR supplies its
signed certificate for comparison. The source separately approves the disposable
recipient fingerprint displayed by the receive job. Review the full-context and
inactive-import conditions before selecting Receive on Core.

`agents.import` starts a bounded ephemeral job; `agents.import.status` reports
approval/download/import progress, and `agents.import.cancel` aborts unfinished
work. Codes and QR values stay in process memory and transient encrypted requests.
Durable command receipts contain only IDs and a request digest. Permission loss,
Core shutdown, cancellation and a changed managed-root pin abort unfinished work.
A successful atomic registry commit wins a racing response failure and reports
complete. Restart discards unfinished jobs and never redeems their codes again.
Completed Agents expose `importId` through discovery for safe reconciliation.
The host allows two active receive jobs globally, one per exact pairing resource,
and retains at most 32 live receipts. Completed local imports are paused trusted
registry entries; authentication of the source does not make imported code safe.
