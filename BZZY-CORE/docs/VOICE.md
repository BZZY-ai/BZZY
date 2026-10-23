# Voice conversations

iOS **Talk to BZZY** is a text-free voice surface for Core's own assistant. Apple
on-device Speech recognizes the held microphone input, a local FFT displays 64
frequency bands smoothed at display cadence, and AVSpeechSynthesizer speaks replies.
The user's deliberate release stops capture and sends the final recognized text
after a brief finalization window (up to 650 ms), without another Send tap.
Core and Relay receive text, never audio. Permission cancellation, recognition
failure, navigation, backgrounding and reconnect never send a recording. Failed
recognition/dispatch can leave an explicit retry arrow. The regular chat composer
retains its separate editable dictation flow and explicit Send button.

Core must have an explicit coordinator selection (`bzzy-core assistant set` or
the Core secondary settings screen) and a managed folder (`bzzy-core workspace
set` or CLI's Default BZZY folder). CLI chat defaults stay independent. Providers
continue to authenticate privately on the host through existing adapters. No
provider keys, owner tokens, arbitrary model selections, paths or runtime options
are accepted from the phone.

iOS Settings has independent English/Spanish listening (STT) and speaking (TTS)
preferences. Both voice mode and chat dictation use the listening selection;
Apple's speaking voice and safe spoken notices use the speaking selection.
Model replies continue to follow the conversational language instructions.
Readiness validates the actual pinned folder before enabling capture. New macOS
folder pins include the filesystem volume UUID, so a verified device-number
change after remount does not itself revoke the same directory/inode. Changed
directories, volumes and unverified legacy pins still require host confirmation.

## Encrypted operations

| Operation | Parameters | Result |
| --- | --- | --- |
| `voice.status` | `{}` | Configuration readiness only; creates no context or execution |
| `voice.send` | `text` | Durable acceptance bound to the request ID |
| `voice.poll` | `requestId`, optional `cursor` | State and paginated plain speech for that turn |
| `voice.cancel` | `requestId` | Requests pause of that turn; does not cancel a newer response |

These operations require the live, fully approved own-phone base grant: all
session permissions, terminal catalog, Agent management and sharing permissions,
matching host/device pin, unexpired narrow Core access and no revocation. Scoped
friend, terminal-child, observer and Agent grants cannot use this surface. Voice
does not depend on enabling remote host installation.

Core selects or reuses a private voice context per device/grant, assistant revision
and managed-root pin. It snapshots Core's selection and issues a session-only
execution token internally. That token and context resource are not returned to
the phone. Changing defaults starts a new conversation on the next explicit send.
The selected terminal or persistent Agent remains unchanged. Contexts use existing
trusted native coordinator policy, not the persistent Agent sandbox; this feature
adds no new account connector, schedule, permissions or confinement guarantee.

## Acceptance, output and recovery

Core saves a request fingerprint and turn metadata before dispatch, then uses a
stable execution/answer idempotency key. Repeating the same accepted request
returns its original receipt; changing its input conflicts. An uncertain request
is reconciled from Core's durable acceptance journal, never automatically sent
again. Input leases and the normal execution queue still apply. Voice sends and
Stop are serialized per private context. Revocation and workspace pins are
rechecked around asynchronous attachment/claim operations.

Replies are projected from original durable text events using the canonical body
parser. The first question or execution-finished event pins a turn's output range;
later replies cannot enter a repeated poll. A spoken answer to a pending question
uses Core's existing answer path and continues its execution. Replies are bounded
to 2 MB before projection and paged to 6,000 UTF-8 bytes without splitting Unicode
characters. Cursor bounds, operation shapes and response types are validated.
`finished` means execution ended; replies retain `verification: not-assessed`.
Speech or formatting is never evidence that an action succeeded.

The phone persists only host/grant/request identifiers for a pending turn. Closing
or backgrounding cancels recording, playback and local polling; it does not replay
or implicitly cancel accepted work. Reopening/reconnecting only reads readiness
and receipts. Stop explicitly requests Core pause. Unknown acceptance is retained
until a read establishes a result; the client does not manufacture a successful
send or stop. Failure notices are spoken from fixed safe messages rather than
reading private provider error output aloud.

## Validation scope

Offline tests cover Core-default selection, no-inference readiness, idempotency,
lost acceptance, Unicode pagination, question continuation, output boundaries,
revocation, root changes, scoped-client rejection, grant rollback and Stop safety.
A real local encrypted Relay/Core execution test uses an isolated provider fixture.
Native checks cover the FFT with synthetic tones and the strict wire contract.
iOS UI checks open the text-free screen without requesting microphone access.
These tests do not establish physical microphone accuracy or audible TTS quality;
those remain manual device checks.
