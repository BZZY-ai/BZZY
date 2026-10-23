#!/usr/bin/env bash
# Applies SECURITY.md: only the pinned public host certificate is enrolled.
# No endpoint keys, account credentials, payloads, environment dumps or shell eval.
set +x
set -euo pipefail
umask 077

MODE=${1:---plan}
[[ $# -le 1 && ( "$MODE" == --plan || "$MODE" == --apply ) ]] || { echo 'Usage: ./operator-upgrade.sh [--plan|--apply]' >&2; exit 2; }
BUNDLE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SOURCE="$BUNDLE/release"
CERT="$BUNDLE/mac-host.public.json"
NODE=/usr/local/bin/node
SERVICE=bzzy-relay.service
CURRENT=/opt/bzzy-relay
STATE=/var/lib/bzzy-relay
PUBLIC_HEALTH=https://190.114.255.214/healthz
STAGE= BACKUP= PREVIOUS= FAILED= STOPPED=0 SWITCHED=0 STATE_OK=1 DONE=0
die() { echo "$1" >&2; exit 1; }
# The administrator may expand this bundle below /root. Never inherit an
# administrator-only working directory when executing as the service account.
as_relay() ( cd /; /usr/sbin/runuser --user bzzy-relay -- /usr/bin/env -i HOME="$STATE" PATH=/usr/local/bin:/usr/bin:/bin NODE_NO_WARNINGS=1 "$@"; )
health() { curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "$1" | "$NODE" --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;if(JSON.parse(s).ok!==true)process.exit(1)'; }
rollback() {
  local result=$?
  trap - EXIT
  if [[ "$DONE" != 1 && "$STOPPED" == 1 ]]; then
    echo 'Upgrade failed. Keeping CURRENT database/revocations; attempting code-only rollback.' >&2
    /bin/systemctl stop "$SERVICE" || true
    if [[ "$SWITCHED" == 1 && -d "$PREVIOUS" ]]; then
      mv -- "$CURRENT" "$FAILED" || true
      if [[ ! -e "$CURRENT" ]]; then mv -- "$PREVIOUS" "$CURRENT" || true; fi
    fi
    if [[ "$STATE_OK" == 1 ]]; then /bin/systemctl start "$SERVICE" || true
    else echo 'Metadata verification did not complete; Relay remains STOPPED for operator review.' >&2; fi
    echo "Inspect $BACKUP and systemctl status $SERVICE. Never restore the old database automatically." >&2
  fi
  [[ -z "$STAGE" || ! -d "$STAGE" ]] || rm -rf -- "$STAGE"
  exit "$result"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -x "$NODE" && -d "$SOURCE" && -f "$CERT" && -f "$BUNDLE/SHA256SUMS" ]] || die 'Use the complete expanded handoff bundle and installed /usr/local/bin/node.'
"$NODE" -e 'if(+process.versions.node.split(".")[0]<24)process.exit(1)' || die 'Node >=24 is required; this script does not install or change Node.'
(cd -- "$BUNDLE" && sha256sum --check --strict SHA256SUMS >/dev/null) || die 'Bundle checksum verification failed.'
RELEASE=$("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).releaseId' "$SOURCE/RELEASE.json")
[[ "$RELEASE" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid release identity.'
"$NODE" "$BUNDLE/operator-state.mjs" certificate "$STATE" "$CERT"
[[ "$(/bin/systemctl show "$SERVICE" --property=User --value)" == bzzy-relay ]] || die 'Existing service must run as bzzy-relay.'
[[ "$(/bin/systemctl show "$SERVICE" --property=Group --value)" == bzzy-relay ]] || die 'Existing service group differs; review it manually.'
[[ "$(/bin/systemctl show "$SERVICE" --property=WorkingDirectory --value)" == "$CURRENT" ]] || die 'Existing WorkingDirectory differs; no changes made.'
EXEC=$(/bin/systemctl show "$SERVICE" --property=ExecStart --value)
[[ "$EXEC" == *'/usr/local/bin/node'* && "$EXEC" == *'/opt/bzzy-relay/bin/relay.js serve'* && "$EXEC" == *'--state /var/lib/bzzy-relay'* && "$EXEC" == *'--audience wss://190.114.255.214/v1/socket'* && "$EXEC" == *'--port 8787'* ]] || die 'Existing ExecStart differs; review it manually.'
[[ -d "$CURRENT" && ! -L "$CURRENT" && -d "$STATE" && ! -L "$STATE" ]] || die 'Expected real package/state directories; symlinks are not upgraded.'
[[ "$(stat -c '%U:%a' "$STATE")" == bzzy-relay:700 ]] || die 'State must be owned by bzzy-relay with mode 700.'
/bin/systemctl is-active --quiet "$SERVICE" || die 'Existing Relay is not active. Inspect it before attempting this upgrade.'
health http://127.0.0.1:8787/healthz
health "$PUBLIC_HEALTH"
echo "Target release: $RELEASE"
echo 'Existing package version and source fingerprints (wire v1 alone does not identify the build):'
"$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$CURRENT/package.json"
sha256sum "$CURRENT/src/server.js" "$CURRENT/src/protocol.js" "$CURRENT/src/store.js"
echo 'Plan: validate new code as bzzy-relay; stop only Relay; back up consistent state; enroll the pinned public certificate; swap code; start and check local/public TLS health.'
echo 'Caddy, firewall, SSH, Node, systemd unit and existing SQLite/revocations remain in place. Rollback changes code only.'
if [[ "$MODE" == --plan ]]; then DONE=1; exit 0; fi
[[ $(id -u) == 0 ]] || die '--apply requires the authorized server administrator; Relay itself always runs non-root.'
if [[ -f "$CURRENT/RELEASE.json" ]] && cmp -s "$CURRENT/RELEASE.json" "$SOURCE/RELEASE.json" &&
  (cd -- "$CURRENT" && sha256sum --check --strict "$SOURCE/SHA256SUMS" >/dev/null 2>&1) &&
  "$NODE" "$BUNDLE/operator-state.mjs" host-ready "$STATE" "$CERT" >/dev/null; then
  echo 'This release and exact public host are already installed; no changes.'; DONE=1; exit 0
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGE=$(mktemp -d /opt/.bzzy-relay-stage.XXXXXXXX)
chmod 0755 "$STAGE"
mkdir "$STAGE/package"
cp -a -- "$SOURCE/." "$STAGE/package/"
chown -R root:root "$STAGE/package"
chmod -R a+rX,go-w "$STAGE/package"
cp -- "$CERT" "$STAGE/mac-host.public.json"; chmod 0644 "$STAGE/mac-host.public.json"
as_relay "$NODE" "$STAGE/package/scripts/check.js" >"$STAGE/validation.log" 2>&1
as_relay "$NODE" --test "$STAGE/package"/test/*.test.js >>"$STAGE/validation.log" 2>&1
BACKUP="/var/backups/bzzy-relay/$STAMP-${RELEASE:0:12}"
[[ ! -e "$BACKUP" ]] || die 'Backup path already exists; retry in another second.'
install -d -m 0700 "$BACKUP"
/bin/systemctl stop "$SERVICE"; STOPPED=1
[[ "$(/bin/systemctl show "$SERVICE" --property=MainPID --value)" == 0 ]] || die 'Relay process did not stop; backup is not declared consistent.'
cp -a -- "$STATE" "$BACKUP/state"
"$NODE" "$BUNDLE/operator-state.mjs" snapshot "$STATE" "$CERT" >"$BACKUP/state-before.json"
cp -- "$STAGE/validation.log" "$BACKUP/validation.log"
STATE_OK=0
as_relay "$NODE" "$STAGE/package/bin/relay.js" host-add --state "$STATE" --certificate "$STAGE/mac-host.public.json" >"$BACKUP/enrollment.json"
"$NODE" "$BUNDLE/operator-state.mjs" verify "$STATE" "$CERT" "$BACKUP/state-before.json" >"$BACKUP/state-verified.json"
STATE_OK=1
PREVIOUS="/opt/bzzy-relay.previous.$STAMP-${RELEASE:0:12}"
FAILED="/opt/bzzy-relay.failed.$STAMP-${RELEASE:0:12}"
[[ ! -e "$PREVIOUS" && ! -e "$FAILED" ]] || die 'Rollback path already exists.'
mv -- "$CURRENT" "$PREVIOUS"
SWITCHED=1
if ! mv -- "$STAGE/package" "$CURRENT"; then mv -- "$PREVIOUS" "$CURRENT"; SWITCHED=0; die 'Code activation failed.'; fi
/bin/systemctl start "$SERVICE"
for attempt in {1..20}; do
  if /bin/systemctl is-active --quiet "$SERVICE" && health http://127.0.0.1:8787/healthz; then break; fi
  sleep 1
done
/bin/systemctl is-active --quiet "$SERVICE" || die 'New Relay did not become active.'
health http://127.0.0.1:8787/healthz
health "$PUBLIC_HEALTH"
[[ "$(/bin/systemctl show "$SERVICE" --property=User --value)" == bzzy-relay ]] || die 'Runtime user changed unexpectedly.'
"$NODE" "$BUNDLE/operator-state.mjs" host-ready "$STATE" "$CERT"
printf '%s\n' "release=$RELEASE" "previous=$PREVIOUS" "stateBackup=$BACKUP/state" >"$BACKUP/receipt.txt"
echo "Upgrade and public host enrollment verified. Code rollback: $PREVIOUS"
echo "Private consistent backup and receipt: $BACKUP"
echo 'Verify a Core host connection and reviewed QR pairing next; health alone does not prove end-to-end application readiness.'
DONE=1
