# bzzy 🐝

Supported targets: **Debian 12/13, Ubuntu 24.04+, and macOS 15+** on x64 or
ARM64 with Node.js 24+. The installer uses a compatible existing Node or installs
a private Node 24 runtime. Existing Codex/Claude executables remain separate.

| Platform | Enforced task policies and multi-agent modes |
| --- | --- |
| Debian / Ubuntu | bubblewrap with working user namespaces |
| macOS | native `sandbox-exec`, verified by write/network enforcement probes |

If enforcement is unavailable, strict modes stop before starting a backend.
Ordinary chat and solo goals remain available. Linux dependencies include Git,
Python 3.9+ for project ZIPs, OpenSSL for optional HTTPS capture, and bubblewrap for
strict modes (`sudo apt-get install git python3 openssl bubblewrap`). macOS needs
working Git and Python 3.9+ installations; the OS supplies `sandbox-exec`.
The installer checks Python before making changes and never installs OS packages.

Ubuntu's AppArmor policy can restrict user namespaces. If the enforcement probe
fails, check the distribution's application profile and namespace configuration;
BZZY does not disable host security settings. See [Ubuntu's AppArmor documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).

From the complete BZZY source workspace:

```bash
cd BZZY-CLI/BZZY-CLI-TERMINAL
./install.sh
bzzy
```

Keep `BZZY-CORE` and `BZZY-RELAY` beside `BZZY-CLI`. The installer prepares
the existing locked Relay SDK and links the CLI to Core without installing or
invoking Codex/Claude backends. Core source edits take effect through that local
package link. Rerun setup after changing dependencies: `npm ci --ignore-scripts`
in Core followed by the same command in this CLI.

Release maintainers can run `npm pack` here to prepare a self-contained CLI
tarball. It bundles Core, Relay and their dependencies from the current source;
packaging stages a sanitized physical copy and then restores the local source
link. No second maintained copy of the engine is needed. Install the tarball
with `npm install -g ./bzzy-cli-0.2.0.tgz`, or extract it and run `./install.sh`.
A bundled release needs no sibling directories and its installer does not invoke
npm. A terminal-only source checkout is no longer a complete installation.

Core owns execution, provider/authentication configuration, model discovery,
conversations, goals, recovery and all debate/parallel/delegate/besties logic.
This package owns the terminal frontend; legacy backend modules forward to Core
for compatibility. Core's daemon and workers run without this CLI installed.

Core's coordinator has its own provider/model/effort configuration, editable with
`bzzy-core assistant set`. `/default` and
`--default` select terminal chat presets independently. New providers/model
catalog entries are registered/discovered in Core and appear in the existing
CLI selectors without hardcoded model lists. Current custom API providers must
support the execution adapter's actual protocol; an arbitrary local LLM server
is not automatically compatible.

CLI stays terminal-oriented; persistent Agent management lives in iPhone.
The terminal header shows Core host CPU and used/total RAM, refreshed roughly
once per second. Wider terminals also show Core's own resident memory. These
readings come from Core and stay outside chat/history.
Running `bzzy` in `/projects/nasa` keeps that session tied to `/projects/nasa`.
Name a chat with `/alias NAME`, then open **Sessions**, use `/sessions`, or run
`bzzy sessions`. The list contains named terminal chats, newest saved activity
first. Use ↑/↓ and Enter to open the existing chat and history in its original
directory; Esc returns without changing it. Rows show the alias, with a directory
hint only when names repeat. Opening a session never resumes a paused goal or
starts another execution.
Set Core's default home for agents/managed imports with
`bzzy-core workspace set /absolute/BZZY` or **Settings > Default BZZY folder**; this never moves or links
existing projects. The installer provides both `bzzy` and `bzzy-core` launchers.
Run `bzzy-core doctor` to check installation prerequisites. The installer
prepares a disabled user service; plain `bzzy` starts it automatically. Use
`bzzy-core start`, `status`, `stop` or `restart` for simple controls. Stop verifies
all work is paused; existing client polling cannot resurrect Core. A new `bzzy`
invocation or explicit start reactivates it without resuming paused models. See
[host setup](../../BZZY-CORE/docs/HOST-SERVICE.md) for Linux and macOS login limits.
Core lifecycle commands remain available outside the minimal Settings menu.

Use `/share` inside an attached terminal for a QR or temporary
`BZZY-TERMINAL-...` code. On the receiving host, `bzzy --import CODE` or `/import`
downloads and restores the complete project/context into that CLI's current
directory. Compare fingerprints; credentials/host authority are excluded,
conflicting files are protected and imported work stays inactive. Codes remain
outside BZZY chat/history/logs. Source Core must stay online and Relay must run
the updated transfer limits. See Core's `docs/PROJECT-SHARING.md` for bounds.

Create at least one CLI terminal with `bzzy` before pairing. **Settings > Pair
iPhone** automatically displays a QR/code and pairs the user's phone with full session control,
terminal catalog access, project sharing and Agent management, after fingerprint
comparison and approval. No access-mode or scope picker is required. Core keeps
Relay connected when CLI closes.
The compact pairing QR fits directly in an **80×24 TUI** with its scanning border.
On the Mac, choose **Compare and approve iPhone…**, compare the displayed
fingerprint with **This iPhone**, then choose **Fingerprints match · Pair iPhone**.
Approval uses a visible confirmation screen and never a command/text-entry prompt.
Reopening Pair resumes an existing pending phone instead of creating another code.
For smaller terminals, press **O** or select **Open QR image** to view the same
QR in Preview on Mac; press **C** for **Copy code** and enter it in BZZY on iPhone.
Terminal resizing is optional. The image uses a private temporary PNG, removed
when the invitation expires/is cleared or the CLI closes; it stays outside chat,
history and project exports.
First-run iPhone pairing is required; current/history terminals open on the same
Core engine with actual chat and quick activity. Real background goal alerts
require the private APNs setup in Core's `docs/PUSH.md`.

CLI and iOS use the same canonical BZZY message-body format. The TUI and stdout
render valid blocks, tables, lists, code, inherited emphasis and named colors;
NO_COLOR and terminal-capability fallbacks retain readable structure. Font-size
hints map to terminal emphasis/dim. Raw history/JSON events remain unchanged and
clipboard copies are readable text. Invalid or incomplete markup falls back to
literal safe text; markup never executes actions or grants permissions.

Update:

```bash
bzzy --update
```

Check your Claude and Codex connections:

```bash
bzzy doctor
bzzy doctor --live
bzzy doctor --live --provider codex --model gpt-5.6-sol --effort high
```

`doctor` checks the installed CLI, subscription login and backend connection separately. `--live` also requests a short reply and reports token usage when the backend supplies it. Live checks use subscription tokens, disable tools and time out after 45 seconds waiting for a reply. Run `/doctor` inside chat to test its current subscription model, including while a reply is stuck. First-run setup checks both connections and tests the chosen subscription model before saving your default.

Claude login, model discovery, chat and diagnostics preserve the same credential settings on macOS and Linux. On macOS, leaving `CLAUDE_CONFIG_DIR` unset is significant: explicitly setting it to `~/.claude` can select a different Keychain entry ([upstream report](https://github.com/anthropics/claude-code/issues/92252)).

Ordinary chat does not snapshot the workspace. Explicit goals create a source snapshot excluding private credential paths and identify any file exceeding the snapshot limit. Enforced task policies use the platform's verified sandbox.

`/pause` stops the current response, including an unresponsive runner or backend, and keeps the conversation available for another message. The runtime refreshes after source updates. Runner startup failures appear in chat and include a private execution-log path. Claude's model picker reads the installed CLI's catalog, and chat displays the model reported by the backend.

Each execution receives allowlisted caller configuration and locally declared provider keys; unrelated host variables are excluded. Opening terminals with different PATHs or API keys does not restart the shared runtime. Runtime source updates still refresh it. Transient local API disconnections retry automatically. Additional non-secret environment names can be declared in `executionEnvironment.allow` in the private config.

The existing runtime supports expiring session credentials with explicit control permissions and revocation. `bzzy service token SESSION` remains read-only; `bzzy service grants` lists grants and `bzzy service revoke GRANT_ID` revokes one. See the [integration guide](docs/INTEGRATION.md) for scoped clients and reconnect semantics. Full-project `/export` bundles remain private owner backups and can contain secrets; `/share` uses the separate credential-filtered portable policy.

Open **Settings** in the terminal, use `/settings`, or run `bzzy settings`
directly. It includes hidden DeepSeek API-key save/replacement and device
pairing using the bundled Core Relay gateway. The main menu has four entries:
**DeepSeek API key**, **Default BZZY folder**, **Pair iPhone**, and **BZZY Core**.
Open BZZY Core for status, Start, Stop and Restart. Stop leaves Settings usable;
Start/Restart preserve paused work. Leaving Settings reconnects an existing chat
without replaying a goal; leaving while Core is stopped closes the CLI.
Pair iPhone offers a QR and a random code for the same expiring request, then
requires phone-fingerprint confirmation on the host. It requests all session
permissions (observe, claim, takeover, execute, answer, pause, cancel, steer),
terminal catalog access, project sharing and Agent management. Its secondary
screen retains fingerprint confirmation, access expiry and grant revocation;
there are no observe-only/control or scope-selection choices. Core service
commands remain available directly; coordinator settings remain outside this menu.
Core and its Relay dependencies are packaged with this CLI, and the Relay
operator must enroll the public host certificate first.
The daemon keeps the gateway connected after CLI closes. Native local full-line
tests validate iOS interoperability; public host enrollment, real-device checks
and unattended boot/logout behavior remain deployment checks.

The terminal and bundled local viewer use the BZZY iOS turquoise/teal palette.
True-color terminals show the exact palette, with 256/basic-color fallbacks and
`NO_COLOR` support. QR display keeps black/white contrast and its quiet zone;
small terminals show the required dimensions and retain the manual-code option.
Environment API keys take priority until you explicitly choose the saved key
for new requests from this terminal. Keys never appear in chat/history.

Multi-agent modes (`--delegate`, `--besties`, `--parallel`, `--debate`) use Linux bubblewrap or macOS sandbox-exec. Policies constrain filesystem writes and tool networking; they do not establish complete host-read confidentiality. Claude's adapter still rejects disabled tool networking when it cannot preserve model connectivity safely.

The former Telegram integration has been removed. No bot setup, chat attachment,
background polling or Telegram notification transport remains. Startup retires
an existing bridge and removes its saved token/settings without deleting
conversation history or provider credentials. The shared session API, event
stream and generic notification outbox remain available for platform integration.

Run `npm run check` and `npm test` with Node 24 after preparing Core and CLI
dependencies. The [platform workflow template](.github/workflows/platforms.yml)
targets Debian 12/13, Ubuntu 24.04 and macOS on Intel/Apple Silicon, with a
mandatory enforcement preflight. It requires the complete BZZY workspace and
must be placed at that repository's root to run. A terminal-only checkout and
remote CI results are not implied by this template.

Optional settings in `~/.bzzy/config.json` (or `$BZZY_HOME/config.json`):

```json
{
  "inputTimeoutSeconds": 600,
  "bestiesMaxExchanges": 6,
  "snapshotLimits": {
    "maxFileMiB": 20,
    "maxTotalMiB": 100,
    "maxFiles": 10000
  }
}
```

Merge these keys into your existing configuration. Unanswered approvals expire denied. Besties pauses after the feedback exchange limit; `/goal resume` starts another bounded exchange. Snapshot limits can be raised without omitting files; evidence artifacts retain their separate 20 MiB limit. Snapshot and worker copies use filesystem copy-on-write when available. History and evidence remain saved without automatic pruning.

Peer edits stay in their private workspaces until integrated. A group with unapplied changes remains awaiting review and reports each workspace path and changed files. `/providers` changes the conversation; `/default` saves the launch default. Switching providers carries recent bounded context; the full history remains saved.

For runtime troubleshooting, run `BZZY_DIRECT=1 bzzy run "Reply only BZZY_OK without using tools" --claude --runtime 30 --json` to test the backend without the managed runtime. Replace `--claude` with `--codex` or `--deepseek` as needed.

The [review assessment](docs/REVIEW-2026-10.md) records which external recommendations were implemented, qualified or deferred.
