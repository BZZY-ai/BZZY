# Goal workflows

A workflow is a reusable set of goal instructions: preparation, methods,
evidence requirements, reporting conventions and stop conditions. Core stores
project and global definitions independently of the selected model. The text
does not grant tools, account access, network scope or execution permissions.

Open **Workflows / pre-prompts** from Skills or Agents Library, or type
`/workflows` (`/workflow` is an alias). Create instructions manually or load a
UTF-8 text file, inspect the result and select it for this conversation.
Like `/models`, choosing a name selects it directly. Exactly one workflow can be
selected; **None** clears it. The picker marks the selection and the chat status
shows its name. Creating, loading or selecting starts no model work.

The selection belongs to this terminal session across reopening, alias changes
and model changes. Other sessions in the same directory keep their own
selections. Global definitions are available across projects; project definitions
stay within their original project directory.

## Starting a goal

For a new `/goal`, Core prepares the goal, resolves the selected workflow and
loads its complete text before queuing model work. The goal pins an immutable
content version and the full contract context. That context reaches the provider
as goal instructions and enters the existing mission briefs used by Delegate,
specialists, Parallel/Besties and linked Validate reviews.

This supplies the instructions before the model's first action. It does not
establish that a model understood or completed every step: evidence, permissions,
declared acceptance criteria and completion checks remain authoritative.
Enabled skills and agents remain available when relevant; Metrics counts their
actual loads and admitted invocations normally.

Editing, deleting or clearing the Library selection affects future goals.
Existing goals resume with their original pinned version. Older goals without a
workflow keep their saved instructions. A deleted or unavailable selection blocks
a new goal with an explicit error instead of silently omitting the workflow.

Core verifies the binding again before dispatch. Missing or changed versions,
goal identity or pinned context cannot start a model under a different workflow.
Queued requests and retries retain their original admission. Ordinary chat does
not apply the selected workflow as a new goal instruction.
Known model context limits are checked conservatively before queueing and
dispatch; an oversized workflow is rejected rather than shortened. A new goal
records a compact `Workflow loaded` notice after the full text is admitted.

## Storage and boundaries

Definitions have strict schemas, revision checks and immutable versions. Effective
text, including Core's mandatory security instructions, is bounded to 128 KiB.
Oversized or invalid input is rejected without truncation. File loads accept
regular UTF-8 files and reject links, private authentication/Core stores, changing
files and recognized credentials or private account addresses. Use approved
private host references for account bindings.
Literal `<approved-private-host-reference>`, `${AUTHORIZED_ACCOUNT}`-style
uppercase environment references and `[redacted]` may describe bindings without
containing them. They are not expanded or resolved by loading a workflow. Text
requiring mission redaction is rejected explicitly so worker handoffs cannot
silently lose workflow instructions.

Referenced files, tools, scripts and placeholder variables remain instructions
to assess within the real task context. Loading text does not install tools,
execute commands or supply an account. The reference pre-prompt used to design
this feature is not a bundled default.

Definitions, per-session selections and goal admission receipts stay in private
Core storage. Project/share imports do not restore these live bindings or
execution receipts. A saved goal's full instructions may remain historical
conversation data; they cannot establish a new workflow selection or permission.

For owner automation, `bzzy workflows list|show|create|import|update|delete`
manages definitions. `selection|use|clear` with `--session` manages a terminal's
future-goal selection. Changes require their shown revisions; `use` can also pin
the definition revision inspected before selection.
