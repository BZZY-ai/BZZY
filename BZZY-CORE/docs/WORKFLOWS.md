# Goal workflows

A workflow is a reusable set of goal instructions: preparation, methods,
evidence requirements, reporting conventions and stop conditions. Core stores
project and global definitions independently of the selected model. The text
does not grant tools, account access, network scope or execution permissions.

Open the **Workflows** top tab to create instructions manually, load a UTF-8
text file, inspect or edit definitions. Bare `/workflow` opens a quick dropdown
like `/effort`; choosing a name selects it directly for this terminal. The old
plural `/workflows` slash command is removed. Exactly one workflow can be
selected; **None** clears it. The picker marks the selection and the chat status
shows its name. Creating, loading or selecting starts no model work.

**Import** accepts an expiring Relay Library code and installs only missing
workflow names in their project/Core scopes, with download/check/install progress.
**Export** opens a name-only checkbox table, then generates a code with a Copy
button. These use the same [Library transfer](LIBRARY-SHARING.md) as skills and
agents. Existing workflow names and the current selection stay unchanged during
import. **Load workflow from a text file** continues to load local UTF-8 text.

The selection belongs to this terminal session across reopening, alias changes
and model changes. Other sessions in the same directory keep their own
selections. Global definitions are available across projects; project definitions
stay within their original project directory.

Use `bzzy --workflow NAME` to select at launch, or combine it with
`--attach NAME` or an explicit new `--goal`. `--workflow none` clears selection.
New chat/task creation validates the requested definition before creation;
request-ID retries return the original accepted task without repinning it.
Read-only view and goal-resume commands reject selection overrides.
Right-click/F10 on a workflow row opens its removal action. Existing goal
versions survive removal; a selected removed definition becomes unavailable
for future goals until None or another workflow is selected.

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

### Version 2 structured consultation

Existing text-only definitions and goal pins retain their exact version and
advisory behavior. An owner can create a new definition with `schemaVersion: 2`
and explicit routing metadata:

```json
{
  "name": "fixture-review",
  "description": "Review a supplied offline fixture.",
  "instructions": "Preserve the original scope and evidence.",
  "schemaVersion": 2,
  "routing": {
    "version": 1,
    "requireWorkUnits": true,
    "rules": [{
      "classId": "request-forwarding",
      "specialist": "http-analyst",
      "skills": [],
      "reportSkills": ["report-format"],
      "allowedDispositions": ["blocked", "not_applicable"]
    }]
  }
}
```

Routing is bounded to 64 distinct classes and 16 KiB. Each rule requires a named
specialist or skills. Names are scoped Library names, not scripts, tool grants or
private account identifiers. `skills` applies to investigated outcomes;
`reportSkills` additionally applies to `confirmed`. The only bypass dispositions
are `blocked`, `not_applicable` and `policy_excluded`, and each must be explicitly
allowed in the pinned rule. There is no model-selected blanket bypass. Loading
a `.json` workflow file validates the complete definition; ordinary UTF-8 files
remain text-only workflows. Library codes preserve the structured contract.

For a v2 goal, `declare_work_unit` records one bounded hypothesis, classId,
optional scoped artifact IDs and a stable requestId. Core pins the currently
enabled specialist/skill versions and records missing or disabled dependencies.
The supervisor reads the admitted specialist, passes `workUnitId` to
`spawn_subagent`, and retains one assignment per unit. Existing bounded worker
policies, reservations, idempotency and evidence review still apply. Definitions
cannot grant new permissions. Changed definitions require a distinct new unit;
they never replace a running unit's pins.

`close_work_unit` requires an outcome and factual rationale. Investigated,
confirmed, disproved and inconclusive outcomes require the exact matching
specialist, its current-round accepted evidence review and the rule's complete
SKILL.md consultations. Full skill-read receipts track delivered byte coverage
and are distinct from invocation metrics; neither receipt proves attention or
semantic correctness. A generic Delegate worker, older goal receipt or different
specialist cannot satisfy the route. A permitted blocked/excluded/not-applicable
closure records a coverage limitation rather than a finding. Blocked units do
not count as covered and prevent achievement until resolved. A new declaration
may explicitly `supersedes` one blocked unit of the same class and current goal;
it admits fresh pins and retains the old history. The replacement must close
without an unresolved blocker. Completion requires at least one declared unit,
no open units and no unresolved blocked units, in addition to the original goal's
existing acceptance checks. No rule requires automatic fan-out of every class.

This gate enforces declared Core-managed investigations and their consultation
receipts. It cannot infer all semantic work hidden in native shell commands,
verify a declared class or establish vulnerability truth. It does not widen
scope, force live tests, start paused work, publish reports or change permissions.
Older goals never acquire routing authority from prose, changed selections or
new Library versions. New diagnostics expose routing readiness and missing work
through task state, metrics and debug exports.

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
