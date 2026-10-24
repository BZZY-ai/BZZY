# Combined CLI and Core updates

Use **Check for updates** in the TUI sidebar or `/update` at any terminal size.
One checker compares the installed workspace commit with the default branch of
`BZZY-ai/BZZY` on GitHub. It uses the host's existing Git authentication without
asking for credentials in chat. Network/authentication failures are displayed;
checking never installs, changes project files or starts model work.

The install action stages the checked revision in its own complete workspace at
`~/.local/share/bzzy/versions/<commit>`. Locked dependencies are prepared before
Core control is interrupted (`install.sh --prepare-only`). Activation switches
the CLI/Core launchers and service manifest without running `npm ci` again.
Existing execution runners remain detached, on their original source and
libraries; the updater never merges into or removes an active release.

Core control briefly goes offline while the service is replaced. A previously
running Core starts again and adopts the same execution identities from durable
storage. CLI/iOS replay missing events; no inference is repeated. Previously
paused goals remain paused. The TUI stays visible, then reloads in the same OS
process and terminal. The conversation, selected tab, minimal layout and unsent
drafts reopen. An explicitly stopped Core stays stopped and opens local Settings.

This preserves work across CLI/Core restarts and combined product updates on a
running host. Power loss, OS reboot, forced process termination and provider
failures cannot preserve a live process. Those use the existing durable recovery
path: retain checkpoints and mark uncertain external operations for review,
without blindly repeating actions. Explicit **Stop** still pauses all work.
Old release directories are deliberately retained; do not delete them while a
runner or an older CLI is using them. Automatic release garbage collection and
transparent migration of live runners to new code are not implemented.

The handoff contains UI data only, in a bounded owner-only file under private
Core runtime storage. The new CLI consumes it once; old goals, commands and
model work are never resubmitted. Private/hidden input cannot enter the handoff.
Installation cannot be dismissed through Cancel/Esc while files are changing.
Failures keep the terminal and draft available and report failure. The plain
`bzzy --update` command still completes as a standalone command.

A CLI that predates this behavior still uses its already-loaded updater for the
first upgrade. Reopen it once after that upgrade; subsequent TUI updates reload
automatically.

Source checks verify the complete installation and its official GitHub origin,
then select the official default-branch revision. The installed checkout can be
dirty, detached, on another branch, or contain local commits and untracked user
files. Its location and the shell's current directory do not affect the update:
Core resolves the running installation, and activation uses the existing launcher
location. The original checkout is retained without a pull, reset, auto-stash,
cleanup or dependency replacement. Local customizations stay there; the new
release runs the official product code.

The exact reviewed revision is installed in a separate owned release directory.
If a cached copy of that revision has local edits, unexpected history/origin or
incomplete dependencies, it is retained and a fresh uniquely named checkout is
prepared instead. An unsafe release-root/launcher location, a concurrent update,
missing permissions or unavailable GitHub access still causes a visible failure;
no updater can bypass those requirements. Git trust is scoped to individual
commands and never added globally.

The existing `bzzy --update` command remains available. Installer failures return
an explicit retry instruction; downloaded source remains available for repair.
A failed installation is not reported as success. Packaged installations use the
same checker (including standalone Core packages) and fetch the official GitHub repository into an owned managed
release under `~/.local/share/bzzy/versions/<commit>`. The exact checked revision is
installed there, and the existing CLI/Core launchers are switched by the
installer. The old package and all private Core state remain available; a failed
installation restores the previous launchers and attempts service recovery. No
manual source installation is required. New packages carry their source revision
in `assets/release.json` for update comparisons. The updater does not claim an atomic rollback of
external package/service-manager operations.

## Core watcher and paired iPhone updates

Discovery and installation now live in `BZZY-CORE/src/engine/`; CLI modules are
compatibility exports plus presentation. The daemon checks the official GitHub
default branch on startup and every 15 minutes when an eligible own-phone pairing
exists. Concurrent checks share one request and manual checks have a one-minute
cooldown. Watching never installs. Update availability is cached durably and
notifications are deduplicated by target revision.

In iOS **Settings → BZZY Updates**, the fully approved phone can toggle monitoring,
its update notifications and **Allow updates from this iPhone**, check now, and
confirm **Update CLI and Core** for the displayed revision. Remote installation
starts disabled. Core revalidates the approved base grant, private Core access,
revocation, explicit opt-in and checked revision at acceptance and before helper
launch. No RPC accepts an arbitrary source, path, branch or command. Scoped
terminal/Agent contexts and observer/friend grants cannot install host updates.

An accepted request creates one durable idempotent update job. A detached Core
helper stages the same immutable release, replaces only Core control, restarts a
previously running Core, and records success/failure. Existing runners continue. The phone temporarily locks Core actions while
Core is offline, then reads status after authorized reconnection. Interrupted jobs
remain uncertain; reconnect does not blindly repeat an install. A lost acceptance
receipt retains the request ID, so an explicit retry refers to the same job.

The encrypted operations are `updates.status`, `updates.check`,
`updates.configure` (boolean preferences) and `updates.install` (checked commit
hash only). These APIs expose safe update metadata and job state, never local
installation paths, credentials, raw helper logs or owner tokens. The iOS app
itself still needs its separately built/distributed app update to display these
controls; host updates install CLI/Core, not the iOS binary.

## Older updater compatibility

An already-installed updater may still display “Local changes must be committed
or stashed before updating.” It cannot acquire its own fix through that blocked
check. As your usual BZZY user, run this once from any directory:

```sh
curl -fsSL https://raw.githubusercontent.com/BZZY-ai/BZZY/main/BZZY-CORE/scripts/repair-updater.py | python3
```

The repair reads the installed managed launcher to find its package and Node 24+
runtime, downloads the official updater at a verified commit and invokes the same
separate-release installer. It preserves the original checkout, private state,
existing launcher location and active execution sources. Reopen BZZY afterward;
future updates use `bzzy --update`. A manual/nonstandard launcher can use explicit
`--installation /absolute/package` and `--node /absolute/node` paths after saving
the script locally. No private account configuration is part of the repair.
