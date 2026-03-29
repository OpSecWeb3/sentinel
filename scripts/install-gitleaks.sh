#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$ROOT_DIR/.tools/bin"
GITLEAKS_BIN="$INSTALL_DIR/gitleaks"
VERSION="${GITLEAKS_VERSION:-8.24.3}"

mkdir -p "$INSTALL_DIR"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

archive="$tmp_dir/gitleaks.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_darwin_arm64.tar.gz"

curl -fsSL "$url" -o "$archive"
tar -xzf "$archive" -C "$tmp_dir"

mv "$tmp_dir/gitleaks" "$GITLEAKS_BIN"
chmod +x "$GITLEAKS_BIN"

echo "Installed gitleaks v${VERSION} at $GITLEAKS_BIN"
"$GITLEAKS_BIN" version
