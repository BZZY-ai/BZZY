# Core host platform contract

Debian, Ubuntu and macOS are Core execution-host targets. The Core/CLI installer
must offer one guided BZZY installation on each, with automatic OS and CPU
selection. Core remains one engine; OS differences belong in small host adapters.

| Target | Baseline | Architecture targets | Validation status |
| --- | --- | --- | --- |
| Debian | 12+ | x86_64, ARM64 | Matrix prepared; Linux runs pending |
| Ubuntu | 24.04+ | x86_64, ARM64 | Matrix prepared; Linux runs pending |
| macOS | 13.5+ | Intel, Apple Silicon | Core suite passed on Apple Silicon; Intel run pending |

Node.js 24+ is the runtime requirement. The macOS baseline follows the official
[Node 24 binary platform requirements](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list).
Provider executables have their own compatibility requirements and must be
checked separately during setup. New OS releases need actual validation before
the project labels them verified; a minimum version alone does not establish it.

## Common runtime and platform responsibilities

All targets share sessions, execution queueing, input ownership, evidence gates,
SQLite records, durable event IDs/cursors and scoped authorization. The current
Core facade reuses these from the existing terminal engine, including Linux and
macOS process identity handling. Neither the target list nor an installer creates
a second scheduler or provider runtime.

The unified installer must prepare a compatible Node runtime, install Core and
CLI, guide secure provider authorization, create private local state, perform
health checks, and register the appropriate background service. Installing a
package does not authorize agents to access accounts, folders or networks.

- Debian/Ubuntu: use systemd user supervision for regular accounts. An owner
  explicitly running Core as root uses a root-owned system unit and that account’s
  native terminal permissions. Remote payloads cannot select the operating-system
  user or service scope.
- macOS: use launchd. A per-user LaunchAgent starts with a user login and ends
  at logout; unattended boot-time service is a distinct LaunchDaemon setup with
  an explicit non-root user. Account/Keychain availability must be verified in
  the selected mode. A running user-session test does not prove headless boot
  operation.
- Preserve native credential identity, including whether provider configuration
  variables were unset, and keep account authorization on the execution host.
- Keep project scope checks, path handling and lifecycle/recovery portable.
  Use platform-specific APIs only behind an adapter, with capability checks.

`bzzy-core doctor` and explicit `service plan/install/start/status/stop/uninstall`
now provide prerequisite checks and user-level registration for the same Core
engine. See [installation and supervision](HOST-SERVICE.md). Native Linux and
unattended boot/logout verification remain pending. Relevant references are the
[systemd service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
and [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

## Feature support and isolation

| Feature | Debian/Ubuntu | macOS |
| --- | --- | --- |
| Shared daemon and ordinary solo execution | Targeted; Linux validation pending | Verified offline on Apple Silicon |
| Conversations, durable replay and processed cursors | Targeted; Linux validation pending | Verified offline on Apple Silicon |
| Scoped read-only tool broker | Targeted; Linux validation pending | Verified local broker checks on Apple Silicon |
| Existing strict native policies and multi-agent modes | Require working Linux bubblewrap; Core validation pending | Runtime has a sandbox-exec probe; Core strict-policy validation pending |
| Bundled installer and explicit user service registration | Implemented; native installation pending | Implemented; launchd manifest validated locally |
| Persistent Agent v1 restricted tools/provider profile | Implemented boundary; native Linux provider/OS evidence pending | Implemented with bounded scoped project/context reads and restricted native provider configuration; inspect current validation evidence |

The Linux sandbox currently mounts the host root read-only; that does not make
private host reads confidential. The broker is not wired into all native backend
tools. The native runtime now also has a macOS write/network policy adapter;
this Core suite does not establish native policy parity on every target. The
persistent Agent v1 policy is a separate bounded provider/tool boundary, not
blanket permission to run arbitrary programs. See [Agent execution](AGENT-EXECUTION.md).
macOS's filesystem-broker ancestry revalidation is not proof against adversarial concurrent
directory replacement. Preserve these limits in capability reporting. A platform
support claim must never silently turn an enforced policy into unrestricted
execution.

## CI and release evidence

[ci-platforms.yml](ci-platforms.yml) is a workflow template to place at
`.github/workflows/core-platforms.yml` in the future repository root. It assumes
the current sibling Core/CLI/Relay layout is included in that repository. It is not
an active workflow while stored under Core documentation.

The native matrix covers Ubuntu 24.04 and 26.04 on x86_64/ARM64, plus Intel and
Apple Silicon macOS. Debian 12 and 13 are covered with official Node 24 Debian
containers on both Linux architectures. The Debian tests run as the runner's
non-root UID, without external networking and with only the source mounted
read-only. Container tests establish userspace/runtime behavior; Debian service
installation and reboot recovery still need a real Debian host or VM.

The runner labels follow the [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Every matrix entry runs syntax checks and the offline Core suite, including
the actual daemon and filesystem negative cases. Record OS/architecture, Node
version, provider fixture and outcomes. Provider login, live model access,
service startup across reboot/logout and stronger OS isolation require separate
evidence before a production release.
