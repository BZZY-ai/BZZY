# Combined CLI and Core updates

Use **Check for updates** in the TUI sidebar or `/update` at any terminal size.
One checker compares the installed workspace commit with the default branch of
`BZZY-ai/BZZY` on GitHub. It uses the host's existing Git authentication without
asking for credentials in chat. Network/authentication failures are displayed;
checking never installs, changes project files or starts model work.

The install action updates the complete workspace, including Core and Relay,
then runs the existing nested CLI installer to refresh both launchers and their
runtime/dependencies. Core work is paused durably. A previously running Core is
started again afterward without replaying paused work. The TUI stays visible
during installation, then reloads the new CLI in the same OS process and terminal.
The current conversation, selected chat tab and unsent composer drafts reopen;
no manual close or relaunch is required. Reloading claims available input without
taking it from another client; a busy lease reopens as a viewer. An explicitly
stopped Core stays stopped and opens local Settings.

The handoff contains UI data only, in a bounded owner-only file under private
Core runtime storage. The new CLI consumes it once; old goals, commands and
model work are never resubmitted. Private/hidden input cannot enter the handoff.
Installation cannot be dismissed through Cancel/Esc while files are changing.
Failures keep the terminal and draft available and report failure. The plain
`bzzy --update` command still completes as a standalone command.

A CLI that predates this behavior still uses its already-loaded updater for the
first upgrade. Reopen it once after that upgrade; subsequent TUI updates reload
automatically.

Checks enforce a complete Git checkout, an official GitHub origin, an attached
default branch and a clean worktree across the entire workspace. Local edits,
untracked files, detached/divergent history and unexpected origins block updates.
The installation and remote revision are rechecked before applying. A lock
prevents concurrent updates, and Git fetches/fast-forwards to the exact revision
shown in the checker rather than a moving branch tip. There is no reset, merge
commit, auto-stash, credential transfer or change to global Git trust.

The existing `bzzy --update` command remains available. Installer failures return
an explicit retry instruction; downloaded source remains available for repair.
A failed installation is not reported as success. Packaged installations use the
same checker and fetch the official GitHub repository into an owned managed
checkout under `~/.local/share/bzzy/checkout`. The exact checked revision is
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
helper pauses work, runs the same shared installer, restarts a previously running
Core, and records success/failure. The phone temporarily locks Core actions while
Core is offline, then reads status after authorized reconnection. Interrupted jobs
remain uncertain; reconnect does not blindly repeat an install. A lost acceptance
receipt retains the request ID, so an explicit retry refers to the same job.

The encrypted operations are `updates.status`, `updates.check`,
`updates.configure` (boolean preferences) and `updates.install` (checked commit
hash only). These APIs expose safe update metadata and job state, never local
installation paths, credentials, raw helper logs or owner tokens. The iOS app
itself still needs its separately built/distributed app update to display these
controls; host updates install CLI/Core, not the iOS binary.
