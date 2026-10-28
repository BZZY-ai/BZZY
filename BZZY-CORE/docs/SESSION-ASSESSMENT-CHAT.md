# Read-only Core Chat

Core Chat answers questions about saved terminal sessions and their goals. It is
separate from ordinary terminal chat and voice execution. A question can request
an assessment; it cannot create, run, resume, pause, cancel, steer or change a
terminal, claim input, answer approvals, browse a project or contact a target.

Only the fully approved own-phone base pairing can use this surface. Core
rechecks the private device pin, exact host/resource identity, all pairing
permissions, underlying access, expiry and revocation. Scoped friend, observer,
derived terminal and persistent-Agent resources are rejected. Relay transports
the encrypted request and response; it receives no provider credentials.

## Model and input

Each explicit question pins Core's independently configured assistant selection.
An existing terminal supplies only the restricted document runner's source
scope and private backend authentication reference. Core prefers the pairing's
base terminal; if it was deleted or is unavailable, the full own-phone catalog
grant permits selecting the most recent eligible aliased root terminal from the
bounded inventory. The accepted turn pins that exact source ID and scope. A
source deletion or scope change interrupts it rather than switching to another
terminal mid-answer. With no eligible source, sending fails safely and creates
no terminal. Configuration status still describes the Core model setup only.
The runner creates a separate
internal document context in an empty private working directory, with the
verified no-tools learning profile, disabled network and no writable project
paths. A prompt that merely asks an ordinary coding assistant to be read-only
would not enforce this boundary. This feature reuses the restricted runner.

For every question Core reads a fresh allowlisted database inventory of at most
50 recent aliased root terminal sessions, with an overall 72 KiB JSON budget.
It includes aliases, bounded directory/model metadata, saved execution state,
the latest recorded execution, goal objective/status/reason and historical
acceptance/validation labels. Coverage explicitly reports truncation and a lower
bound on omitted sessions. Full transcripts, specialist details, tool results,
project files, account bindings, process inspection and evidence verification
are excluded. Up to eight completed turns of this same host/device/grant's own
Chat supply bounded follow-up context. Other devices' Chat turns are excluded.

Questions, inventory text and prior answers are untrusted data. They cannot
change the execution profile or authorize actions. Fresh inventory takes
precedence over old answers. A finished execution is separate from a completed
goal; `complete` means recorded achievement, `verifying` is unfinished, and
imported achievement remains historical. Acceptance can have the weaker
`legacy-model-judgment` level. Validation records are labeled as historical and
not rechecked. An assessment cannot award a verification badge or establish a
vulnerability's truth.

## API and durability

| Operation | Parameters | Result |
| --- | --- | --- |
| `chat.status` | `{}` | `{configured, readOnly: true}`; starts no inference |
| `chat.send` | `text` | `{state: "accepted", requestId}` using the envelope ID |
| `chat.poll` | `requestId`, optional `cursor` | `state`, raw `text`, next `cursor`, `hasMore`, `observedAt`, `verification: "not-assessed"`, optional safe error `code` |

Input is nonempty text up to 16,000 UTF-8 bytes. No provider, model, path, owner,
tool, goal or control parameter is accepted. Poll pages contain at most 6,000
UTF-8 bytes and advance by JavaScript string length (UTF-16 units); pages retain
the exact original reply body. Total output is limited to 32 KiB. States are
`queued`, `running`, `finished`, `failed`, `uncertain` and `unknown`.

Core commits a private request fingerprint and turn before accepting it or
starting provider work. Identical retries return that receipt; changed input
with the same ID conflicts. Replies persist independently of phone connectivity.
The host grants at most one active Chat turn per pairing and four per gateway.
The restricted runner keeps a 90-second deadline. Its token allocation covers
the UTF-8 byte count of the bounded question/inventory/context and task
instructions as a conservative input estimate, plus 8,192 tokens of native
overhead and 32,768 tokens of output headroom, within the document runner's
200,000-token ceiling. This avoids rejecting a permitted large input merely
because its input tokens already exceed a fixed small allocation. The accepted
question is never shortened. The separate 32 KiB output limit still applies.
An allocation reserves execution headroom; it is not a claim that those tokens
were used or an instruction to spend them. Reported usage remains the backend's
actual receipt. These bounds are not an exact billing guarantee.

Startup failures return a fixed actionable code through the existing `code`
field, preserving compatibility with strict clients. Only Core's trusted
adapter-created startup receipt can select these categories; provider text and
arbitrary error properties cannot impersonate them. Raw messages, stderr,
arguments, environment values and provider responses are not included.

| Code | Meaning |
| --- | --- |
| `CHAT_BACKEND_VERSION_CHECK` | Core could not verify a compatible backend version; this can include a missing executable |
| `CHAT_BACKEND_CONFIGURATION` | Backend/provider configuration could not be prepared; this is not proof that an API key was rejected |
| `CHAT_BACKEND_PROCESS_START` | The configured backend process could not start |
| `CHAT_BACKEND_INITIALIZATION` | The process did not complete its initial protocol handshake; the category alone does not establish why |
| `CHAT_BACKEND_PERMISSION_PROFILE` | Core could not confirm the required isolated no-tools profile |
| `CHAT_BACKEND_PERMISSION_ACTIVATION` | The backend did not confirm activation of that exact isolated profile |
| `CHAT_BACKEND_THREAD_START` | A restricted document thread could not be started or restored |
| `CHAT_BACKEND_BUDGET` | The backend rejected budget admission before a model turn |
| `DOCUMENT_BUDGET` | The restricted document runtime, token or output bound was reached |
| `CHAT_FINALIZATION_FAILED` | Generation completed but trusted host cleanup/finalization failed; no answer is exposed |

Cleanup attempts preserve an earlier model/startup failure and its trusted
receipt instead of replacing it with a close, state-save or directory-removal
error. All cleanup phases are attempted; only a fixed first failing phase is
stored privately. A cleanup failure after successful generation fails closed,
using a module-private host receipt for `CHAT_FINALIZATION_FAILED`; an arbitrary
error property cannot claim that category or pre-request zero usage.

The iPhone preserves a failed question's support code across readiness refreshes.
Those refreshes neither resend the question nor change a terminal goal.

These failures start no unrestricted fallback. Unknown adapter failures remain
`CHAT_UNAVAILABLE`; configuration status still means that a model selection was
saved, not that a live provider request was verified. The existing own-phone
`chat.poll` route checks the saved turn without SSH or another inference.

Gateway restart marks an interrupted turn uncertain when inspected, without
resubmitting it. A new explicit question needs a new ID. Operator stop, gateway
close, source-scope changes and revocation interrupt the assessment; revoked or
late interrupted output is discarded. No terminal execution, input lease,
goal, session permission or evidence record is changed by the assessment. Own
Chat records and the runner's internal document context remain private Core
state and are not portable permission or completion evidence.

Local fixture tests cover authorization, prompt-injection containment through
the restricted runtime, saved-state distinctions, paging, retry/restart,
revocation, operator stop and encrypted Relay routing. They do not establish
live provider billing, physical-phone behavior or current evidence correctness.
