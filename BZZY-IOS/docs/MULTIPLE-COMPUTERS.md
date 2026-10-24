# Multiple Core computers

The iPhone can save several approved Core hosts on the same configured Relay.
For example, pair a **Test Mac** for dummy work and a **Real server** for production,
then set Real server as the default in the computer selector. The default opens
on a new app launch. Background/foreground transitions keep an explicit selection
within that app session; they do not interrupt a test conversation. Tapping a
host-specific notification is an explicit navigation intent and may select that
saved host instead.

## Setup and behavior

1. Install Core/CLI and configure providers independently on each supported host.
   Use a separate private Core directory and identity on each computer; do not
   copy the other computer's identity or account binding files.
2. Enroll each Core's signed public host certificate on the Relay through its
   existing operator setup. No endpoint secret or Core owner token goes to Relay.
3. On iPhone, open the computer selector and choose Add computer. Use the new
   computer's CLI Pair iPhone QR/code and compare/approve fingerprints normally.
4. Give each saved computer a clear local name and choose Set default for the
   production host. A second pairing does not replace the first or change an
   existing default automatically.

An offline default stays selected and shows Offline; the app does not silently
send work to another computer. The picker remains available to choose a working
host. Only a fresh authorized Core response enables that host's actions; Relay
presence alone cannot establish Online. Inactive computers are not shown as
verified online without a current Core proof.

Switching closes the old client observation and resets visible navigation, forms,
metrics and catalogs before the new host can receive input. It does not pause,
cancel or replay Core work. Pending command identities and acceptance recovery
remain scoped to the original host. Chat caches and typed drafts do not merge,
even if two copied databases contain the same session UUID.

## Private state and compatibility

The existing single-host device-only Keychain authorization migrates atomically
into saved profiles. Host certificate pins, grants, pending receipts and each
host's selected conversation stay separate. Protected files cache bounded catalog
and chat projections by host identity. Changing the default is a local phone
preference, independent of either Core's default assistant/model configuration.

Revocation or removal affects the selected host profile and its cached data,
without erasing other computers. Provider authentication and Core owner credentials
remain on their respective hosts. The phone continues using its existing device
identity; each computer independently approves it.

The phone’s activity-alert preference applies to all saved computers. Updating it
synchronizes each reachable Core through its own approved grant without changing
the visible workspace. Turning alerts off also unregisters the phone with Apple
immediately, including while a computer is offline; reconnect retries Core-side
synchronization. Removing one computer attempts to revoke only that computer’s
push binding. Re-enabling waits for a fresh Apple device registration.

After Core advertises host-routing support, the app opts into host hints during
private registration. Older Cores and existing registrations retain their legacy
payload shape. Goal, Agent and update push hints may contain `bzzy.hostId`, the originating Core's
pinned public certificate fingerprint. This is a navigation hint, never permission
to run a command. A known profile must still authenticate its Core connection.
Unknown host hints do not enroll or select an arbitrary server. Older notifications
without a host ID use a uniquely known saved context or a single saved profile;
ambiguous cases ask which computer to inspect.

The Relay remains encrypted transport. Co-locating production Core on the Relay
VPS changes the security assumption: root compromise could then reach Core's
private keys and local chat database. Separate hosts retain that boundary.
