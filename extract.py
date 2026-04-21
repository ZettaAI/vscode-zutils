"""Emit CUE schemas + hover metadata from the zetta_utils builder registry.

Outputs two files into the cache directory:
  - schemas.cue     — definitions for every registered builder
  - metadata.json   — flat list { builder_name: { docstring, file, line, ... } }

Cache key: `git rev-parse HEAD` + `-dirty` if working tree has uncommitted
changes under zetta_utils/. If we're not in a git checkout, falls back to a
content hash of zetta_utils/**/*.py.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import re
import shutil
import sys
import time
import typing
from pathlib import Path
from types import NoneType
from typing import Any, get_args, get_origin

# ─────────────────────────────────────────────────────────────
# Cache key
# ─────────────────────────────────────────────────────────────


def _cache_key(zu_dir: Path) -> str:
    """Content-hash of zetta_utils/**/*.py + extract.py itself.

    Mirrored byte-for-byte in src/extension.ts: the TS side hashes both the
    zetta_utils tree (walking the directory) AND the extension's bundled
    extract.py. Including extract.py is essential: if we only hashed
    zetta_utils, changing the extractor's logic (e.g. adding MRO traversal)
    wouldn't invalidate existing caches when zetta_utils content is unchanged,
    and the extension would happily serve stale schemas.
    """
    h = hashlib.sha256()
    for f in sorted(zu_dir.rglob("*.py")):
        if "__pycache__" in f.parts:
            continue
        rel = str(f.relative_to(zu_dir)).encode()
        h.update(rel)
        h.update(b"\0")
        try:
            h.update(f.read_bytes())
        except OSError:
            continue
        h.update(b"\0\0")
    # Mix in extract.py's own bytes so a smarter extractor invalidates caches.
    try:
        h.update(b"\xff__extract__\xff")
        h.update(Path(__file__).read_bytes())
    except OSError:
        pass
    return h.hexdigest()[:16]


def _cleanup_old_caches(cache_root: Path, keep: str, keep_n: int = 3) -> list[str]:
    """Remove all cache dirs except the `keep_n` most recently modified,
    always including the `keep` dir itself. Returns names that were removed."""
    if not cache_root.exists():
        return []
    entries = [p for p in cache_root.iterdir() if p.is_dir()]
    # Order by mtime, newest first
    entries.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    to_keep: set[str] = {keep}
    for p in entries[:keep_n]:
        to_keep.add(p.name)
    removed: list[str] = []
    for p in entries:
        if p.name in to_keep:
            continue
        try:
            shutil.rmtree(p)
            removed.append(p.name)
        except OSError:
            pass
    return removed


# ─────────────────────────────────────────────────────────────
# Python type → CUE type
# ─────────────────────────────────────────────────────────────

_PRIMITIVE_MAP = {
    str: "string",
    int: "int",
    float: "number",
    bool: "bool",
    bytes: "bytes",
    type(None): "null",
}


def _cue_type(annotation: Any) -> str:  # pylint: disable=too-many-return-statements
    """Convert a Python typing annotation to a CUE type expression.

    Conservative: falls back to '_' (top type) when unsure.
    """
    if annotation is inspect.Parameter.empty or annotation is Any:
        return "_"

    if annotation in _PRIMITIVE_MAP:
        return _PRIMITIVE_MAP[annotation]

    origin = get_origin(annotation)
    args = get_args(annotation)

    if origin is typing.Literal:
        return " | ".join(_cue_literal(a) for a in args)

    if origin is typing.Union:
        non_none = [a for a in args if a is not NoneType]
        cue = " | ".join(_cue_type(a) for a in non_none)
        if NoneType in args:
            cue = f"{cue} | null" if cue else "null"
        return cue or "_"

    if origin is list or (
        origin is not None and getattr(origin, "__name__", "") in ("list", "Sequence", "Iterable")
    ):
        inner = _cue_type(args[0]) if args else "_"
        return f"[...{inner}]"

    if origin is tuple:
        if len(args) == 2 and args[1] is Ellipsis:
            return f"[...{_cue_type(args[0])}]"
        return "[" + ", ".join(_cue_type(a) for a in args) + "]"

    if origin is dict or getattr(origin, "__name__", "") == "Mapping":
        if args:
            return f"{{[{_cue_type(args[0])}]: {_cue_type(args[1])}}}"
        return "{...}"

    return "_"


def _cue_literal(v: Any) -> str:
    """Emit a Python value as a CUE literal.

    JSON is a strict subset of CUE, so strict-JSON output is always valid CUE.
    We use allow_nan=False to surface any leaked NaN/Infinity at generation
    time — _is_simple_literal already filters them out before reaching here,
    but belt-and-suspenders keeps the schema unconditionally parseable.
    """
    if isinstance(v, str):
        return json.dumps(v, allow_nan=False)
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    return json.dumps(v, allow_nan=False)


# ─────────────────────────────────────────────────────────────
# Docstring parsing — extract :param name: text
# ─────────────────────────────────────────────────────────────

_PARAM_RE = re.compile(r"^\s*:param\s+([a-zA-Z_][\w]*)\s*:\s*(.*)")


def _parse_docstring(doc: str | None) -> tuple[str, dict[str, str]]:
    if not doc:
        return "", {}
    lines = inspect.cleandoc(doc).split("\n")
    summary_lines: list[str] = []
    params: dict[str, str] = {}
    current: str | None = None
    for line in lines:
        m = _PARAM_RE.match(line)
        if m:
            current = m.group(1)
            params[current] = m.group(2).strip()
        elif line.startswith(":"):
            current = None
        elif current and line.strip():
            params[current] = (params[current] + " " + line.strip()).strip()
        elif current is None and line.strip() and not line.strip().startswith(":"):
            summary_lines.append(line.strip())
    return " ".join(summary_lines).strip(), params


# ─────────────────────────────────────────────────────────────
# Function introspection
# ─────────────────────────────────────────────────────────────


def _unwrap(fn):  # pylint: disable=too-many-branches
    """Peel off common decorators to expose the real function.

    Also collects KEYWORD_ONLY parameters each wrapper *introduces* (params
    present on the outer wrapper's own signature that don't exist on the inner
    function). These are real parameters callers can pass — e.g. `prob_aug`
    adds `prob: float = 1.0` to every wrapped aug. Without collecting them,
    following __wrapped__ strips them from the signature and the extension
    flags them as unknown fields.

    Returns (inner_fn, extra_kwonly_params) where extra_kwonly_params is a
    list of inspect.Parameter objects to merge into the final signature.
    """
    extra: dict[str, inspect.Parameter] = {}

    def _snapshot_kwonly(candidate):
        """Record KEYWORD_ONLY params of `candidate`'s OWN signature, not the
        wrapped one. inspect.signature default follow_wrapped=True would hide
        these, so we pass follow_wrapped=False."""
        try:
            sig = inspect.signature(candidate, follow_wrapped=False)
        except (TypeError, ValueError):
            return
        for name, p in sig.parameters.items():
            if p.kind is p.KEYWORD_ONLY and name not in extra:
                extra[name] = p

    seen = set()
    while id(fn) not in seen:
        seen.add(id(fn))
        if hasattr(fn, "__wrapped__"):
            _snapshot_kwonly(fn)
            fn = fn.__wrapped__
            continue
        inner = getattr(fn, "fn", None)
        if callable(inner) and inner is not fn:
            # Callable wrapper class (e.g. DictSupportingTensorOp from
            # @supports_dict) — its __call__ may inject extra keyword-only
            # params like `targets` on top of the wrapped function's signature.
            _snapshot_kwonly(fn)
            fn = inner
            continue
        closure = getattr(fn, "__closure__", None)
        cur_name = getattr(fn, "__name__", "")
        if closure and cur_name in ("wrapped", "wrapper", "inner"):
            _snapshot_kwonly(fn)
            for cell in closure:
                try:
                    v = cell.cell_contents
                except ValueError:
                    continue
                if not callable(v) or v is fn:
                    continue
                v_name = getattr(v, "__name__", "")
                if v_name and v_name not in ("wrapped", "wrapper", "inner"):
                    fn = v
                    break
            else:
                break
            continue
        break
    # Drop kwonly params that ARE present in the final inner function — those
    # weren't ADDED by the wrapper, just passed through.
    if extra:
        try:
            inner_sig = inspect.signature(fn, follow_wrapped=False)
            for name in list(extra.keys()):
                if name in inner_sig.parameters:
                    del extra[name]
        except (TypeError, ValueError):
            pass
    return fn, list(extra.values())


def _collect_init_params(  # pylint: disable=too-many-branches
    cls: type,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Walk a class's MRO, collecting __init__ parameters + their docs.

    - Parameters of more-derived classes override those of bases with the same
      name (users expect the most-specific signature).
    - We stop descending into a base if the CURRENT level doesn't have **kwargs
      — without kwarg forwarding, base-class params aren't reachable from spec.
    - :param docs are merged across the chain, same precedence.
    """
    params_by_name: dict[str, dict[str, Any]] = {}
    param_docs_merged: dict[str, str] = {}

    for base in cls.__mro__:
        if base is object:
            break
        init = base.__dict__.get("__init__")
        if init is None:
            # No explicit __init__ at this level; keep walking.
            continue
        try:
            sig = inspect.signature(init)
        except (TypeError, ValueError):
            continue
        try:
            hints = typing.get_type_hints(init)
        except Exception:  # pylint: disable=broad-exception-caught
            hints = {}
        _, docs = _parse_docstring(inspect.getdoc(init))
        for k, v in docs.items():
            param_docs_merged.setdefault(k, v)

        has_kwargs = False
        for name, p in sig.parameters.items():
            if name == "self":
                continue
            if p.kind is p.VAR_KEYWORD:
                has_kwargs = True
                continue
            if p.kind is p.VAR_POSITIONAL:
                continue
            # Don't overwrite more-derived declarations.
            if name in params_by_name:
                continue
            annotation = hints.get(name, p.annotation)
            required = p.default is inspect.Parameter.empty
            default = None if required else p.default
            params_by_name[name] = {
                "name": name,
                "cue_type": _cue_type(annotation),
                "py_type": _stringify(annotation),
                "required": required,
                "default": _jsonable(default),
                "doc": "",  # filled below
            }
        if not has_kwargs:
            # This level doesn't forward extra kwargs; bases' extras aren't
            # reachable by callers.
            break

    # Attach docs from the merged docstrings.
    for name, p in params_by_name.items():
        if not p["doc"] and name in param_docs_merged:
            p["doc"] = param_docs_merged[name]

    return list(params_by_name.values()), param_docs_merged


