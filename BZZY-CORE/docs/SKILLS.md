# Shared BZZY skills

Core owns one host library at `$BZZY_HOME/skills` (normally `~/.bzzy/skills`).
Entries have global or engagement scope. The default CLI view combines this
project's workflows with approved global methods; a same-named project skill
takes precedence. Qualified IDs distinguish projects. Ordinary model requests
cannot select another project. Workers see global methods unless their host
explicitly grants a particular project skill; persistent Agents retain their
registered directory boundary. Scope remains independent of provider/model.
Codex, Claude, API providers routed through the current adapters, and persistent
Agents use the same enabled skills through Core tools. Provider-native skill
folders are not required for this library. Future execution adapters must carry
Core instructions and expose the shared tool host; merely adding a model name
does not implement a new provider protocol.

## Use and manage

`/create-skill <requirements>` in a terminal chat asks for a name and uses that
chat's current model to generate a reusable definition. Core's internal
[creator guide](../assets/bzzy-skill-creator.md) defines the native package,
discovery and credential-separation contract. The explicit command publishes
the checked skill globally and enables it atomically; it is immediately available
through `list_skills`/`read_skill` and Library sharing. It does not execute the
skill. Existing names are never replaced. Escape, changed host/project/session
or model selection, invalid output and portability failures prevent publication.
The Skills tab keeps plain Import and Export controls plus **Codex import** and
**Clear**; creation uses this command.

In CLI, open **Skills** or type `/skills`. The list shows names and ON/OFF
controls. **Export** opens name checkboxes and generates an expiring Relay code;
**Import** asks ENTER CODE, then downloads, validates and installs/enables missing
skills with progress. Selection happens only on the sender. Resources and project/global scopes survive; existing
names and availability are preserved. See [Library sharing](LIBRARY-SHARING.md).
`/skills import` separately
accepts one skill directory or a ZIP containing one skill directory. To copy
existing Codex workflows, choose **Codex import**, type `/skills codex` (or
`/skills sync`) or run `bzzy skills sync` from your project directory (`--cwd DIR`
selects another project). It shows every local Codex skill in a checkbox table
and imports only the checked ones. Import is local and one-way; it does not
require Codex login or start inference. Folder/ZIP imports and sync
start disabled; `/create-skill` and the tab's explicit Relay import enable their
validated results. Single-folder imports default to the current project; definition
ZIPs preserve explicit project/global scope. Legacy host-global packages that contain raw evidence or
run records require scope review before they are exposed to models.
Open a skill to read its instructions and text resources, then explicitly enable
it for all models. Disabling takes effect on subsequent Core reads and the next
request's catalog; instructions already in a provider's context cannot be erased
from an in-flight model turn.

Each skill has `SKILL.md` with YAML frontmatter containing a lowercase hyphenated
`name` and a `description`, followed by workflow instructions. Plain, quoted and
folded/literal multiline descriptions are supported. Supporting directories can
include `references`, `scripts`, `templates` and `assets`. A resource being present
does not authorize executing it. Claude-specific hooks, tool permission fields,
argument substitutions and other provider extensions are inert to Core.

Trusted host code can import `engine/skills.js` to use `listSkills`, `inspectSkill`,
`readSkill`, `createSkill`, `importSkill`, `setSkillEnabled`, `deleteSkill`,
`previewSkillClear` and `clearSkills`. Replacements require
the current `expectedRevision` and become disabled for review. Enabled-state
changes also require the displayed revision; concurrent edits cannot silently
replace another owner's decision. Model tools cannot administer this library.

`/skill_that` continues to produce a project-local skill from a completed goal.
It includes a private project-scope marker and does not automatically install or activate that output. Import its folder
through Skills after reviewing the workflow and its private evidence references.
Version history and rollback are available in the same panel; restored versions
start disabled. Automatic learning stages new project procedures and corrections
by default, with source/job provenance and immutable history. Learn exposes
reviewed `newSkills: auto|stage|off` and `updates: stage|off` controls; existing
skills retain their enabled state during migration. Explicit automatic creation
still preserves owner OFF/delete decisions and exact-content deduplication.
Disable or Delete is available in the skill preview; deletion preserves audit
history and prevents an old learning job from recreating the entry. Staged
candidates compare owner-approved offline fixtures and require explicit
version-pinned acceptance. Existing-version updates also wait until open workflow
work units release their base-version pins. Exact-version feedback requires a
full live skill read, and never edits a resource directly.

Security fixture contracts use `real|false_positive|inconclusive`; generic
`procedure-review-v1` fixtures use `supported|unsafe|inconclusive` with independent
`sourceGroup` values. Learning-update groups must be separate from their authoring
run/goal/episode. Both are semantic instruction checks: scripts are not executed
and passing does not establish arbitrary program correctness. Advisory curation
can suggest similar learned procedures, while reviewed archive/restore use
current revisions and leave restored methods disabled. Usage counts and run
associations do not measure skill quality.
Global promotion creates a separate generic text-only candidate, never a copy of
the original evidence/resources. See [reviewed learning](KNOWLEDGE.md).

### Move a portable project skill into BZZY Core

