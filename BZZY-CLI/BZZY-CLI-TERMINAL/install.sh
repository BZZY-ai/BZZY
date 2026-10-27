#!/usr/bin/env bash
set -euo pipefail

bzzy_prepare_only=0
bzzy_allow_root=0
bzzy_replace_wrapper=0
for bzzy_argument in "$@"; do
  case "$bzzy_argument" in
    --prepare-only) bzzy_prepare_only=1 ;;
    --allow-root) bzzy_allow_root=1 ;;
    --replace-account-wrapper) bzzy_replace_wrapper=1 ;;
    *) echo 'Usage: install.sh [--prepare-only] [--allow-root] [--replace-account-wrapper]' >&2; exit 1 ;;
  esac
done
bzzy_install_uid="$EUID"
if [[ "$bzzy_allow_root" == 1 || "$bzzy_replace_wrapper" == 1 ]]; then
  [[ "$bzzy_install_uid" == 0 && "$(/usr/bin/uname -s)" == Linux ]] || { echo 'Root installation options require Linux and the root account.' >&2; exit 1; }
fi
if [[ "$bzzy_replace_wrapper" == 1 && "$bzzy_allow_root" != 1 ]]; then
  echo 'Use --allow-root with --replace-account-wrapper to replace an existing account-switching launcher.' >&2
  exit 1
fi
# Choosing root installation also authorizes conversion of recognized owned
# account-switching BZZY wrappers; the writer preserves private backups.
if [[ "$bzzy_allow_root" == 1 ]]; then bzzy_replace_wrapper=1; fi