def _introspect(fn) -> dict[str, Any]:  # pylint: disable=too-many-branches
    extra_kwonly: list[inspect.Parameter] = []
    if inspect.isclass(fn):
        target = fn
    else:
        target, extra_kwonly = _unwrap(fn)

    # Classes: walk MRO so that inherited parameters (via **kwargs forwarding)
    # are surfaced. Functions: read the signature directly.
    if inspect.isclass(target):
        try:
            params, param_docs = _collect_init_params(target)
        except (TypeError, ValueError):
            params, param_docs = [], {}
    else:
        try:
            sig = inspect.signature(target, follow_wrapped=False)
        except (TypeError, ValueError):
            return {"params": [], "summary": "", "file": "", "line": 0}
        try:
            hints = typing.get_type_hints(target)
        except Exception:  # pylint: disable=broad-exception-caught
            hints = {}
        _, param_docs = _parse_docstring(inspect.getdoc(target))
        params = []
        seen_names: set[str] = set()
        for name, p in sig.parameters.items():
            if name == "self" or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                continue
            seen_names.add(name)
            annotation = hints.get(name, p.annotation)
            required = p.default is inspect.Parameter.empty
            default = None if required else p.default
            params.append(
                {
                    "name": name,
                    "cue_type": _cue_type(annotation),
                    "py_type": _stringify(annotation),
                    "required": required,
                    "default": _jsonable(default),
                    "doc": param_docs.get(name, ""),
                }
            )
        # Append wrapper-injected kwargs (e.g. `prob` from @prob_aug). These
        # are real accepted kwargs on the registered callable.
        for p in extra_kwonly:
            if p.name in seen_names:
                continue
            required = p.default is inspect.Parameter.empty
            default = None if required else p.default
            params.append(
                {
                    "name": p.name,
                    "cue_type": _cue_type(p.annotation),
                    "py_type": _stringify(p.annotation),
                    "required": required,
                    "default": _jsonable(default),
                    "doc": param_docs.get(p.name, ""),
                }
            )

    doc = inspect.getdoc(target)
    if not doc and inspect.isclass(target):
        doc = inspect.getdoc(target.__init__)
    summary, _ = _parse_docstring(doc)

    try:
        file = inspect.getsourcefile(target) or ""
    except TypeError:
        file = ""
    try:
        line = inspect.getsourcelines(target)[1]
    except (OSError, TypeError):
        line = 0

    return {"params": params, "summary": summary, "file": file, "line": line}


