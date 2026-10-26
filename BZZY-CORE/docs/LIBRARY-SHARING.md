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

On the Mac, from the source project:

```sh
bzzy library share
```

Choose the types to include using Space and Enter, then review the bundle and
select **Create expiring Relay code**. To share only agents and skills directly:

```sh
bzzy library share agents skills
```

The private screen
shows a `BZZY-LIBRARY-…` code, source fingerprint, expiry and recipient requests.
Keep the Mac online. `c` copies the code; `a` approves the exact recipient after
comparing its full fingerprint with the receiving terminal.

On Linux, from the receiving project:

```sh
bzzy library import
```

Paste the code into hidden entry and compare the source fingerprint. The Linux
terminal shows its recipient fingerprint for approval on the Mac. After the
encrypted download, review the exact files and destination conflicts. Select
**Install missing & enable reviewed skills/agents**, or install them disabled.
Workflows remain unselected and goals remain saved text in `/goal`. Neither
choice starts models, agents, scripts, hooks or dependency installation.

Inside BZZY, `/library` opens the same controls. `/share library` shares the Library;
`/library import` receives it. `/import` accepts Library and full-session codes,
asking for hidden entry when no code is supplied. Skills and Agents tabs keep
plain Import/Export controls for their own ZIP types; Relay transfer uses these
chat commands. QR invitation text is supported
as protocol text; no invitation URL is created.

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
Credential checks distinguish ordinary authorization prose and runtime references
inside Python resources from literal bindings. Fixed account addresses, quoted
credentials, private host paths and private resource packages still block both
export and import. Scanner results supplement review; they do not prove arbitrary
code or text contains no private information.
Use the full-session flow for the selected project's private history.

## Integrity, retry and limits

The manifest pins every file's size/hash, definition version, scope and source
inventory. The source rechecks that inventory before publishing; the receiver
rechecks the package and destinations before commit. Strict ZIP validation
rejects links, traversal, duplicate/extra files and excessive sizes. Registry
changes, availability audits and a durable receipt commit atomically; failures
roll back new package directories. An accepted archive retry returns its recorded
result without recreating deleted entries or overriding later owner choices.
New shares compare the current destination again.

Bounds: 1,024 definitions, 4,096 archive entries, 1 MiB per resource, 60 MiB payload
and a 64 MiB ZIP. Existing v1 skills/agents ZIPs keep their previous limits and
behavior. Codes last at most ten minutes and require fingerprint approval.
Grants allow portable import only, with no execution, pairing or live observation.

Relay transports encrypted chunks and cannot read the archive. Library source
completion means the recipient committed its reviewed import; an accepted commit
survives a lost completion acknowledgment. Cancellation, revocation and expiry
are checked before commit. Completed copies remain with their recipient. Core
owner credentials and account authentication never travel with a bundle.

Local tests use a real Relay and independent Core homes, including a separate
recipient process. They do not establish that a deployed Relay or Linux host has
already been updated, or prove arbitrary text free of every private detail.
