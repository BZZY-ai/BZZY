# Shared BZZY skills

Core owns one host library at `$BZZY_HOME/skills` (normally `~/.bzzy/skills`).
Codex, Claude, API providers routed through the current adapters, and persistent
Agents use the same enabled skills through Core tools. Provider-native skill
folders are not required for this library. Future execution adapters must carry
Core instructions and expose the shared tool host; merely adding a model name
does not implement a new provider protocol.

## Use and manage

In CLI, open **Skills** or type `/skills`. Import one skill directory or a ZIP
containing one skill directory, or create a skill by entering its name,
description and instructions. Imports and newly created skills start disabled.
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
`readSkill`, `createSkill`, `importSkill` and `setSkillEnabled`. Replacements require
the current `expectedRevision` and become disabled for review. Enabled-state
changes also require the displayed revision; concurrent edits cannot silently
replace another owner's decision. Model tools cannot administer this library.

`/skill_that` continues to produce a project-local skill from a completed goal.
It does not automatically install or activate that output. Import its folder
through Skills after reviewing the workflow and its private evidence references.

## Execution contract

Core includes a bounded enabled-skill catalog in requests when skills exist.
`list_skills` searches and pages metadata; `read_skill` returns a bounded UTF-8
slice of `SKILL.md` or a declared text resource. Every read rechecks enabled state,
optional expected version, path ancestry and file content hash. `skill.loaded`
events record name/version/file/hash and byte range, without copying resource
bodies into the audit event. Providers receive the same content through Codex
dynamic tools or Claude's MCP bridge. Existing Codex threads created before the
shared tool schemas are upgraded once using the existing bounded conversation
handoff; durable original history remains saved.

The Core index is SQLite-backed with bounded query pages. Versions are immutable
content-addressed directories; installs stage content before atomic publication.
A small metadata catalog avoids putting every complete workflow into every
prompt. Large libraries are discoverable through paginated search.

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
