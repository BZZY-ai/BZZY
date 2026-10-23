# Existing Relay upgrade and Mac host enrollment

This handoff targets the recorded Debian server only: SSH port **36716**, Relay
code `/opt/bzzy-relay`, state `/var/lib/bzzy-relay`, non-root user/group
`bzzy-relay`, Node `/usr/local/bin/node`, unit `bzzy-relay.service`, loopback
`127.0.0.1:8787`, and normal public TLS at `190.114.255.214`. It does not install
Node, change the unit, Caddy, SSH, firewall, accounts or system packages.

The expanded release handoff contains `operator-upgrade.sh`, `operator-state.mjs`,
`mac-host.public.json`, `SHA256SUMS` and a self-contained `release/` with locked
production dependencies, tests and a content-addressed `RELEASE.json`. Only the
Mac's signed **public** certificate is included. No private endpoint identity,
Core owner token, provider account, `.env`, invitation code or local database is
part of the bundle. Compare its SHA-256 with the trusted local handoff receipt.

Use an existing authorized operator account; the bundle contains no SSH key and
cannot provide administration access. Transfer it through that existing route,
for example `scp -P 36716 HANDOFF.tar.gz OPERATOR@190.114.255.214:/var/tmp/`.
Do not paste a password/private key into BZZY chat or put it in a script.

Inspect the installed service before any write:

```sh
/usr/local/bin/node --version
systemctl show bzzy-relay.service --property=User,Group,WorkingDirectory,ExecStart,MainPID,ActiveState
sha256sum /opt/bzzy-relay/src/server.js /opt/bzzy-relay/src/protocol.js /opt/bzzy-relay/src/store.js
/usr/local/bin/node --input-type=module -e 'const {LIMITS,VERSION}=await import("file:///opt/bzzy-relay/src/protocol.js"); console.log(JSON.stringify({wireVersion:VERSION,requestsPerMinute:LIMITS.requestsPerMinute,transferRequestsPerMinute:LIMITS.transferRequestsPerMinute??null,maxPortableGrantTtlSeconds:LIMITS.maxPortableGrantTtlSeconds??null}))'
curl --fail https://190.114.255.214/healthz
```

Wire version 1 and package version 0.1.0 alone do not identify the newer transfer
budgets; compare the source fingerprints and limit values. Do not use `env`,
`printenv`, shell tracing or broad process dumps to troubleshoot enrollment.

After checking the trusted archive checksum, expand it in an operator-owned
directory. Read the scripts and compare the printed certificate fingerprint
with `mac-host.public.json` on the Mac. The default plan is read-only:

```sh
cd EXPANDED_HANDOFF
bash ./operator-upgrade.sh --plan
sudo bash ./operator-upgrade.sh --apply
```

`--apply` validates the exact existing service identity/paths and health; stages
and tests code as `bzzy-relay`; stops only Relay; backs up the complete consistent
state directory privately under `/var/backups/bzzy-relay/`; enrolls the exact
public host; verifies schema 1 and that revoked devices/grants and consumed
invitations were not reopened; swaps code; and checks local/public TLS health.
An already installed identical release with the exact enrolled host is a no-op.
Previously revoked certificates cannot be silently re-enrolled.

The underlying enrollment command, executed by the script, is:

```sh
sudo -u bzzy-relay /usr/bin/env -i HOME=/var/lib/bzzy-relay PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/node /opt/bzzy-relay/bin/relay.js host-add \
  --state /var/lib/bzzy-relay --certificate /OPERATOR-READABLE/mac-host.public.json
```

If activation fails, the script attempts **code-only rollback** and keeps the
current database and all revocations. Its private receipt records the retained
old code directory and consistent state backup. Never restore an older database
to undo a code release: that can resurrect previously revoked access. A manual
code rollback stops the unit, renames current code aside, moves the recorded
previous directory back to `/opt/bzzy-relay`, and starts the unchanged unit.
Keep `/var/lib/bzzy-relay` in place. Review schema compatibility first; this
handoff requires schema 1 before and after enrollment. If metadata/enrollment
verification fails, Relay remains stopped for operator review; unverified state
is never exposed by automatically restarting the old code.

After success, inspect `systemctl status bzzy-relay` and the bounded private
journal with `journalctl --namespace=bzzy-relay -u bzzy-relay`. Then connect Core
from the Mac and pair the iPhone by QR/code with independent fingerprint
confirmation. Public health alone proves neither host enrollment nor a working
Core↔Relay↔iPhone session. Record those actual checks separately. No production
deployment or enrollment has occurred merely because this handoff exists.
