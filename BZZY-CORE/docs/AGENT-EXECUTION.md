# Persistent Agent v1 execution boundary

Persistent Agents are managed from iPhone and stored by Core beneath its
configured managed root. CLI remains the terminal frontend. Creating, opening
or importing an Agent starts no model work. The user explicitly submits a new
request or resumes reviewed work through the existing scoped session controls.

Core resolves an Agent from its live `core.agent` registry entry and saved session
ancestry. It validates the registered root conversation and pinned workspace
directories, rejects orphaned/forged identities and cycles, and rechecks scope
before tools run. An imported `agentId`, purpose string, model instruction or
historical permission is not authority. Archived or replaced workspaces fail
authorization.

The current Agent tool surface is deliberately bounded:

- Activity, durable task state, checkpoints, memory/recall and issues.
- Existing goal/acceptance reporting when the session is eligible. Reported
  completion still passes Core's verification rules; historical claims do not
  become newly verified outcomes.
- `read_project_file`: bounded UTF-8 slices from the Agent's own project and
  allowed saved context, with host-recorded hashes and timestamps. The reader
  uses the scoped Core filesystem broker and rejects private authentication
  paths, external paths, symlinks, hardlinks, invalid ranges and revoked scopes.
  The Agent-only context adapter permits safe notes/evidence text under `.bzzy`
  without making private Core runtime directories or arbitrary databases readable.

Native shell execution, file writes, unapproved HTTP/web access, delegation,
unrelated projects and arbitrary account operations are unavailable under this
policy. Core rejects forbidden direct tool calls as well as omitting them from
tool discovery. A goal or natural-language request cannot grant a new capability.
Agent contracts containing executable acceptance commands or automated file
assertions are rejected before execution with `UNSUPPORTED_POLICY`; preserving
such a contract as imported history never authorizes those host operations.
Optional schedules and production email/subscription/account connectors are
not installed by this version. Such work needs separate authorization, private
binding adapters and deterministic destination/action policies.

Codex uses the named `bzzy_agent_isolated_v1` permission profile: default root
denial, limited read roots, disabled tool networking and no inherited shell
environment. Shell, web search, native multi-agent, apps/plugins/hooks and host
skill discovery are disabled. Core checks both that the profile is allowed and
that the started/resumed thread actually activated it; unsupported enforcement
fails before a turn. A per-session private Codex backend home avoids loading the
owner's general MCP/plugin/project configuration. Official subscription login
is referenced from the recipient host's private auth store, not copied into the
Agent workspace or package.

Claude runs with restricted mode, no native built-in tools, strict Core MCP
configuration, disabled slash commands/settings sources and disabled hooks.
Only the bounded Core tool list is allowed through that configuration. Unsupported
native flags fail rather than triggering an unrestricted fallback. Provider
processes still need their own authorized local model login/key to contact the
provider; inference authentication is not an Agent account tool and does not
authorize email, shell commands or another user's integrations.

These restrictions apply to registered persistent Agents and their validated
descendants. Ordinary CLI terminal sessions and independent coordinator task
contexts retain their existing native policies. A read-only broker grant does
not turn arbitrary owner code into a sandbox. Do not apply Agent safety claims
to terminal shell execution or to unsupported provider/OS combinations.

Portable Agent copies include their complete selected files, descendant chats,
notes, memory, evidence and allowed run history, subject to the strict shared
archive policy. Import creates a new managed Agent, remaps identities and paths,
detaches native threads, applies the recipient's explicit provider/model/effort
and commits the definition/history atomically. Work remains inactive. Imported
execution records are historical context, not proof of new inference or newly
verified completion. Source authentication does not establish that imported
instructions or code are safe. See [sharing](PROJECT-SHARING.md).

Validation uses private fixtures for registry ancestry, direct forbidden calls,
private/context path and link handling, revocation, provider arguments/profile
checks, and encrypted full-context transfer. Consult [the validation record](VALIDATION.md)
for current suite/native evidence. Local checks do not prove every Linux/native
provider version, public Relay rollout, TestFlight availability or physical APNs
delivery. Broader account automation and write/network tools require their own
implementation and negative tests before being advertised.