def _stringify(annotation) -> str:
    if annotation is inspect.Parameter.empty:
        return "Any"
    try:
        return str(annotation)
    except Exception:  # pylint: disable=broad-exception-caught
        return repr(annotation)


def _jsonable(v):
    """Return a value safe to serialize via strict JSON (no NaN/inf).

    Standard JSON disallows NaN/inf; Python's json.dumps emits them by
    default (allow_nan=True), but every other JSON parser (including Node,
    which VS Code uses) rejects them. We stringify such values so the
    metadata round-trips cleanly.
    """
    import math  # pylint: disable=import-outside-toplevel

    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        out = [_jsonable(x) for x in v]
        return out if isinstance(v, list) else tuple(out)
    try:
        json.dumps(v, allow_nan=False)
        return v
    except (TypeError, ValueError):
        return repr(v)


# ─────────────────────────────────────────────────────────────
# Code generation
# ─────────────────────────────────────────────────────────────


def _sanitize(name: str) -> str:
    """Convert a builder @type (e.g. 'mazepa.concurrent_flow') into a CUE definition suffix."""
    return "#" + re.sub(r"[^A-Za-z0-9]", "_", name)


def _emit_schema_named(def_name: str, name: str, entry: dict[str, Any]) -> str:
    lines = [f"// {entry['summary']}" if entry["summary"] else f"// {name}"]
    lines.append(f"{def_name}: {{")
    lines.append(f'\t"@type":     "{name}"')
    lines.append('\t"@version"?: string')
    lines.append('\t"@mode"?:    "partial" | "regular"')
    lines.append("")

    for p in entry["params"]:
        if p["doc"]:
            lines.append(f"\t// {p['doc']}")
        cue_type = p["cue_type"]
        # Skip fields whose only sensible type is the top type AND no doc — reduces noise.
        marker = "!" if p["required"] else "?"
        if p["required"]:
            lines.append(f'\t{p["name"]}{marker}: {cue_type}')
        else:
            default = p["default"]
            if default is not None and cue_type != "_":
                lit = _cue_literal(default) if _is_simple_literal(default) else None
                if lit:
                    lines.append(f'\t{p["name"]}?: {cue_type} | *{lit}')
                else:
                    lines.append(f'\t{p["name"]}?: {cue_type}')
            else:
                lines.append(f'\t{p["name"]}?: {cue_type}')
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


