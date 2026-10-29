# Native extensions

Implemented format: `bzzy-extension`, version 1. The complete, standalone
installed reference is **`bzzy --help-extensions`** (also on `bzzy-core`). Its
canonical source is [the authoring guide](../assets/authoring/extensions.md),
with the mandatory generation/credential policy appended at runtime. Printing
help imports no state/account/runtime modules, starts no service or model,
creates no directories and performs no network request.

Core's [extension registry/runtime](../src/engine/extensions.js) owns definitions,
validation, revisions, session form/table state, private bindings, bounded actions
and model interaction. [The network broker](../src/engine/extension-network.js)
allows fixed public HTTPS GET destinations with DNS/socket pinning, deadlines,
size bounds and no redirects, inherited proxies or cookie jar. Definitions are
declarative; arbitrary code, JavaScript plugins and custom executable callbacks
are outside this first implemented format.

The terminal owns the extension tab lane, native controls and Settings →
Extensions. Its main Chat tab returns from ordinary panels while retaining the
chat draft. Settings imports/exports a selected JSON definition locally, or uses
the existing encrypted Relay Library code/QR protocol to transfer selected
extension definitions. Relay remains transport-only and receives no account keys.
Library ZIP version 3 adds global extension entries; existing version 2 packages
without extensions remain supported. Extensions share the existing inventory,
exact content-hash review, missing-only installation and retry-receipt controls.

Tools `list_extensions`, `read_extension` and `interact_extension` are available
to live ordinary owner-terminal model contexts independently of provider.
Ordinary edits and declared `ai:true` actions use the exact definition hash and
current session-state revision. AI cannot install/enable packages or read/save
secret values. Workers, reviewers and persistent Agents receive no extension
capability or inherited private account binding. Main supervisors can explicitly
pass appropriate nonsecret results through existing permitted delegation tools.

Private credentials are held in `credentials.extensions.json` within Core's
private home, 0600 with atomic writes and a host-process lock. Bindings are
scoped to session, definition hash and installation identity. Updates to content
and remove/reinstall require reconnecting accounts. Disable/re-enable of the
same installation preserves private bindings but removes use while disabled.
Known reflected credential values are removed before saving/returning HTTP
results. Tool activity/diagnostics omit form inputs. Normal owner shell execution
retains its existing permissions; this framework is not a host confidentiality
sandbox for arbitrary terminal commands.

Extension definition/state/request records cannot acquire authority through
project export/import. Library/local definition exports include no private
bindings, mutable state or action receipts. Imported extension definitions must
pass native schema, secret/portability and content-integrity checks.

A click has a stable requestId: one pending receipt is durably admitted before
dispatch. Retries never redispatch that ID; a crash leaves it uncertain. Opening
sessions/tabs and runtime polling never replay actions. A deliberately new
request ID can retry after inspection. Responses cannot overwrite a newer form
revision, and changes to the current package/enable revision, credentials,
network policy or live run authorization withhold the result. Failure keeps prior
rows and an explicit failed/interrupted status. No action result, styled text,
model statement or imported table is a verified task-completion receipt.

Validation uses offline native UI/tool fixtures, private credential isolation,
policy/revision/disabled-action negative cases, actual authoring-guide example
validation, and definition-only Library archive round trips. No service account
or real third-party extension is included or contacted by those fixtures.