Open a project skill and choose **Move to BZZY Core**. The review shows the exact
package version, every file and size, and the change from **THIS CHAT / PROJECT**
to **BZZY CORE / GLOBAL**. **Inspect package files** reads that pinned version;
Back or cancellation leaves the package and chat draft unchanged. **Move to BZZY
Core** publishes the reviewed package only when the source revision/version,
current host/project and empty global destination still match.

The entire portable package is retained, including scripts, references, assets
and provider metadata. Existing global names are never overwritten, even when
their content matches. Core archives the project registry entry and retains its
immutable local packages and history. Original Codex and project source folders
remain untouched. The new global skill starts disabled and needs a separate,
explicit **Enable for all models** action.

Packages with project-scope markers, evidence or run records cannot move directly
into global scope. Use **Create a separate generic global candidate** to author a
parameterized workflow while keeping those resources private. Both paths reject
recognized credentials and unsafe files; neither runs scripts, invokes a model,
adds tools or grants execution permissions.

Trusted local host code can use `previewSkillGlobalMove` and
`moveSkillToGlobal` from `engine/skills.js`. The move requires the exact returned
review and `reviewed:true`; its source removal and destination publication share
one SQLite transaction. These administration APIs are not model tools.

## Skills and agents ZIP

Core retains versioned definition ZIP APIs and legacy CLI action routes;
the primary tab buttons use Relay codes. Type-specific ZIP operations can
read older combined archives. The entire archive is validated before selected entries
can be installed. Archives contain the current project's and global
portable definitions, with an exact
file/hash manifest for review. It contains no sessions, accounts, runtime state
or execution history. Private case/evidence packages and unsafe files are
blocked. Export writes a new file in the selected terminal's original directory
without overwriting files. Import maps project scope to the receiving directory,
keeps global scope explicit, preserves existing names and leaves skills disabled.
Reviewed specialist definitions become discoverable without starting work.
ZIP publication does not require hard links or filesystem configuration changes.
It uses exclusive publication without replacing existing files. On filesystems
without exclusive rename support, an interrupted export can leave its own new,
incomplete ZIP; it cannot overwrite an existing file.

## Clear the library

**Clear** in the Skills tab, or `/skills clear`, deletes every skill the library
manages for this terminal: the current project's skills and all global skills.
The `/skills scope` filter narrows it to project-only or global-only. Skills of
other projects are untouched, and a global skill hidden behind a same-named
project skill is counted and deleted too. A confirmation dropdown shows the
total and per-scope counts; Cancel is preselected.

`previewSkillClear` returns the exact list with revisions and a fingerprint, and
changes nothing. `clearSkills(review, { reviewed: true })` deletes exactly that
list in one SQLite transaction. Any skill added, edited, toggled or removed after
the review cancels the whole clear. Each entry is deleted like an individual
Delete: immutable versions and audit history remain, the deletion receipt keeps
revisions increasing if the name returns, and learning publication receipts are
marked deleted so an older learning job cannot recreate the entry. Clear does not
touch staged learning candidates, Codex folders or other source files. These are
owner administration APIs, not model tools.

## Sync from Codex

BZZY skills use the same package format as Codex skills. On Debian/Linux and
macOS, Codex import discovers `SKILL.md` folders in these locations, in order:

1. `.agents/skills` in the selected project directory and its ancestors up to
   the closest repository root. Outside a repository, only the selected directory
   is searched.
2. `~/.agents/skills`.
3. `$CODEX_HOME/skills`, `$BZZY_CODEX_HOME/skills` when configured, and the legacy
   `~/.codex/skills` fallback, including bundled `.system` skills.
4. `/etc/codex/skills`.