def _is_simple_literal(v) -> bool:
    import math  # pylint: disable=import-outside-toplevel

    if v is None:
        return False  # no point emitting `| *null`; just `?` is cleaner
    # CUE has no NaN/inf literals — skip defaults that include them.
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return False
    if isinstance(v, (str, bool, int, float)):
        return True
    if isinstance(v, (list, tuple)) and len(v) < 8:
        return all(
            isinstance(x, (str, bool, int))
            or (isinstance(x, float) and not math.isnan(x) and not math.isinf(x))
            for x in v
        )
    return False


# ─────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────


def main():  # pylint: disable=too-many-locals,too-many-statements
    t0 = time.perf_counter()
    # These imports must happen inside main(): zetta_utils is only importable
    # in the user's active venv, and importing it eagerly would force loading
    # the heavy ML stack before we're ready to measure it.
    import zetta_utils  # pylint: disable=import-outside-toplevel
    from zetta_utils.builder.registry import (  # pylint: disable=import-outside-toplevel
        REGISTRY,
    )

    zetta_utils.load_all_modules()
    t1 = time.perf_counter()

    zu_pkg_dir = Path(zetta_utils.__file__).parent
    key = _cache_key(zu_pkg_dir)

    cache_dir = Path.home() / ".cache" / "zetta-utils-vscode" / key
    cache_dir.mkdir(parents=True, exist_ok=True)

    metadata: dict[str, Any] = {
        "generated_at": time.time(),
        "cache_key": key,
        # Absolute path to the zetta_utils source dir the extension can re-hash
        # to decide whether the cache is still fresh.
        "source_path": str(zu_pkg_dir),
        "builders": {},
    }
    schema_chunks: list[str] = [
        "// Auto-generated from zetta_utils builder registry.",
        "// Regenerate via the 'Zetta: Regenerate Builder Metadata' command.",
        "package zbuilder",
        "",
    ]

    # Generate one definition per (name, version_spec) combination.
    # Single-entry builders get the unsuffixed name (#foo).
    # Multi-entry builders get per-spec names (#foo_v0_0_3) plus an alias
    # #foo pointing at the newest (">=" spec wins; else the first entry).
    per_name_defs: dict[str, list[tuple[str, str]]] = {}
    for name, entries in sorted(REGISTRY.items()):
        metadata["builders"][name] = []
        for entry in entries:
            intro = _introspect(entry.fn)
            # Store metadata for hover.
            metadata["builders"][name].append(
                {
                    "version_spec": str(entry.version_spec),
                    "allow_partial": entry.allow_partial,
                    "summary": intro["summary"],
                    "file": intro["file"],
                    "line": intro["line"],
                    "params": intro["params"],
                }
            )
            # Generate the CUE schema chunk.
            single = len(entries) == 1
            def_name = _sanitize(name)
            if not single:
                def_name += "_v" + re.sub(r"[^0-9]", "_", str(entry.version_spec)).strip("_")
            chunk = _emit_schema_named(def_name, name, intro)
            schema_chunks.append(chunk)
            per_name_defs.setdefault(name, []).append((def_name, str(entry.version_spec)))

    # Emit aliases for multi-version builders. The alias points at the entry
    # whose version_spec matches DEFAULT_VERSION ("0.0.0"), mirroring the
    # Python registry's get_matching_entry() behavior.
    # pylint: disable=import-outside-toplevel
    from packaging.specifiers import SpecifierSet
    from packaging.version import Version

    from zetta_utils.builder import constants as _constants

    # pylint: enable=import-outside-toplevel
    default_version = Version(_constants.DEFAULT_VERSION)

    schema_chunks.append("// ─── default-version aliases ───")
    for name, variants in sorted(per_name_defs.items()):
        if len(variants) <= 1:
            continue
        default_variant = next(
            (v for v in variants if default_version in SpecifierSet(v[1])),
            variants[0],
        )
        alias = _sanitize(name)
        schema_chunks.append(f"{alias}: {default_variant[0]}")
    schema_chunks.append("")

    # NOTE: No #Builder union is emitted. A 1700-branch recursive disjunction
    # caused cue vet to explode (30s+ on a 650-line spec). Validation happens
    # per-@type-occurrence via probe sidecars emitted by the extension.

    schemas_path = cache_dir / "schemas.cue"
    metadata_path = cache_dir / "metadata.json"
    schemas_path.write_text("\n".join(schema_chunks))
    # allow_nan=False: Node/VS Code's JSON.parse rejects NaN/Inf; fail loudly
    # here if any snuck through _jsonable rather than writing unparseable JSON.
    metadata_path.write_text(json.dumps(metadata, allow_nan=False))

    removed = _cleanup_old_caches(cache_dir.parent, keep=key, keep_n=3)

    t2 = time.perf_counter()
    total_entries = sum(len(v) for v in REGISTRY.values())
    print(f"cache key:        {key}", file=sys.stderr)
    print(f"cache dir:        {cache_dir}", file=sys.stderr)
    print(
        f"builders:         {len(REGISTRY)} names, {total_entries} entries",
        file=sys.stderr,
    )
    print(f"schemas:          {schemas_path}", file=sys.stderr)
    print(f"metadata:         {metadata_path}", file=sys.stderr)
    print(
        f"wall time:        {t2 - t0:.2f}s  (load={t1-t0:.2f}s, gen={t2-t1:.2f}s)",
        file=sys.stderr,
    )
    if removed:
        print(f"removed stale:    {len(removed)} older cache dir(s)", file=sys.stderr)
    # Print cache dir to stdout so tools can capture it.
    print(str(cache_dir))


if __name__ == "__main__":
    main()
