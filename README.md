# Zetta CUE — VS Code extension

Hover docs, validation, and go-to-definition for zetta_utils builder specs
in CUE files.

This repository is consumed as a git submodule of
[zetta_utils](https://github.com/ZettaAI/zetta_utils) at path `vscode_zutils/`.

## Features

- **Hover on `"@type"` values** — builder name, version, source-file link
  (click to jump), and full parameter list with types, defaults, and docs.
- **Inline diagnostics** — nested `@type` blocks are validated against the
  matching Python signature (respecting `@version` per block). Typos in
  `Literal`-typed fields (e.g. `info_type: "segmentatsion"`) surface as
  squiggles.
- **Go to Definition / F12 / Ctrl+Click** on any CUE identifier reference
  (`#BBOX`, `dst_resolution`, etc.) — jumps to its declaration.
- **Hover on identifier references** — shows a preview of the definition.
- **Self-synchronizing** — the extension hashes `zetta_utils/**/*.py` and
  auto-regenerates its schema cache when source drifts. Status bar shows
  `✓ Zetta CUE` (fresh), `⟳ regenerating…`, or `⚠ stale`.

## Install (no build tools needed)

From the `zetta_utils` repo root:

```bash
git submodule update --init vscode_zutils
cd vscode_zutils
./install.sh
```

Reload the VS Code window after install.

### First-run configuration

1. Open VS Code settings (`Ctrl+,`) and search `zettaCue.pythonPath`.
2. Set it to a Python interpreter with `zetta_utils` installed, e.g.
   `/home/you/zetta/zetta_utils/venv3.12/bin/python`.
3. Run `Ctrl+Shift+P → "Zetta CUE: Regenerate Builder Metadata"`. The first
   regeneration takes ~12 s (Python imports the full framework to introspect
   the registry); subsequent runs use the same cache.

After that, hover, diagnostics, and go-to-def just work.

## Runtime requirements

- **`cue` binary** on `$PATH`. Install from
  https://cuelang.org/docs/introduction/installation/.
- **Python with `zetta_utils`** importable (for schema regeneration only).
- **Official CUE extension** (`cuelangorg.vscode-cue`) — recommended for
  syntax highlighting. This extension doesn't ship its own grammar.

Platform support: **linux-amd64 only** for now (WSL on Windows also works).
Ask if you need macOS binaries.

## Rebuild

If you modify the extension source:

```bash
./build.sh    # needs Go 1.22+, Node 18+
./install.sh  # reinstall the freshly built .vsix
```

`build.sh` rewrites `bin/zcue-parse-linux-amd64`, `dist/extension.js`, and
`zetta-cue-*.vsix` — commit those alongside your source changes.

## Layout

```
vscode_zutils/
├── src/extension.ts        TypeScript: hover, diagnostics, def, file-watcher
├── parser/main.go          Go: parses CUE via cuelang.org/go/cue/parser
├── extract.py              Python: walks zetta_utils registry → schemas + metadata
├── bin/zcue-parse-*        Pre-built Go parser binary (per platform)
├── dist/extension.js       Bundled TS extension
├── zetta-cue-*.vsix        Pre-packaged .vsix (committed for install.sh)
├── build.sh                Rebuild from source
├── install.sh              Install the .vsix
└── README.md               This file
```

Generated metadata lives in `~/.cache/zetta-utils-vscode/<content-hash>/`
(never committed). Stale cache dirs beyond the 3 most recent are cleaned up
on each regeneration.

## Design notes

- **CUE correctness**: all parsing uses CUE's own parser
  (`cuelang.org/go/cue/parser`) via a bundled Go helper. No regex walking —
  handles comments, string literals, interpolations, multi-line strings
  correctly.
- **Scope resolution**: hand-rolled AST-level scope tracker resolves
  identifier references to their declarations — covers ~86% of references
  in real specs. Unresolved are mostly package imports (`math.Ceil`,
  `list.Max`) which don't need a scope binding.
- **Validation strategy**: for each `@type` block with a static path from
  the file root, emit `_check_N: <path> & #<builder-schema>` in a
  synthesized `combined.cue`, then run `cue vet`. Error lines map back to
  source via a combined-line → original-line table. `@types` inside
  comprehensions are skipped (no static path).
- **Auto-sync**: content hash of `zetta_utils/**/*.py` is embedded in
  `metadata.json` at generation; the extension re-hashes at activation and
  on Python file save (debounced 1.5 s), triggering regen on drift.
