# Share the BZZY Library between hosts

Use an expiring Relay code to transfer **skills, specialist agents, workflows
and saved goal text** from a Mac to another BZZY Core, including Linux. This is
an independent copy using the recipient's own models and accounts. The existing
full-session transfer is described in [project sharing](PROJECT-SHARING.md).

Both hosts need updated Core/CLI, Node.js 24+ and Python 3.9+. The Relay operator
must also deploy this version: it adds the typed `LIBRARY` invitation kind. Older
Relays return an update-required error. Old PAIR, AGENT and TERMINAL codes and
existing iPhone connections remain compatible.

## Terminal flow

On BZZY 1, open **Skills**, **Agents**, **Workflows** or
**Goals → Export**, check names, then choose
**Export**. The private screen displays **EXPORT CODE** and a **Copy code**
button. Click it or press **C**; no Enter is required. Native clipboard success,
terminal clipboard requests and copy failures have distinct feedback.

On BZZY 2, open the matching tab's **Import → ENTER CODE** and paste. BZZY shows
connection/authorization, a download bar based on actual received bytes, package
integrity checks and installation. It installs/enables only missing definitions
and lists only newly installed names. Existing names and ON/OFF states are
preserved. No second selection or manual fingerprint entry is needed.
Goals and Workflows also open from their top-bar tabs. Bare `/goal` is a quick
picker of manually saved/imported objectives; `/goal <objective>` executes without
auto-saving a Library entry. Goals offers **Save new goal** and **Save current
goal** explicitly. Execution history stays durable separately and is excluded
from goal exports. Saved-goal Import is available even with an empty list. Goal labels show readable
objective text; same-label exports have a short identity suffix. Only objective
text is transferred, with no old goal outcome or evidence. Workflows keep their
project/Core scopes, and importing them does not change the selected workflow.

The source Core must remain online; leaving the export screen keeps the code
alive for up to ten minutes. **Revoke code** cancels it. A code is single use and
carries only the sender-selected immutable Library archive. Both hosts need the
current Core/CLI. The existing Relay's LIBRARY support is sufficient; this code
approval mode does not add a Relay server operation.

To move the complete Library to a new installation, open **Settings → BZZY Core
→ Export Library**. A single name list starts with all four kinds selected,
including OFF definitions in the current project and Core/global Library.
Types and scopes distinguish matching names, and saved goals show objective text.
Uncheck any entries to omit them, then choose **Export → Copy code**. On the
recipient, **Settings → BZZY Core → Import Library** uses the same paste-once
flow as the individual tabs and shows newly installed names on return to Settings.
Existing definitions and ON/OFF choices survive; new skills/agents install enabled.
Other projects, chat history and private account settings are excluded.
Receiver policy failures identify the validated entry, fixed reason and safe
resource file/line when available. Settings retains long details in its scrollable
content. Matched values and unsafe resource names are excluded from diagnostics;
archive/hash failures retain a generic integrity error. Failed transfers require
a fresh export code.

Combined transfers also use `/library`, `/library share` and `/library import`, or:

```sh
bzzy library share agents skills
bzzy library import
```

Source type/file review remains available for combined exports. New CLI exports
use the same paste-once codes. `/import` routes Library and full-session codes.
Legacy Library codes and invitation QR protocol text still work through
`/library import` with their previous review/fingerprint flow. The four libraries'
Import buttons request a new export when given an obsolete code.
Full-session transfers retain their separate explicit approval. No share URL is
created, and no model, script, hook, goal or specialist starts during import.

## Code authorization

A versioned `BZZY-LIBRARY-2.…` code contains the Relay token, sender fingerprint,
a separate Core-generated 256-bit secret and the immutable ZIP hash. The secret
never enters Relay invitation metadata. A recipient proves possession inside the
encrypted connection, bound to its exact grant, identity and archive. Before that
proof, even a Relay token holder cannot read the manifest or a byte of the ZIP.
The sender certificate and archive must match the code's pins. Provisional grants
expire after 15 seconds; authorized transfers retain their bounded transfer TTL.
Only portable/import authority is issued, with no pairing, execution or live
session access. The current source approval mode is an explicit local-owner
option; existing remote sharing and full-session approval contracts are unchanged.

