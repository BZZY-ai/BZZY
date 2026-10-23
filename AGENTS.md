# BZZY workspace instructions for coding AI

- After implementing and validating authorized changes, commit and push them to
  this repository so users receive Core and CLI changes through the CLI updater.
  Publish only the intended product changes; keep private bindings, generated
  artifacts and user reference checkouts out of commits. Do not update the user's
  running installation automatically unless requested; an updater compatibility
  repair may be prepared when necessary to make the authorized update flow work.
- Read `README.md`, `SECURITY.md`, and each affected product's README before
  designing or changing it. Core architecture and execution contracts are in
  `BZZY-CORE/docs/`; product documentation distinguishes implemented behavior
  from proposed capabilities. Keep temporary planning notes out of the repo.
- Shared backend implementation belongs in `BZZY-CORE/src/engine/`. Core owns
  sessions, chats, goals, providers/authentication, model discovery, tools,
  permissions, persistence, recovery, and debate/parallel/delegate/besties logic.
  `BZZY-CLI/BZZY-CLI-TERMINAL/` owns the terminal frontend. Its old backend module
  paths are compatibility re-exports. Never add a reverse Core dependency on CLI.
- The existing Core Relay gateway must remain compatible. The connection is
  CLI <-> Core <-> Relay <-> iOS; Relay does not execute models or hold owner keys.
- Core's coordinator/default assistant has independent provider/model/effort
  settings from CLI chat defaults. Preserve Core's coordinator configuration APIs.
  Provider/model catalogs and authentication are Core-owned and discovered by
  clients; new models/providers must not require hardcoding them into the TUI.
- Keep the main CLI Settings menu to four entries: DeepSeek API key, default
  BZZY folder, Pair iPhone, and BZZY Core. BZZY Core opens a compact secondary
  screen with status and Start/Stop/Restart, using Core's owner lifecycle APIs.
  Do not add coordinator/provider, observe-only or scope-selection entries.
- Pair iPhone authorizes this user's phone with full session permissions
  (observe, claim, takeover, execute, answer, pause, cancel, steer), terminal
  catalog access, project sharing and Agent management. Do not offer permission
  mode/scope choices in this flow. Keep QR/expiring codes, explicit fingerprint
  comparison and approval, expiration and revocation on its secondary screen.
  Core still enforces the approved grant and runtime policy; this is not a
  credential transfer or a change to separate scoped friend/collaboration grants.
- Keep CLI terminal-oriented. Persistent Agents are managed in iPhone and owned
  by Core; do not add an Agents tab or management surface to CLI. CLI creates
  terminal sessions in their original project cwd. iPhone opens existing ones.
- CLI keeps its eyes/brand, current model, usage and host metrics visible above
  changing screens. Compact layouts must preserve the complete pairing QR and
  its quiet zone. Keep the four-entry Settings menu compact.
- Both clients list only terminal sessions with a nonblank alias, ordered by
  most recent saved activity first. CLI Sessions uses arrows and Enter to open
  the actual saved chat in its original cwd, without replaying model work.
- iOS dictation sits beside Send: hold to talk, release to finalize. Populate
  the editable draft with live partials when available, preserve typed text,
  cancel capture on background/navigation, and never send speech automatically.
- `bzzy` launches the CLI and activates Core's supervised background service if
  needed. Provide `bzzy-core start|status|stop|restart`. Explicit stop pauses
  work durably; polling must not undo it. A new CLI launch or explicit start
  reactivates Core without automatically replaying paused work.
- Paired iOS must clearly show Core offline and lock Core-dependent Agents and
  Terminal actions until an authorized Core response confirms reconnection.
  Relay connectivity alone is insufficient; retain valid pairing while offline.
- Use `BZZY-IOS/message_format.txt` for the canonical assistant body format in
  both CLI and iOS. Preserve original bodies in durable history/events. The
  terminal renders supported semantics using its capabilities; formatting never
  grants permissions, executes tools, or establishes verified completion.
- Product documentation can contain proposed capabilities as well as implemented
  features. Documentation alone does not authorize building every proposal.
- Treat credential separation as an architectural requirement in every product.
  Apply the reusable preprompt in `SECURITY.md` to generated agents, workflows,
  scripts, tools, integrations, and their execution instructions. Also enforce
  these boundaries through runtime policies; a prompt is not a security boundary.
- Keep reusable behavior separate from private account bindings. Never place
  real API keys, passwords, account tokens, cookies, or private authentication
  files in generated source, shared packages, model prompts, logs, or reports.
- Sharing goes through Relay using QR codes or random expiring import codes.
  Do not introduce share links or invitation URLs. Portable imports connect the
  recipient's own accounts; live access requires explicit scoped authorization.
- Preserve CLI compatibility, verified goal outcomes, evidence provenance,
  event replay/idempotency, and permission enforcement. Clearly distinguish
  existing verified behavior from proposed capabilities and unverified claims.
