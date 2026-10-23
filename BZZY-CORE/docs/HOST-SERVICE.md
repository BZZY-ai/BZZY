# Install and supervise a private Core host

The bundled CLI installer prepares `bzzy` and `bzzy-core`, using an existing
Node.js 24+ or a private Node 24 runtime. Python 3.9+ must be available as
`python3`; the installer checks it before changing anything. It never runs sudo
or installs provider executables, provider accounts or operating-system packages.
Install a release on an internal persistent disk before enabling startup. Do not
point a service at a removable checkout or a temporary npx runtime.

```sh
./install.sh
bzzy-core doctor
bzzy-core workspace set "$HOME/BZZY"
bzzy-core relay init
```

`doctor` checks Node, Python, the private host directory and the native service
manager without starting a daemon or reading account secrets. It does not claim
provider login, Relay enrollment or Apple push readiness. Configure providers
privately on the host. Send only the public identity prepared by `relay init`
to the Relay operator, then use CLI Settings → Pair iPhone. Settings and pairing
do not require a model. This own-phone flow requests full session control,
terminal catalog access, project sharing and Agent management without permission
pickers; fingerprint confirmation, expiry and revocation remain. The three main
Settings entries are DeepSeek API key, Default BZZY folder and Pair iPhone.

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
Core. `restart` performs that stop and a supervised start. Goals stay paused
until explicitly resumed; lifecycle commands never start model work.

Advanced `bzzy-core service plan` and `service install --dry-run` print the
manifest without writing or loading anything. `service install` prepares it;
service subcommands also accept start/status/stop/restart. An active manifest
cannot be silently replaced during an upgrade: stop first. Service names include
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
