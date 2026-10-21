#!/usr/bin/env bash
set -euo pipefail
bzzy_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
bzzy_ref="$bzzy_root/codex-0.162.0"
if [[ -e "$bzzy_ref" ]]; then
  bzzy_commit="$(git -C "$bzzy_ref" rev-parse HEAD)"
  [[ "$bzzy_commit" == c1382380de69521303b416720a52f42d51af6248 ]] || { echo 'Existing reference is a different commit; leaving it untouched.' >&2; exit 1; }
else
  git clone --depth 1 --branch rust-v0.162.0 https://github.com/openai/codex.git "$bzzy_ref"
  [[ "$(git -C "$bzzy_ref" rev-parse HEAD)" == c1382380de69521303b416720a52f42d51af6248 ]] || { echo 'Reference tag did not resolve to the pinned commit.' >&2; exit 1; }
fi
echo "Codex 0.162.0 reference: $bzzy_ref"
