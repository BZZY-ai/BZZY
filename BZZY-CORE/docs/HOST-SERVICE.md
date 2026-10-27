# Install and supervise a private Core host

The bundled CLI installer prepares `bzzy` and `bzzy-core`, using an existing
Node.js 24+ or a private Node 24 runtime. Python 3.9+ must be available as
`python3`; the installer checks it before changing anything. It never runs sudo
or installs provider executables, provider accounts or operating-system packages.
Install a release on an internal persistent disk before enabling startup. Do not
point a service at a removable checkout or a temporary npx runtime.

## Explicit Linux root installation

For a dedicated test server whose owner chooses root execution, install a fresh
root-owned checkout under root's home:

```sh
./install.sh --allow-root
```

Run this from the CLI package as root. `--allow-root` records an owner-only
approval in root's private Core home, normally `/root/.bzzy`, and prepares a
system unit under `/etc/systemd/system`. This root installation also
replaces recognized root-owned `runuser`/`sudo` BZZY wrappers after retaining
backups in Core's private `runtime/launcher-backups`. The generated direct
launcher preserves cwd, arguments and terminal streams. Root launch therefore
initializes each new terminal's `.bzzy`
at its own launch directory, without per-project ACL setup or a home fallback.
Unrelated launchers and unsafe source/runtime paths are rejected.

The root unit uses `User=root`, `UMask=0077` and system-manager lifecycle commands.
Ordinary accounts keep their user services; macOS root installation is not
supported. Installation prepares the unit without starting it. Plain `bzzy`
or `bzzy-core start` starts it; existing stop/restart and execution-preservation
contracts still apply. Root's private approval survives normal updates.

An existing non-root installation remains separate: its history, credentials,
provider homes and pairing are neither copied nor reassigned. Configure root's
provider logins and pairing in that context. Keep root's code, Node executable
and all parent directories root-owned and non-writable by other accounts.
The local approval governs managed installation/gateway access; existing direct
development execution remains a separate path. Runtime task policies, native
backend restrictions, evidence checks and credential exclusions remain in force.

## Ordinary user installation

```sh
./install.sh
bzzy-core doctor
bzzy-core workspace set "$HOME/BZZY"
bzzy-core start
```

`doctor` checks Node, Python, the private host directory and the native service
manager without starting a daemon or reading account secrets. It does not claim
provider login, Relay enrollment or Apple push readiness. Configure providers
privately on the host. Core prepares and registers its own public identity
automatically, then use CLI Settings → Pair iPhone. Keep the same user and private
`BZZY_HOME` across normal reinstalls to retain one host identity and its pairing. Settings and pairing
do not require a model. This own-phone flow requests full session control,
terminal catalog access, project sharing and Agent management without permission
pickers; fingerprint confirmation, expiry and revocation remain. The four main
Settings entries are API keys, Default BZZY folder, Pair iPhone and BZZY Core.

The installer prepares a disabled user-service manifest without starting Core.
Opening plain `bzzy` activates that same service automatically. Simple controls:

```sh
bzzy-core start
bzzy-core status
bzzy-core stop
bzzy-core restart
```

`start` checks prerequisites, prepares a missing manifest and starts the native
user service. `status` reports engine and service without starting anything.
`stop` pauses and verifies all queued/running work before disabling/unloading
Core. `restart` unloads only the control daemon and starts its supervisor again.
Detached execution runners keep running, with the same execution IDs and process
identities. Clients reattach and replay only missing events. Previously paused
goals stay paused. A short maintenance gate prevents another client from starting
a competing daemon during this handoff. Restart after an explicit Stop finishes
the durable pause barrier before reactivating the service.

Loaded-but-unhealthy and supervisor-waiting jobs still participate in this
handoff. Core retains the outgoing control process identity and waits for both
that process and its native job to stop; deleting a listener file is insufficient.
Readiness requires a matching authenticated health/supervisor PID and does not
hide outdated-manifest errors. Its bounded wait accommodates supervisor restart
throttling. Automatic start failures carry an attempt-specific gate, separate
from explicit user Stop; updater recovery cannot clear a newer explicit Stop.

Advanced `bzzy-core service plan` and `service install --dry-run` print the
manifest without writing or loading anything. `service install` prepares it;
service subcommands also accept start/status/stop/restart. An active manifest
cannot be silently replaced during an upgrade: suspend control first through the combined updater. Service names include
a digest of the private `BZZY_HOME`; separate contexts do not collide. Use the
same owned private directory (mode 700) for every command.

Both platforms run the existing absolute Node/Core `serve` entry, with private
umask 077. There is one Core queue/database/runtime. Only paths needed for
execution are placed in the manifest: HOME, BZZY_HOME, PATH and explicitly set
provider executable/configuration-directory overrides. API keys, passwords and
account tokens are never copied into the manifest. Configure these in Core's
private account settings, rather than relying on a terminal's transient
environment. The captured PATH retains the discovered Python/provider binaries.
Starting/stopping from another terminal keeps that installed PATH. To change
it, review a new plan and reinstall; other executable/account-directory changes
still require plan/install before starting.

Linux `WorkingDirectory` uses systemd's literal path syntax, independently of
the quoted command/environment fields. The generated path escapes `%` specifiers
and ends with `/.` to retain literal trailing whitespace/backslashes. Earlier
quoted working-directory fields could leave units in `bad-setting` even with a
healthy user manager. Updating through the compatibility repair reinstalls the
corrected manifest; then a fresh `bzzy` launch starts the same private context.

If a programmatic/development Core owns this context, `start` refuses to create
a second engine. `restart` safely pauses and stops that standalone daemon,
then migrates the same private context to supervision.

Stop records durable user intent. Existing CLI metrics/observation polling
cannot reactivate Core. Only explicit `bzzy-core start/restart` or a new `bzzy`
invocation clears that intent. The new CLI uses the prepared service; source/test
contexts without a manifest retain their existing engine path. `BZZY_DIRECT=1`
remains an isolated direct-execution path. Help/version never start Core.

`bzzy-core service uninstall` stops work and removes only BZZY's owned manifest.
Projects, SQLite history, root configuration, host identity and provider accounts
are preserved. Detached executions and descendants participate in the verified
pause barrier; Core stop does not secretly leave agents running. Reopening Core
preserves paused goals and history.

On macOS the manifest is a per-user LaunchAgent under
`~/Library/LaunchAgents/app.bzzy.core.<context>.plist`. It runs at graphical user
login and keeps Core alive while that login remains active and the Mac is awake.
Private supervisor output is `BZZY_HOME/runtime/host-service.log`. This does not
configure a system LaunchDaemon, prevent sleep or prove boot-before-login
operation. Keychain availability still depends on that user's login.

On Debian/Ubuntu the manifest is
`~/.config/systemd/user/bzzy-core-<context>.service`. `start` uses
`systemctl --user enable --now`; inspect output with
`journalctl --user -u bzzy-core-<context>.service`. A user manager is required.
For startup before login, an administrator must explicitly enable lingering for
the execution user. BZZY never grants that permission or runs privileged setup.
The supported systemd manifest is fixture-tested here; native Linux
installation/reboot recovery needs a Linux host or VM.

For upgrades, stop Core, install the new release, run
`doctor`, review/reinstall its service manifest, then start and verify status.
Keep the old release until history and Relay reconnect are verified. Private
state is separate from release files. Do not delete the active Node/release
directory while a service still points to it.

Implementation follows the official
[systemd command/environment rules](https://www.freedesktop.org/software/systemd/man/253/systemd.service.html)
and [Apple launchd job configuration](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).
