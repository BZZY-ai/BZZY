# BZZY

Self-hosted AI workspaces with a terminal client and a native iPhone app.
Core owns execution and durable state; clients supervise the same sessions.

```text
BZZY CLI ↔ BZZY Core ↔ BZZY Relay ↔ BZZY iOS
```

| Product | Implementation |
| --- | --- |
| [Core](BZZY-CORE/README.md) | Sessions, providers/auth, tools, goals, persistent Agents, sharing and the host Relay gateway. |
| [CLI](BZZY-CLI/BZZY-CLI-TERMINAL/README.md) | Terminal chat, aliased sessions, Settings, pairing and local Core controls. |
| [Relay](BZZY-RELAY/README.md) | Authenticated encrypted transport and expiring QR/import codes; no model execution or provider credentials. |
| [iOS](BZZY-IOS/README.md) | Pairing, Agent management, existing terminal chat/history, activity and on-device dictation. |

Keep this directory layout when cloning: the Node packages use sibling file
dependencies. Agent and sharing implementations live in Core and their clients.
There is no separate Agent or sharing daemon.

## Install Core and CLI

On macOS or Linux, run the bundled installer from the terminal package:

```sh
cd BZZY-CLI/BZZY-CLI-TERMINAL
./install.sh
bzzy
```

The installer prepares Node 24+ if needed and requires Python 3.9+ for project
ZIP sharing. Core runs as a user service. Use `bzzy-core start|status|stop|restart`
or **CLI Settings → BZZY Core**. Stop pauses work durably; Start/Restart do not
automatically replay paused goals.

CLI Settings also contains the DeepSeek key, default BZZY folder and Pair iPhone.
Terminal projects keep their original working directory. Use `/alias NAME` to
show a session in CLI/iOS; both lists put the most recent activity first.

## iPhone and Relay

Open `BZZY-IOS/BZZY.xcodeproj` in Xcode, choose your development team and iPhone,
then build/run. First use requires Pair; compare fingerprints and approve on the
host. The app holds device-scoped authorization, never Core's owner credentials.
See the [iOS guide](BZZY-IOS/README.md) and [Core Relay setup](BZZY-CORE/docs/RELAY.md).

For a Relay you operate, use the [deployment guide](BZZY-RELAY/deploy/README.md).
Host enrollment remains an operator step. Keep private deployment configuration,
keys, account bindings and notification credentials outside this repository.

## Development

Use Node 24+ and install the locked workspace dependencies:

```sh
cd BZZY-RELAY && npm ci --ignore-scripts
cd ../BZZY-CORE && npm ci --ignore-scripts --install-links=true
cd ../BZZY-CLI/BZZY-CLI-TERMINAL && npm ci --ignore-scripts --install-links=false
```

Each Node product provides `npm run check` and `npm test`. CLI fixtures run
through `scripts/test.mjs`. On macOS, run `BZZY-IOS/tools/check.sh` from the iOS
directory for model, formatting and native Swift checks. Product validation
records describe test scope and outstanding device/platform limitations.

Read [AGENTS.md](AGENTS.md) and [SECURITY.md](SECURITY.md) before changing the
workspace. The canonical assistant presentation contract is
[message_format.txt](BZZY-IOS/message_format.txt), used by CLI and iOS. Formatting
does not grant permissions or prove completion. Optional scheduling and production
account connectors remain future work; see the product implementation guides.