The project/user/admin locations follow the [Codex skill discovery
documentation](https://learn.chatgpt.com/docs/build-skills). Sync copies the whole
validated package, including scripts, references, assets and `agents/openai.yaml`,
into Core's shared library. The original Codex folders stay unchanged. Packages
from project discovery retain that engagement's scope; user and machine sources
are global. Exact legacy sync-managed project copies are narrowed to their
project while their version archive and enable decision are preserved. Scripts
and provider integrations do not run or install during sync or enable. Unsupported
provider-specific dependencies still need an authorized BZZY runtime capability;
copying their declarations does not create that capability.

Owners can add one extra folder, such as a copied `~/.codex/skills`, through
**Other folder** in the CLI table. It is scanned after the standard locations,
imports globally and never relabels or rescopes a standard location. The CLI keeps
it in its private `cli-preferences.json`.

`previewCodexSkills` is the read-only scan behind the checkbox table. Each entry
carries an opaque `sourceId`, the content `version`, a location label
(`this project`, `~/.agents`, `$CODEX_HOME`, `$BZZY_CODEX_HOME`, `~/.codex`,
`Codex system`, `/etc/codex` or `other folder`), the destination scope and a
status: `new` or `update` (importable), `unchanged`, `conflict` (with
`conflictWith: library` for an independent BZZY skill, or `location` for an
earlier Codex location), `duplicate` or `rejected`. A scan installs nothing,
writes no bindings and creates no project identity. `importCodexSkills` takes the
checked `sourceId`/`version` pairs, scans again and imports only those entries.
A package that changed or disappeared after the scan is reported instead of
imported, and the result lists only the checked entries. `syncCodexSkills`,
used by noninteractive `bzzy skills sync --json`, imports every importable
package at once.

Codex tolerates skill names with underscores, spaces or capitals. BZZY imports
them in its lowercase hyphenated form (`read_emails` becomes `read-emails`) from a
private staged copy where only the frontmatter `name` line changes. `SKILL.md` is
read without following links and must be valid UTF-8; the Codex folder is never
modified.

Repeat runs deduplicate source folders and identical packages. Unchanged copies
keep their enabled state and revision. A changed source updates only the copy
managed by that source and disables the new version for review. Independent
BZZY edits and same-name packages with different content are kept and reported
as conflicts. The earlier location wins among newly discovered names. Removing
a source does not remove the BZZY copy. Sync details list skipped/conflicting
items without putting absolute source paths into CLI reports or model prompts.
Source ownership is recorded privately as a path hash, outside portable metadata.

Discovery is bounded to 4,096 visited entries, 512 packages and four namespace
directory levels; each run processes at most 128 MiB of validated content. Normal
package limits below still apply. Unlike Codex's native discovery, BZZY does not
follow symlinked skill folders; these are reported as skipped. The CLI reports
unavailable locations and scan limits instead of failing the entire library.

## Execution contract

Core includes a bounded enabled-skill catalog in requests when skills exist.
`list_skills` searches and pages metadata; `read_skill` returns a bounded UTF-8
slice of `SKILL.md` or a declared text resource. Every read rechecks enabled state,
optional expected version, path ancestry and file content hash. `skill.loaded`
events record name/version/file/hash and byte range, without copying resource
bodies into the audit event. Request an enabled workflow with `$skill-name`, or
let the model discover it through its description. Changing provider, model or
effort retains the same Core library and enable decision. Providers receive the same content through Codex
dynamic tools or Claude's MCP bridge. Existing Codex threads created before the
shared tool schemas are upgraded once using the existing bounded conversation
handoff; durable original history remains saved.

The Core index is SQLite-backed with bounded query pages. Versions are immutable
content-addressed directories; installs stage content before atomic publication.
A small metadata catalog avoids putting every complete workflow into every
prompt. Large libraries are discoverable through paginated search.

## Explicit local signup aliases

The local owner can give one skill a concrete approved email-alias list in
**CLI Settings → BZZY Core → Gmail / email access → Login / signup aliases**,
or through the command forms:

```sh
bzzy skills aliases set mail-reader 'tester+1@example.invalid;tester+2@example.invalid'
bzzy skills aliases show mail-reader
bzzy skills aliases clear mail-reader
```

The exact strings live in private Core `config.json` under
`skillAccountPolicies[skillId].approvedSignupAliases`. Existing project/global
skill identity determines that key. Configure each installation separately;
Library exports carry generic behavior and never this owner configuration.

After an authorized primary terminal calls `read_skill`, Core returns that list
in a separate `privateContext.approvedSignupAliases` array with `policyRevision`.
The immutable text, file hash, byte offsets and usage receipts stay unchanged.
A skill that needs a fixed list should explicitly require this array and select
only exact entries. A missing/empty list blocks that account-dependent step;
the model must not guess an address. Invalid optional policy data leaves skill
text readable with an empty, unavailable private context. Owner commands report
a safe configuration error without printing private JSON fragments.

Model tools cannot administer this list. Children, reviewers and persistent
Agents do not inherit the owner's aliases. The list supplies no credentials,
mailbox connection, testing scope or extra tool permissions. Account access
still requires a separately authorized connection. Core's native `gmail_read`
uses the main mailbox login configured on the email Settings screen; approved
aliases are the identities used on website login and registration forms and
must already forward to that inbox. BZZY does not configure forwarding. Ordinary
inbox reading does not require signup aliases. The native tool works without
an external Python script or credential-file discovery; reusable email skills
should use its current list/read schema, including returned UID and UIDVALIDITY.
Private metadata is excluded from
skill-read audit/diagnostic events and structured portable project state; native
provider history can contain data already delivered to that owner's model.

## Import boundaries and limits

A package is limited to 512 entries, 12 directory levels, 20 MiB total and 1 MiB
per resource. `SKILL.md` is limited to 128 KiB. ZIP structure is checked before
extraction; traversal, links, duplicate names, encrypted entries, special files
and oversized content are rejected. Folder imports reject symlinks/hardlinks,
hidden/authentication paths and recognized credentials. No imported hook,
installer or script executes during import, viewing or enabling. Credential
scanning is supplementary and cannot prove arbitrary content safe; review
third-party skills and never put private account bindings into a skill.

Persistent Agents retain their existing read/tool restrictions. Skills provide
workflow guidance and bounded library reads; shell, writes, accounts and network
capabilities still require separate runtime implementation and authorization.
Binary assets are retained as package resources; the current Core reader exposes
text only and never pretends binary data is executable or model-readable media.
