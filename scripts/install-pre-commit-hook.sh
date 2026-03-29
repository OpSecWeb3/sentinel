#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_SRC="$ROOT_DIR/.githooks/pre-commit"
HOOK_DST="$ROOT_DIR/.git/hooks/pre-commit"

if [ ! -d "$ROOT_DIR/.git/hooks" ]; then
  echo "Could not find .git/hooks. Run this from the Sentinel repo."
  exit 1
fi

cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"

echo "Installed pre-commit hook at .git/hooks/pre-commit"
echo "Commits will now run gitleaks staged secret scanning."
