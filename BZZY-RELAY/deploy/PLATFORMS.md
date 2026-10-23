# Debian and Ubuntu server compatibility

Supported Relay server targets are **Debian 13** and **Ubuntu Server 24.04 LTS**,
using Node.js >=24, systemd, Caddy and private SQLite storage. Both run the same
source, protocol and dependency lockfile. There is no second backend/runtime.
Use x86_64 or ARM64 where the selected Node release supports the OS; current
Linux validation is x86_64. ARM64 still requires target validation.

| Target | Verification |
| --- | --- |
| Debian 13 / x86_64 | Native 19-test suite/demo; deployed service; public TLS/WSS pairing, encrypted delivery and revocation; full VPS reboot and persisted state |
| Ubuntu 24.04.5 / x86_64 | All 19 tests and demo passed as an unprivileged user in official Ubuntu Base userspace with its own PID/proc mount namespace on the Debian host |

The Ubuntu check proves userspace/runtime behavior, not a separate Ubuntu VM's
boot, firewall or TLS renewal. The systemd/Caddy templates target both systems;
validate service hardening and public connectivity on each actual installation.
macOS is not a Relay server deployment target. Earlier native macOS tests are
local development evidence only; no macOS service adapter is shipped.

Install a supported Node >=24 build for the target architecture. Distro defaults
may be older. Run `npm ci --ignore-scripts`, `npm run check`, `npm test` and
`npm run demo` on the target before enabling the supervised service. Check the
absolute Node executable path in `bzzy-relay.service`.

Follow this directory's `README.md`. The service uses a dedicated non-root user,
private StateDirectory, read-only system/home, no capabilities, namespaces and
privilege restrictions, disabled core dumps, resource/log limits, and loopback-only
IP access. Caddy owns the public TLS connection. Inspect startup warnings and
kernel/systemd BPF support; do not claim IP filtering is enforced if unavailable,
or silently remove it. Endpoint encryption and the home gateway's independent
authorization remain mandatory even when OS hardening is active.

The deployed Debian VPS uses an isolated systemd journal namespace `bzzy-relay`
for Relay/Caddy: 100 MiB persistent, 50 MiB runtime, seven-day retention, plus
service log rate limits. Read logs with:

```sh
journalctl --namespace=bzzy-relay -u bzzy-relay
```

For a public domain use `Caddyfile`; for a public IP use `Caddyfile.ip` and current
Caddy support for ACME shortlived certificates. Keep the configured public
audience identical in Relay and clients. On the deployed host, Caddy administration
uses a private UNIX socket under `/run/caddy` (mode 0700), not a TCP admin port,
and its service does not dump environment variables. Operator-only SSH remains
separate from device communication. Keep installed paths and private maintenance
details in the operator's own records; use this directory's `README.md` for setup.
