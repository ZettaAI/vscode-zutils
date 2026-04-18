#!/usr/bin/env bash
# Install the Zetta CUE extension into a VS Code-family editor.
# Fetches the pre-built .vsix from the latest GitHub Release of this repo.
#
# Usage:
#     ./install.sh                 # install into the 'code' CLI
#     ./install.sh <editor-cmd>    # install into a different fork (cursor, codium, etc.)
#     ZETTA_CUE_VERSION=v0.1.0 ./install.sh   # pin to a specific release tag
set -euo pipefail

REPO="ZettaAI/vscode-zutils"
ASSET="zetta-cue.vsix"
EDITOR_CMD="${1:-code}"
TAG="${ZETTA_CUE_VERSION:-latest}"

if ! command -v "$EDITOR_CMD" >/dev/null 2>&1; then
    echo "ERROR: '$EDITOR_CMD' not found on PATH." >&2
    echo "  Pass an alternative editor CLI as the first argument, e.g." >&2
    echo "    ./install.sh cursor" >&2
    echo "  Or install the VS Code CLI via:" >&2
    echo "    Ctrl+Shift+P → 'Shell Command: Install code in PATH' (VS Code)." >&2
    exit 1
fi

if [[ "$TAG" == "latest" ]]; then
    URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
    URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Downloading $URL"
if ! curl -fsSL -o "$TMP/$ASSET" "$URL"; then
    echo "ERROR: failed to download .vsix from $URL" >&2
    echo "  Check that the release '$TAG' exists and '$ASSET' is attached." >&2
    exit 1
fi

echo "→ Installing into $EDITOR_CMD"
"$EDITOR_CMD" --install-extension "$TMP/$ASSET"

cat <<EOF

Installed Zetta CUE (from $TAG release).

Next steps:
  1. Reload the editor window (Ctrl+Shift+P → 'Developer: Reload Window').
  2. Set your Python interpreter with zetta_utils installed:
     Settings → search 'zettaCue.pythonPath'.
  3. Command Palette → 'Zetta CUE: Regenerate Builder Metadata' (first run only).
EOF