Core queues concurrent code claims behind its bounded active transfer. Stop,
revocation, expiry and shutdown during approval prevent late grants from reviving
released archives. The capability is kept only in the private screen/clipboard;
it is never a chat message, logged command or package resource.

## Contents and difference rules

The source includes the selected types of current-project and global skill, specialist-agent and
workflow definitions, with complete skill resources. Goals include the owner's
retained terminal objectives and imported goal templates, deduplicated by exact
trimmed text. They carry no chat, source path, outcome, evidence, contract,
budget, permissions or workflow admission receipt.

The receiver installs only missing entries. Skill, agent and workflow names are
compared within their kind and project/global scope. Existing names are skipped
even when contents differ; existing enable/disable decisions are retained. Goal
objectives already in terminal history or templates are skipped. Project entries
map to the receiving directory; global entries remain global. Specialist agents
inherit the receiving chat's provider/model/effort.

Credentials, account bindings, host paths and private case/evidence resources
cannot enter portable definitions. Blocked skills, agents and workflows show a
safe reason and resource file/line when available, without exposing matched
values. The sender can explicitly omit those whole entries and review the rest.
Their exact identities, revisions and versions are pinned through archive creation.
Unsafe goals retain the separate explicit omission flow using safe IDs. Nothing
is silently stripped; unselected types are never scanned or copied.
The name-checkbox exports, including **Settings → BZZY Core → Export Library**,
use these same diagnostics. After explicit omission, only the remaining original
selection enters the export code. A change to an originally selected entry,
including one just omitted, requires reopening Export. New catalog entries never
join that selection automatically. If nothing remains, no code is created.
Credential checks distinguish ordinary authorization prose and runtime references
inside Python resources from literal bindings. Fixed account addresses, quoted
credentials, private host paths and private resource packages still block both
export and import. Scanner results supplement review; they do not prove arbitrary
code or text contains no private information.
Use the full-session flow for the selected project's private history.

Private host-root checks match complete absolute path tokens. Relative inputs
such as `00-scope/roots.txt` and `00-scope/root/hosts.txt` remain portable when
the recipient runs as Linux root; they do not reference the private `/root`
directory. Actual absolute private paths still block import.

## Integrity, retry and limits

The manifest pins every file's size/hash, definition version, scope and source
inventory. The source rechecks that inventory before publishing; the receiver
rechecks the package and destinations before commit. Strict ZIP validation
rejects links, traversal, duplicate/extra files and excessive sizes. Registry
changes, availability audits and a durable receipt commit atomically; failures
roll back new package directories. An accepted archive retry returns its recorded
result without recreating deleted entries or overriding later owner choices.
New shares compare the current destination again. Name-based export pins exact
source identities/revisions before preparing the code. Selective import validates
the complete archive, binds selected indexes to its immutable review and checks
only those destination entries at commit. Each selected subset has its own durable
receipt; retries cannot re-enable entries or recreate later deletions.

Bounds: 1,024 definitions, 4,096 archive entries, 1 MiB per resource, 60 MiB payload
and a 64 MiB ZIP. Existing v1 skills/agents ZIPs keep their previous limits and
behavior. Codes last at most ten minutes; new Library codes authorize a single recipient through the proof described above.
Grants allow portable import only, with no execution, pairing or live observation.

Relay transports encrypted chunks and cannot read the archive. Library source
completion means the recipient committed its reviewed import; an accepted commit
survives a lost completion acknowledgment. Cancellation, revocation and expiry
are checked before commit. Completed copies remain with their recipient. Core
owner credentials and account authentication never travel with a bundle.

Local tests use a real Relay and independent Core homes, including a separate
recipient process. They do not establish that a deployed Relay or Linux host has
already been updated, or prove arbitrary text free of every private detail.
