# Single-VPS deployment

Target Debian 13 minimal or Ubuntu Server 24.04, Node.js >=24, Caddy and systemd.
The server template is loopback-only and deliberately refuses a root runtime.
No deployment is implied by running tests. Install only Relay and its npm
dependencies on the VPS; the CLI/LLM runtime remains on the home host.
macOS server deployment is not required. See `PLATFORMS.md` for exact target
verification. Keep live installation records and private configuration outside Git.

## Prerequisites and installation

1. Verify SSH access, OS/architecture, available memory/disk, existing listeners
   and firewall rules. Preserve unrelated services and existing proxy configuration.
2. Install a supported Node 24+ build from a trusted source. Check `node --version`;
   distro defaults may be too old. The unit expects `/usr/local/bin/node`; adjust
   it to the verified absolute binary path. Install Caddy using its official
   distribution instructions, and enable time synchronization.
3. Point a hostname at the VPS, or use `Caddyfile.ip` for a public IP certificate,
   and allow inbound TCP 80/443. Keep 8787 private and
   retain the SSH rule. Do not flush an existing firewall or disable SSH before
   verifying another access path.
4. Create a system user `bzzy-relay` with no login and a private state directory
   `/var/lib/bzzy-relay`, owned by that user with mode 0700. Install this package
   under `/opt/bzzy-relay`, owned by the operator and read-only to the runtime.
   Run `npm ci --omit=dev --ignore-scripts` in the package. Do not copy endpoint
   identities, `.env` files, Core state or account credentials to the VPS.
5. Copy `bzzy-relay.service` into `/etc/systemd/system/`. Replace its reserved
   example hostname with the actual public hostname. Merge the supplied Caddy
   site into the existing configuration, using the same hostname. Confirm the
   Node binary and service/state ownership before starting.
6. Validate Caddy configuration and `systemd-analyze verify` the unit on Linux.
   Then reload systemd, start/enable Relay and reload/start Caddy. Caddy manages
   certificates and renewal; never disable certificate verification in clients.

The supplied `caddy-security.conf`, `relay-logging.conf` and
`journald@bzzy-relay.conf` reproduce the deployed private administration socket,
environment-safe startup and isolated bounded journal. Install them at the paths
in their comments and add `admin unix//run/caddy/admin.sock` in the Caddyfile's
global block. Validate before restarting; Caddy reload then uses that private
socket. Preserve an existing proxy's management configuration when integrating.

The SSH administrator may provision a home host by transferring only its public
certificate, then running this command as the service user:

```sh
sudo -u bzzy-relay /usr/local/bin/node /opt/bzzy-relay/bin/relay.js host-add \
  --state /var/lib/bzzy-relay --certificate /path/readable-by-service/host.public.json
```

Updated Core clients register their own public certificate through authenticated
`host.register`; manual host-add is optional. This operation takes no certificate
parameter, cannot enroll another identity, does not restore revoked identities and
uses the existing connection/request/device quotas. Registration provides routing
identity only; application authorization still requires explicit host fingerprint
approval and Core’s local grant. Repeated registration is idempotent by device ID.

## Verification and maintenance

- Check `systemctl status bzzy-relay` and `curl https://YOUR_HOST/healthz` with
  normal certificate verification. Test a WSS connection from outside the VPS.
- Pair disposable test endpoints, send an encrypted fixture, reconnect and revoke
  it. Remove/revoke test authorizations after validation. Verify the listener at
  8787 is reachable only on loopback and no home inbound ports are required.
- Review fixed audit events through `journalctl --namespace=bzzy-relay -u bzzy-relay`
  when using the supplied logging drop-in. No codes, payloads,
  certificate keys, headers or request bodies are emitted by Relay. Do not enable
  proxy debug/body logging. Set system journal retention/size limits appropriate
  for the whole VPS, e.g. an operator-reviewed 100 MiB cap and 7-day retention.
  Do not overwrite unrelated global journald settings without review.
- Monitor RSS/CPU, connection count, buffered bytes and pending receipts (available
  to local code via `relay.metrics()`), disk usage, certificate expiry and traffic.
  Run `npm run measure` on the target as a smoke check; it is not a sustained-load
  benchmark. Measure TLS proxy and kernel memory separately.
- Update with `npm ci --omit=dev --ignore-scripts`, rerun tests before release,
  stage files, atomically switch releases, and restart Relay. Existing sockets
  reconnect; applications resume from Core cursors without resending commands.
- Back up only Relay metadata/configuration, with private permissions. For a
  simple consistent backup, stop Relay, copy the SQLite file and any sidecars,
  then restart. Restore the whole consistent set; never mix old grants with a
  newer revocation state. If a backup predates a revocation, reapply it before
  exposing the service. Payloads and endpoint private keys have no Relay backup.
- `device-revoke --state /var/lib/bzzy-relay --id OPAQUE_ID` globally revokes a
  device. Active requests are denied immediately and open sockets close within
  the maintenance interval. Host `peer.revoke` affects only that host's grants.
- Roll back by restoring the prior package release with the compatible schema;
  keep the current metadata/revocations. Uninstall by disabling the Relay unit,
  removing its proxy site, then deleting package/state only when no longer needed.

Service hardening includes no capabilities, a read-only system/home, private temp
and devices, 512 MiB memory maximum, bounded processes/file descriptors and disabled
core dumps. These are Linux service controls; the macOS test suite does not prove
systemd or certificate issuance works on the target. DNS/certificate and public
network checks must be recorded after an actual deployment.

References: [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[WebSocket compression and backpressure](https://github.com/websockets/ws),
[Node SQLite](https://nodejs.org/api/sqlite.html).

## Apple background alerts

The service optionally reads `STATE_DIRECTORY/push/apns.json` using the strict
schema documented in [Core push setup](../../BZZY-CORE/docs/PUSH.md). Keep that
configuration and its P256 signing key outside the source/deployment checkout,
owned by the dedicated Relay user with mode 0600 (private directory 0700).
Configure the installed iOS build's exact topic and sandbox/production environment.
Missing configuration leaves queued alerts pending; transport health alone does
not prove push readiness. Normal upgrades preserve the private state directory
and SQLite goal-alert queue. Never copy Core owner/provider credentials here.
