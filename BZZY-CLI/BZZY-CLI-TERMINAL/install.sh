#!/usr/bin/env bash
set -euo pipefail

bzzy_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bzzy_runtime="$bzzy_root/.bzzy-runtime"
bzzy_node="$(command -v node || true)"
echo 'Installing bzzy...'

# Whole-project sharing/import uses the standard-library ZIP helper. Report the
# prerequisite before downloads or installation, without privileged OS changes.
if ! command -v python3 >/dev/null || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  echo 'BZZY requires Python 3.9+ (python3) for project sharing/import. Install it with your OS package manager, then run this installer again.' >&2
  exit 1
fi

if [[ -x "$bzzy_runtime/node/bin/node" ]] && { [[ -z "$bzzy_node" ]] || ! "$bzzy_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; }; then
  bzzy_node="$bzzy_runtime/node/bin/node"
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
  tar -xzf "$bzzy_tmp/$bzzy_archive" --strip-components=1 -C "$bzzy_tmp/node"
  if [[ -e "$bzzy_runtime/node" ]]; then rm -rf -- "$bzzy_runtime/node"; fi
  mv "$bzzy_tmp/node" "$bzzy_runtime/node"
  bzzy_node="$bzzy_runtime/node/bin/node"
fi

export PATH="$(dirname -- "$bzzy_node"):$PATH"
cd "$bzzy_root"

# Development checkouts install the locked Relay SDK and link the shared Core.
# Release tarballs already contain this dependency tree and work without npm or
# the original sibling source directories. Neither path installs AI backends.
if [[ -f "$bzzy_root/../../BZZY-CORE/package.json" ]]; then
  command -v npm >/dev/null || { echo 'The BZZY source workspace needs npm from the selected Node installation.' >&2; exit 1; }
  (cd "$bzzy_root/../../BZZY-CORE" && npm ci --ignore-scripts --install-links=true --no-audit --no-fund)
  npm ci --ignore-scripts --install-links=false --no-audit --no-fund
elif [[ ! -f "$bzzy_root/node_modules/@bzzy/core/package.json" ]]; then
  echo 'BZZY Core is missing. Use a bundled BZZY release or keep BZZY-CORE and BZZY-RELAY beside BZZY-CLI in the complete source workspace.' >&2
  exit 1
fi

bzzy_bin_dir="${BZZY_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bzzy_bin_dir"
"$bzzy_node" "$bzzy_root/scripts/install-launcher.mjs" "$bzzy_bin_dir" "$bzzy_node"
"$bzzy_node" "$bzzy_root/bin/bzzy.js" --version >/dev/null

# Prepare a disabled user manifest. A fresh bzzy invocation or bzzy-core start
# explicitly enables it; installation never starts a model or daemon.
if [[ "${BZZY_SKIP_SERVICE_SETUP:-0}" != 1 ]]; then
  "$bzzy_node" "$bzzy_root/bin/bzzy-core.js" service install >/dev/null
fi

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
