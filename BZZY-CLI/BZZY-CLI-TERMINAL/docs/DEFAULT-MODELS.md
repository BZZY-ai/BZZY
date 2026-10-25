# Default models

Open **Settings → Default models**, or `/settings default-models`.
`/settings modes` opens the same screen for compatibility.

The table has separate **Provider**, **Model** and **Effort** controls:

| Group | Roles |
| --- | --- |
| Solo | Chat |
| BZZY Core | Coordinator |
| Validate | Main and one or two reviewers |
| Delegate | Brain and Executor |
| Parallel | Two or three independent agents |
| Besties | Two or three collaborators |
| Consensus & Compactor | One shared model for both functions |

Use arrows to move between rows/cells, Tab to advance through controls, or click
a cell. Enter opens its picker. Model choices come from Core's provider catalog;
manual model IDs remain available. Changing provider resets the old model and
effort; changing model resets incompatible effort. Core/background choices show
reasoning levels accepted by their configuration APIs. Narrow terminals stack
the same controls with labels.

Each group has **Save** and **Reload/Discard** controls. Unsaved changes are
marked and survive Back/reopening the page. A stale save conflicts rather than
overwriting a newer CLI/iPhone edit. Editing defaults starts no inference, asks
for no credentials and leaves existing chats and running work unchanged.
New chats and future mode launches use saved defaults.

**Consensus & Compactor** has one shared source setting. **Use BZZY Core** is the
default and follows Core's saved selection. **Custom shared model** selects one
provider/model/effort for both validation summaries and background history
summaries, independently of Core's coordinator, ordinary chat and reviewers.
Already dispatched jobs retain their pinned selection. Existing budgets, private
host authentication, stop/recovery and evidence checks remain enforced.

The BZZY Core secondary screen contains service status, lifecycle controls and
the updater. All model defaults are on this table. Existing native provider
authentication and Settings API-key controls supply private credentials.

Nested Settings screens, menus and pickers have a visible clickable **← Back**.
It returns to the parent or cancels the innermost prompt without saving or
confirming an approval. Escape keeps its existing navigation/cancellation
behavior. Chat drafts and the pairing QR layout are preserved.

Core owns configuration and validation. Terminal presets retain their existing
storage and legacy helper APIs; group saves add per-target revision checks and a
shared configuration lock. Core assistant and shared background selections retain
their separate durable revisions. The own-phone settings protocol stays
compatible. See [Core's assistant](../../../BZZY-CORE/docs/ASSISTANT.md) and
[session memory](../../../BZZY-CORE/docs/SESSION-MEMORY.md).