bzzy_script_directory=.
if [[ "${BASH_SOURCE[0]}" == */* ]]; then bzzy_script_directory="${BASH_SOURCE[0]%/*}"; fi
bzzy_root="$(cd -- "$bzzy_script_directory" && pwd -P)"
bzzy_runtime="$bzzy_root/.bzzy-runtime"
bzzy_node="$(command -v node || true)"
bzzy_private_node="$bzzy_runtime/node/bin/node"
bzzy_python=python3
if [[ "$bzzy_install_uid" == 0 ]]; then bzzy_python=/usr/bin/python3; fi
echo 'Installing bzzy...'

# Whole-project sharing/import uses the standard-library ZIP helper. Report the
# prerequisite before downloads or installation, without privileged OS changes.
if ! command -v "$bzzy_python" >/dev/null || ! "$bzzy_python" -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  echo 'BZZY requires Python 3.9+ (python3) for project sharing/import. Install it with your OS package manager, then run this installer again.' >&2
  exit 1
fi

# A root install must not execute another account's Node or product code.
# Check ownership before the first Node version probe, without executing any
# source files, shell launchers or private account configuration.
bzzy_root_preflight() {
  [[ "$bzzy_install_uid" == 0 ]] || return 0
  "$bzzy_python" -I - "$bzzy_root" "${1-$bzzy_node}" "$bzzy_private_node" <<'PY'
import os, pathlib, stat, sys
checked = set()
def owned(value):
    value = os.fspath(value)
    if not pathlib.Path(value).is_absolute() or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise RuntimeError()
    current = pathlib.Path(value).resolve(strict=True)
    for part in (current, *current.parents):
        if part in checked:
            break
        info = part.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError()
        checked.add(part)
    return current
try:
    source = owned(sys.argv[1])
    pending = [source]
    for sibling in ('BZZY-CORE', 'BZZY-RELAY'):
        candidate = source.parent.parent / sibling
        if candidate.exists():
            pending.append(owned(candidate))
    visited = set()
    while pending:
        current = pending.pop()
        info = current.lstat()
        if info.st_uid != 0 or not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022:
            raise RuntimeError()
        if stat.S_ISLNK(info.st_mode):
            pending.append(owned(current))
        elif stat.S_ISDIR(info.st_mode):
            identity = (info.st_dev, info.st_ino)
            if identity not in visited:
                visited.add(identity)
                pending.extend(current.iterdir())
        elif not stat.S_ISREG(info.st_mode):
            raise RuntimeError()
    selected = ''
    for index, value in enumerate(sys.argv[2:]):
        if value and pathlib.Path(value).exists():
            canonical = owned(value)
            if index == 0:
                selected = str(canonical)
    print(selected)
except (OSError, RuntimeError):
    sys.exit('Root installation requires root-owned source, runtime and ancestor directories that other accounts cannot modify. Use a fresh root-owned checkout and Node installation; existing account data was not changed.')
PY
}
if [[ "$bzzy_install_uid" == 0 ]]; then
  bzzy_node="$(bzzy_root_preflight "$bzzy_node")"
  if [[ -x "$bzzy_private_node" ]]; then bzzy_private_node="$(bzzy_root_preflight "$bzzy_private_node")"; fi
fi

if [[ -x "$bzzy_private_node" ]] && { [[ -z "$bzzy_node" ]] || ! "$bzzy_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; }; then
  bzzy_node="$bzzy_private_node"
fi

if [[ -z "$bzzy_node" ]] || ! "$bzzy_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  command -v curl >/dev/null || { echo 'bzzy needs curl to install its private Node runtime.' >&2; exit 1; }
  case "$(uname -s)" in Linux) bzzy_os=linux;; Darwin) bzzy_os=darwin;; *) echo 'Use Node 24+ and npm install -g . on this platform.' >&2; exit 1;; esac
  case "$(uname -m)" in x86_64|amd64) bzzy_arch=x64;; aarch64|arm64) bzzy_arch=arm64;; *) echo 'Unsupported CPU architecture.' >&2; exit 1;; esac
  mkdir -p "$bzzy_runtime"
  bzzy_tmp="$(mktemp -d "$bzzy_runtime/download.XXXXXX")"
  trap 'rm -rf -- "$bzzy_tmp"' EXIT
  echo 'Preparing the bzzy runtime...'
  curl --fail --silent --show-error --location --proto '=https' https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$bzzy_tmp/SHASUMS256.txt"
  bzzy_archive="$(awk -v suffix="-$bzzy_os-$bzzy_arch.tar.gz" 'substr($2,length($2)-length(suffix)+1)==suffix {print $2; exit}' "$bzzy_tmp/SHASUMS256.txt")"
  [[ -n "$bzzy_archive" ]] || { echo 'Could not resolve the Node runtime.' >&2; exit 1; }
  curl --fail --silent --show-error --location --proto '=https' "https://nodejs.org/dist/latest-v24.x/$bzzy_archive" -o "$bzzy_tmp/$bzzy_archive"
  bzzy_expected="$(awk -v archive="$bzzy_archive" '$2==archive {print $1}' "$bzzy_tmp/SHASUMS256.txt")"
  if command -v sha256sum >/dev/null; then bzzy_actual="$(sha256sum "$bzzy_tmp/$bzzy_archive" | awk '{print $1}')";
  else bzzy_actual="$(shasum -a 256 "$bzzy_tmp/$bzzy_archive" | awk '{print $1}')"; fi
  [[ "$bzzy_actual" == "$bzzy_expected" ]] || { echo 'Node checksum verification failed.' >&2; exit 1; }
  mkdir -p "$bzzy_tmp/node"
  tar --no-same-owner -xzf "$bzzy_tmp/$bzzy_archive" --strip-components=1 -C "$bzzy_tmp/node"
  if [[ -e "$bzzy_runtime/node" ]]; then rm -rf -- "$bzzy_runtime/node"; fi
  mv "$bzzy_tmp/node" "$bzzy_runtime/node"
  bzzy_node="$bzzy_runtime/node/bin/node"
fi

if [[ "$bzzy_install_uid" == 0 ]]; then bzzy_node="$(bzzy_root_preflight "$bzzy_node")"; fi
export PATH="$(dirname -- "$bzzy_node"):$PATH"
cd "$bzzy_root"

# Development checkouts install the locked Relay SDK and link the shared Core.
# Release tarballs already contain this dependency tree and work without npm or
# the original sibling source directories. Neither path installs AI backends.
if [[ "${BZZY_INSTALL_PREPARED:-0}" == 1 ]]; then
  [[ -f "$bzzy_root/node_modules/@bzzy/core/package.json" ]] || { echo 'Prepare the release dependencies first.' >&2; exit 1; }
elif [[ -f "$bzzy_root/../../BZZY-CORE/package.json" ]]; then
  bzzy_npm="$(command -v npm || true)"
  [[ -n "$bzzy_npm" ]] || { echo 'The BZZY source workspace needs npm from the selected Node installation.' >&2; exit 1; }
  if [[ "$bzzy_install_uid" == 0 ]]; then bzzy_npm="$(bzzy_root_preflight "$bzzy_npm")"; fi
  (cd "$bzzy_root/../../BZZY-CORE" && "$bzzy_npm" ci --ignore-scripts --install-links=true --no-audit --no-fund)
  "$bzzy_npm" ci --ignore-scripts --install-links=false --no-audit --no-fund
elif [[ ! -f "$bzzy_root/node_modules/@bzzy/core/package.json" ]]; then
  echo 'BZZY Core is missing. Use a bundled BZZY release or keep BZZY-CORE and BZZY-RELAY beside BZZY-CLI in the complete source workspace.' >&2
  exit 1
fi

if [[ "$bzzy_prepare_only" == 1 ]]; then
  echo 'Release prepared. Launchers and Core service are unchanged.'
  exit 0
fi

bzzy_bin_dir="${BZZY_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bzzy_bin_dir"
bzzy_launcher_command=("$bzzy_node" "$bzzy_root/scripts/install-launcher.mjs" "$bzzy_bin_dir" "$bzzy_node")
if [[ "$bzzy_replace_wrapper" == 1 ]]; then bzzy_launcher_command+=(--replace-account-wrapper); fi
"${bzzy_launcher_command[@]}" --check

# Prepare a disabled user manifest. A fresh bzzy invocation or bzzy-core start
# explicitly enables it; installation never starts a model or daemon.
if [[ "${BZZY_SKIP_SERVICE_SETUP:-0}" != 1 ]]; then
  bzzy_service_command=("$bzzy_node" "$bzzy_root/bin/bzzy-core.js" service install)
  if [[ "$bzzy_allow_root" == 1 ]]; then bzzy_service_command+=(--allow-root); fi
  "${bzzy_service_command[@]}" >/dev/null
elif [[ "$bzzy_allow_root" == 1 ]]; then
  echo '--allow-root requires service setup so its explicit authorization can be saved.' >&2
  exit 1
fi

"${bzzy_launcher_command[@]}"
"$bzzy_node" "$bzzy_root/bin/bzzy.js" --version >/dev/null

echo
echo 'bzzy is installed. Run: bzzy'
echo 'Core administration is available with: bzzy-core help'
echo 'Check this host with: bzzy-core doctor'
echo 'Core: bzzy-core start | status | stop | restart'
echo 'Opening bzzy starts its prepared Core service automatically.'
case ":$PATH:" in
  *":$bzzy_bin_dir:"*) ;;
  *)
    echo "Your shell does not include $bzzy_bin_dir on PATH."
    echo "For this shell: export PATH=\"$bzzy_bin_dir:\$PATH\""
    if [[ "${BZZY_NO_PATH_UPDATE:-0}" != 1 ]]; then
      "$bzzy_node" "$bzzy_root/scripts/install-launcher.mjs" "$bzzy_bin_dir" "$bzzy_node" --path
      echo 'PATH setup was added for future shells.'
    fi
    ;;
esac
