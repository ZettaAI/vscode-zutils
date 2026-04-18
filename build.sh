#!/usr/bin/env bash
# Rebuild the Zetta CUE extension from source.
# Requires: Go 1.22+, Node 18+, npm.
set -euo pipefail

cd "$(dirname "$0")"

echo "→ Building Go parser (linux-amd64)..."
( cd parser && go build -trimpath -ldflags="-s -w" -o ../bin/zcue-parse-linux-amd64 )

echo "→ Installing npm deps..."
npm install --silent

echo "→ Compiling TypeScript bundle..."
npm run build

echo "→ Packaging .vsix..."
rm -f zetta-cue-*.vsix
npx --yes @vscode/vsce@latest package --allow-missing-repository --no-dependencies

echo
echo "Done. To install: ./install.sh"
