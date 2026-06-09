import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as cp from "child_process";
import * as crypto from "crypto";

// ─────────────────────────────────────────────────────────────
// Types from the Go parser
// ─────────────────────────────────────────────────────────────

interface Pos { offset: number; line: number; col: number; }
interface Range { start: Pos; end: Pos; }
interface AtType {
  name: string;
  nameRange: Range;
  keyRange: Range;
  blockRange: Range;
  version?: string;
  versionRange?: Range;
  mode?: string;
  /** CUE reference path from the root (e.g. "#FLOW.dst"). Empty if inside a comprehension. */
  path?: string;
  /** Static path to the host list when @type sits inside a list comprehension. */
  listPath?: string;
  /** Path from the comprehension's per-iteration element to the @type struct. */
  relPath?: string;
  /** True when the host list mixes comprehensions with other elements (or has >1 comp). */
  listMixed?: boolean;
  /** Identifier uses inside blockRange that won't resolve if the block is pasted standalone. */
  externalRefs?: { name: string; range: Range; replacement: string }[];
}
type DeclKind = "definition" | "field" | "let";
interface Declaration {
  name: string;
  kind: DeclKind;
  nameRange: Range;
  bodyRange: Range;
}
interface Reference {
  name: string;
  range: Range;
  resolvesTo?: Declaration;
}
interface ParsedDoc {
  atTypes: AtType[] | null;
  declarations: Declaration[] | null;
  references: Reference[] | null;
  parseErrors: string[] | null;
}

// ─────────────────────────────────────────────────────────────
// Builder metadata (unchanged)
// ─────────────────────────────────────────────────────────────

interface BuilderParam {
  name: string;
  cue_type: string;
  py_type: string;
  required: boolean;
  default: unknown;
  doc: string;
}
interface BuilderVersion {
  version_spec: string;
  allow_partial: boolean;
  summary: string;
  file: string;
  line: number;
  params: BuilderParam[];
}
interface Metadata {
  generated_at: number;
  cache_key: string;         // == content hash of zetta_utils/**/*.py at gen time
  source_path?: string;      // absolute path to the zetta_utils source dir
  builders: Record<string, BuilderVersion[]>;
  dynamic_prefixes?: string[];  // @type prefixes resolved at build time (np.*, torch.*)
}

// ─────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────

let output: vscode.OutputChannel;
function log(msg: string) { if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`); }

// ─────────────────────────────────────────────────────────────
// Parser binary
// ─────────────────────────────────────────────────────────────

function parserBinaryPath(extensionPath: string): string | null {
  const plat = process.platform;
  const arch = process.arch;
  // Only linux-amd64 shipped for now. Add others on demand.
  if (plat === "linux" && arch === "x64") {
    return path.join(extensionPath, "bin", "zcue-parse-linux-amd64");
  }
  return null;
}

/**
 * Parse a CUE document via the Go helper. Caches results per (uri, version).
 * Cheap: the parse itself is ~3ms on a 650-line spec.
 */
class Parser {
  private cache = new Map<string, { version: number; parsed: ParsedDoc }>();
  constructor(private binPath: string) {}

  parse(doc: vscode.TextDocument): ParsedDoc | null {
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === doc.version) return cached.parsed;
    // Write the current text to a temp file so we parse what VS Code has in memory,
    // not whatever is on disk.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcue-parse-"));
    const tmpFile = path.join(tmp, "doc.cue");
    try {
      fs.writeFileSync(tmpFile, doc.getText());
      const result = cp.spawnSync(this.binPath, [tmpFile], { timeout: 5000, encoding: "utf8" });
      if (result.status !== 0) {
        log(`parser exit ${result.status}: ${(result.stderr ?? "").slice(0, 400)}`);
        return null;
      }
      const parsed = JSON.parse(result.stdout) as ParsedDoc;
      this.cache.set(key, { version: doc.version, parsed });
      return parsed;
    } catch (e) {
      log(`parse failed: ${e}`);
      return null;
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Version resolution (same as before)
// ─────────────────────────────────────────────────────────────

const DEFAULT_VERSION = "0.0.0";

function resolveVersion(versions: BuilderVersion[], declared: string | undefined): BuilderVersion | null {
  if (!versions.length) return null;
  if (versions.length === 1) return versions[0];
  const target = declared ?? DEFAULT_VERSION;
  const match = versions.find((v) => matchesSpec(target, v.version_spec));
  return match ?? versions[0];
}

function matchesSpec(version: string, spec: string): boolean {
  const nums = (s: string) => s.match(/\d+/g)?.map((n) => parseInt(n, 10)) ?? [];
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0, y = b[i] ?? 0;
      if (x !== y) return x - y;
    }
    return 0;
  };
  const v = nums(version);
  for (const clause of spec.split(",").map((c) => c.trim())) {
    const op = clause.match(/^(>=|<=|==|>|<|!=)/)?.[1];
    if (!op) continue;
    const b = nums(clause.slice(op.length));
    const c = compare(v, b);
    if (op === ">=" && c < 0) return false;
    if (op === "<=" && c > 0) return false;
    if (op === "==" && c !== 0) return false;
    if (op === ">" && c <= 0) return false;
    if (op === "<" && c >= 0) return false;
    if (op === "!=" && c === 0) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// Source content hash — MUST byte-match extract.py's _cache_key.
// Python does:
//   for f in sorted(zu_dir.rglob("*.py")):
//       if "__pycache__" in f.parts: continue
//       h.update(str(f.relative_to(zu_dir)).encode()); h.update(b"\0")
//       h.update(f.read_bytes());                     h.update(b"\0\0")
//   return h.hexdigest()[:16]
// ─────────────────────────────────────────────────────────────

/** Collect all .py files under `root`, skipping __pycache__ dirs. */
function collectPyFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === "__pycache__") continue;
        walk(full, relPath);
      } else if (e.isFile() && e.name.endsWith(".py")) {
        out.push(relPath);
      }
    }
  };
  walk(root, "");
  // Python's sorted(Path.rglob("*.py")) sorts by str(Path), which on POSIX
  // uses "/" separators — matching our relPath form directly.
  out.sort();
  return out;
}

function hashSourceTree(sourcePath: string, extractPyPath: string): string {
  const h = crypto.createHash("sha256");
  const NUL = Buffer.from([0]);
  const DNUL = Buffer.from([0, 0]);
  for (const rel of collectPyFiles(sourcePath)) {
    h.update(rel, "utf8");
    h.update(NUL);
    try { h.update(fs.readFileSync(path.join(sourcePath, rel))); }
    catch { /* unreadable file — Python skips too */ }
    h.update(DNUL);
  }
  // Mix in extract.py's bytes — mirrors Python's _cache_key. Ensures a cache
  // miss (→ regen) whenever the extractor's logic itself changes, even if
  // the zetta_utils source content hasn't moved.
  // Sentinel must match Python bytes exactly: b"\xff__extract__\xff"
  h.update(Buffer.from([0xff, ...Buffer.from("__extract__", "utf8"), 0xff]));
  try { h.update(fs.readFileSync(extractPyPath)); }
  catch { /* extract.py absent — serve whatever's cached */ }
  return h.digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────
// Metadata loading
// ─────────────────────────────────────────────────────────────

function cacheRoot(): string { return path.join(os.homedir(), ".cache", "zetta-utils-vscode"); }

async function findCacheDir(): Promise<string | null> {
  const root = cacheRoot();
  if (!fs.existsSync(root)) return null;
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name));
  if (!entries.length) return null;
  entries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return entries[0];
}

async function loadMetadata(): Promise<{ metadata: Metadata; schemasPath: string } | null> {
  const dir = await findCacheDir();
  if (!dir) return null;
  const metaPath = path.join(dir, "metadata.json");
  const schemasPath = path.join(dir, "schemas.cue");
  if (!fs.existsSync(metaPath) || !fs.existsSync(schemasPath)) return null;
  return { metadata: JSON.parse(fs.readFileSync(metaPath, "utf8")), schemasPath };
}

// ─────────────────────────────────────────────────────────────
// Range conversion
// ─────────────────────────────────────────────────────────────

function vscodeRange(r: Range): vscode.Range {
  return new vscode.Range(r.start.line - 1, r.start.col - 1, r.end.line - 1, r.end.col - 1);
}

function positionInRange(pos: vscode.Position, r: Range): boolean {
  const startLine = r.start.line - 1, startCol = r.start.col - 1;
  const endLine = r.end.line - 1, endCol = r.end.col - 1;
  if (pos.line < startLine || pos.line > endLine) return false;
  if (pos.line === startLine && pos.character < startCol) return false;
  if (pos.line === endLine && pos.character > endCol) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Hover
// ─────────────────────────────────────────────────────────────

function findInnermostAtType(parsed: ParsedDoc, pos: vscode.Position): AtType | null {
  let best: AtType | null = null;
  for (const at of parsed.atTypes ?? []) {
    if (!positionInRange(pos, at.blockRange)) continue;
    if (!best) { best = at; continue; }
    const size = (r: Range) => (r.end.offset - r.start.offset);
    if (size(at.blockRange) < size(best.blockRange)) best = at;
  }
  return best;
}

function renderBuilderHover(name: string, entry: BuilderVersion): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(`**\`${name}\`** *(${entry.version_spec})*\n\n`);
  if (entry.summary) md.appendMarkdown(entry.summary + "\n\n");
  if (entry.file) {
    const link = `${vscode.Uri.file(entry.file).toString()}#L${entry.line || 1}`;
    md.appendMarkdown(`[Source](${link}) — \`${entry.file}:${entry.line || 1}\`\n\n`);
  }
  if (entry.params.length) {
    md.appendMarkdown("**Parameters**\n\n");
    for (const p of entry.params) {
      const req = p.required ? " **required**" : "";
      const def = p.default !== undefined && p.default !== null && !p.required
        ? ` *(default: ${JSON.stringify(p.default)})*` : "";
      md.appendMarkdown(`- \`${p.name}\`: \`${p.cue_type}\`${req}${def}`);
      if (p.doc) md.appendMarkdown(` — ${p.doc}`);
      md.appendMarkdown("\n");
    }
  }
  return md;
}

// ─────────────────────────────────────────────────────────────
// Diagnostics via cue vet
// ─────────────────────────────────────────────────────────────

interface CueError { line: number; col: number; message: string; }

function parseCueErrors(stderr: string): CueError[] {
  const errors: CueError[] = [];
  const lines = stderr.split("\n");
  // cue formats large line/col numbers with thousand-separator commas
  // (e.g. "combined.cue:20,063:21"), so accept digits + commas and strip
  // the commas before parseInt.
  let lastMessage = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const pathMatch = line.trim().match(/^(?:\.\.\/)*\.?\/?([^:]+):([\d,]+):([\d,]+)$/);
    const locM = /:([\d,]+):([\d,]+)\s*$/.exec(line.trim());
    if (pathMatch && lastMessage && pathMatch[1].endsWith("combined.cue")) {
      errors.push({
        line: parseInt(pathMatch[2].replace(/,/g, ""), 10),
        col: parseInt(pathMatch[3].replace(/,/g, ""), 10),
        message: lastMessage.replace(/:$/, "").trim(),
      });
      lastMessage = "";
    } else if (!locM) {
      lastMessage = line.trim();
    }
  }
  return errors;
}

async function runCueVet(cuePath: string, combinedPath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = cp.spawn(cuePath, ["vet", "-c=false", combinedPath], { timeout: timeoutMs });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", () => resolve(stderr));
    child.on("error", () => resolve(stderr));
  });
}

// ─────────────────────────────────────────────────────────────
// Python interpreter + dynamic-resolver (np.*/torch.*) verification
// ─────────────────────────────────────────────────────────────

const dynResolveCache = new Map<string, boolean>();   // name -> resolves
const dynInFlight = new Map<string, Promise<void>>();
let dynResolveCacheKey = "";
const diagGen = new Map<string, number>();   // doc uri -> latest updateDiagnostics run

function clearDynamicCache() {
  dynResolveCache.clear();
  dynInFlight.clear();
  dynResolveCacheKey = "";
}

// Resolved per call (cheap: ms-python's activate() is a no-op once active) so a
// mid-session interpreter switch is always picked up.
async function resolvePythonPath(): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("zettaCue");
  let pythonPath = cfg.get<string>("pythonPath") || "";
  if (!pythonPath) {
    const pyExt = vscode.extensions.getExtension("ms-python.python");
    if (pyExt) {
      await pyExt.activate();
      const api = pyExt.exports as any;
      pythonPath = api.settings?.getExecutionDetails?.()?.execCommand?.[0] ?? "python3";
    } else {
      pythonPath = "python3";
    }
  }
  return pythonPath;
}

// np.*/torch.* @types resolve at build time via dynamic resolvers, not the static
// registry, so metadata can't validate them. Invoke the real resolver in the user's
// interpreter (a getattr into numpy/torch) to confirm each; flag only genuine typos.
// A name whose backing lib isn't importable is treated as resolved (can't be checked).
const DYNAMIC_RESOLVER_SNIPPET = `
import importlib, json, sys
from zetta_utils.builder import built_in_registrations  # noqa: F401  (registers resolvers)
from zetta_utils.builder import registry

_LIB_FOR_PREFIX = {"np.": "numpy", "torch.": "torch"}
_verifiable = {}
for _prefix, _ in registry._dynamic_resolvers:
    # Unmapped prefix: can't identify its backing lib to check availability, so
    # treat as unverifiable (skip — never false-flag). Keep _LIB_FOR_PREFIX in
    # sync with the register_dynamic_resolver(...) calls in built_in_registrations.py.
    _lib = _LIB_FOR_PREFIX.get(_prefix)
    if _lib is None:
        _verifiable[_prefix] = False
        continue
    try:
        importlib.import_module(_lib)
        _verifiable[_prefix] = True
    except Exception:
        _verifiable[_prefix] = False

unresolved = []
for _name in json.loads(sys.argv[1]):
    _pref = next((p for p, _ in registry._dynamic_resolvers if _name.startswith(p)), None)
    if _pref is None or not _verifiable.get(_pref, False):
        continue
    try:
        registry.get_matching_entry(_name)
    except Exception:
        unresolved.append(_name)
print(json.dumps(unresolved))
`;

function runDynamicResolver(pythonPath: string, names: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    const child = cp.spawn(pythonPath, ["-c", DYNAMIC_RESOLVER_SNIPPET, JSON.stringify(names)], { timeout: 60000 });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(new Set()));
    child.on("close", (code) => {
      if (code !== 0) { resolve(new Set()); return; }
      try { resolve(new Set(JSON.parse(out.trim() || "[]") as string[])); }
      catch { resolve(new Set()); }
    });
  });
}

/** Returns the subset of `names` (dynamic-prefix @types) that do NOT resolve. */
async function verifyDynamicNames(names: string[], cacheKey: string): Promise<Set<string>> {
  if (cacheKey !== dynResolveCacheKey) {
    dynResolveCache.clear();
    dynInFlight.clear();
    dynResolveCacheKey = cacheKey;
  }
  const uniq = [...new Set(names)];
  const need = uniq.filter((n) => !dynResolveCache.has(n) && !dynInFlight.has(n));
  if (need.length) {
    // Register in-flight placeholders synchronously (before any await) so a
    // concurrent run doesn't spawn a duplicate resolver for the same names.
    const p = (async () => {
      const pythonPath = await resolvePythonPath();
      const unresolved = await runDynamicResolver(pythonPath, need);
      for (const n of need) dynResolveCache.set(n, !unresolved.has(n));
    })().finally(() => { for (const n of need) dynInFlight.delete(n); });
    for (const n of need) dynInFlight.set(n, p);
  }
  await Promise.all(uniq.map((n) => dynInFlight.get(n)).filter(Boolean));
  return new Set(uniq.filter((n) => dynResolveCache.get(n) === false));
}

async function updateDiagnostics(
  doc: vscode.TextDocument,
  parser: Parser,
  metadata: Metadata,
  schemasPath: string,
  cuePath: string,
  diagnostics: vscode.DiagnosticCollection,
) {
  if (doc.languageId !== "cue") return;
  // Run-generation guard: the awaits below (dynamic-resolver verify, cue vet)
  // let runs for the same doc overlap; bail before writing diagnostics if a
  // newer run has since started, so the last writer can't be a stale one.
  const uriKey = doc.uri.toString();
  const myGen = (diagGen.get(uriKey) ?? 0) + 1;
  diagGen.set(uriKey, myGen);
  const parsed = parser.parse(doc);
  if (!parsed) {
    diagnostics.set(doc.uri, []);
    return;
  }
  // Root = the @type whose block is largest (outermost). If none, nothing to validate.
  const atTypes = parsed.atTypes ?? [];
  if (!atTypes.length) {
    diagnostics.set(doc.uri, []);
    return;
  }
  // Build constraint lines: for every @type with a computable static path,
  // emit `_check_N: <path> & #<version-suffixed-builder>`. Respects @version.
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
  const versionSuffix = (versionSpec: string) =>
    "_v" + versionSpec.replace(/[^0-9]/g, "_").replace(/^_+|_+$/g, "");
  const pickDefName = (builderName: string, declared?: string): string | null => {
    const versions = metadata.builders[builderName];
    if (!versions) return null;
    if (versions.length === 1) return "#" + sanitize(builderName);
    // Match the declared @version (or DEFAULT_VERSION = 0.0.0) against each
    // entry; fall back to the default alias if nothing matches.
    const target = declared ?? DEFAULT_VERSION;
    const entry = versions.find((v) => matchesSpec(target, v.version_spec));
    if (entry) return "#" + sanitize(builderName) + versionSuffix(entry.version_spec);
    return "#" + sanitize(builderName);
  };
  // For body-inject fallback: rewrite each source line by substituting each
  // external reference with its Replacement text. Top-level `#`-defs and
  // locally-declared bindings aren't in externalRefs, so they pass through.
  const lines = doc.getText().split("\n");
  const rewriteLineForAt = (lineIdx0: number, at: AtType): string => {
    const raw = lines[lineIdx0] ?? "";
    if (!at.externalRefs?.length) return raw;
    const line1 = lineIdx0 + 1;
    const subs = at.externalRefs.filter((r) => r.range.start.line === line1)
      .map((r) => ({
        col: r.range.start.col - 1,               // 0-based column
        width: r.range.end.col - r.range.start.col,
        replacement: r.replacement,
      }))
      .sort((a, b) => b.col - a.col);              // right-to-left so earlier subs keep their cols
    let out = raw;
    for (const { col, width, replacement } of subs) {
      out = out.slice(0, col) + replacement + out.slice(col + width);
    }
    return out;
  };

  const dynamicPrefixes = metadata.dynamic_prefixes ?? ["np.", "torch."];
  const constraints: string[] = [];   // simple one-liner checks (static path, listComp)
  const bodyInjects: { at: AtType; def: string; startLine0: number; endLine0: number; n: number }[] = [];
  const unknownDiags: vscode.Diagnostic[] = [];
  const dynamicUnknowns: AtType[] = [];   // np.*/torch.* — verified against the resolver
  let skipped = 0;
  let compChecks = 0;
  let injectChecks = 0;
  for (let i = 0; i < atTypes.length; i++) {
    const at = atTypes[i];
    const def = pickDefName(at.name, at.version);
    if (!def) {
      if (dynamicPrefixes.some((p) => at.name.startsWith(p))) {
        // np.*/torch.* resolve at build time via dynamic resolvers, not the
        // static registry; defer to the resolver-verification pass below.
        dynamicUnknowns.push(at);
      } else {
        // Unknown @type — flag the literal directly. Works regardless of
        // whether the block is reachable by a static path.
        unknownDiags.push(
          new vscode.Diagnostic(
            vscodeRange(at.nameRange),
            `'${at.name}' is not a registered zetta_utils builder.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
      continue;
    }
    if (at.path) {
      constraints.push(`_check_${i}: ${at.path} & ${def}`);
      continue;
    }
    if (at.listPath) {
      // Inside a list comprehension: iterate the host list and unify each
      // element (or relative sub-struct) with the schema. cue vet still
      // anchors any error to the user's source line inside _spec_root.
      const rel = at.relPath ?? "";
      // Skip nested checks in mixed-element lists: iteration may cross
      // heterogeneous elements where <rel> doesn't exist, erroring the
      // comprehension itself rather than reporting the real issue.
      if (at.listMixed && rel !== "") { skipped++; continue; }
      const nameLit = JSON.stringify(at.name);
      constraints.push(
        `_check_${i}: [for _x in ${at.listPath} if _x${rel}["@type"] == ${nameLit} { _x${rel} & ${def} }]`,
      );
      compChecks++;
      continue;
    }
    // Body-inject fallback: paste the block source verbatim, substitute
    // external refs (hidden fields, loop-vars) with their declaration RHS
    // (or `_`), unify with the schema. Works even inside if-clauses with
    // non-concrete conditions because the block is evaluated standalone.
    bodyInjects.push({
      at, def,
      startLine0: at.blockRange.start.line - 1,
      endLine0: at.blockRange.end.line - 1,
      n: i,
    });
    injectChecks++;
  }
  // Verify np.*/torch.* @types against the real dynamic resolver; flag only typos.
  if (dynamicUnknowns.length) {
    const unresolved = await verifyDynamicNames(dynamicUnknowns.map((a) => a.name), metadata.cache_key);
    for (const at of dynamicUnknowns) {
      if (unresolved.has(at.name)) {
        unknownDiags.push(
          new vscode.Diagnostic(
            vscodeRange(at.nameRange),
            `'${at.name}' does not resolve via the np.*/torch.* dynamic resolver.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }
  }
  if (diagGen.get(uriKey) !== myGen) return;   // superseded by a newer run
  if (!constraints.length && !bodyInjects.length) {
    diagnostics.set(doc.uri, unknownDiags);
    return;
  }
  log(`  ${constraints.length + bodyInjects.length} constraints (${compChecks} list-comp, ${injectChecks} body-inject), ${unknownDiags.length} unknown-@type diags (${skipped} skipped)`);

  // Build combined.cue preserving per-line origin mapping.
  const combinedLineToOrig: number[] = [-1]; // 1-based; index 0 unused
  const parts: string[] = [];
  const synth = (s: string) => { parts.push(s); combinedLineToOrig.push(-1); };
  const fromOrig = (s: string, i: number) => { parts.push(s); combinedLineToOrig.push(i); };

  synth("package zbuilder");
  synth("");
  for (let i = 0; i < lines.length; i++) if (/^\s*import\s/.test(lines[i])) fromOrig(lines[i], i);
  synth("");
  synth("_spec_root: {");
  for (let i = 0; i < lines.length; i++) if (!/^\s*import\s/.test(lines[i])) fromOrig(lines[i], i);
  synth("}");
  synth("");
  const schemasText = fs.readFileSync(schemasPath, "utf8").replace(/^package\s+\w+\s*\n?/m, "");
  for (const l of schemasText.split("\n")) synth(l);
  synth("");
  for (const c of constraints) synth(c);
  // Body-inject checks: paste the block source (with external refs rewritten)
  // and unify with the schema. Each pasted line maps back to its user source
  // line so cue vet errors land on the right squiggle.
  for (const b of bodyInjects) {
    const { at, def, startLine0, endLine0, n } = b;
    const startCol0 = at.blockRange.start.col - 1;
    const endCol0 = at.blockRange.end.col - 1;
    if (startLine0 === endLine0) {
      const line = rewriteLineForAt(startLine0, at);
      fromOrig(`_check_${n}: ${line.slice(startCol0, endCol0)} & ${def}`, startLine0);
      continue;
    }
    const first = rewriteLineForAt(startLine0, at);
    fromOrig(`_check_${n}: ${first.slice(startCol0)}`, startLine0);
    for (let j = startLine0 + 1; j < endLine0; j++) {
      fromOrig(rewriteLineForAt(j, at), j);
    }
    const last = rewriteLineForAt(endLine0, at);
    fromOrig(`${last.slice(0, endCol0)} & ${def}`, endLine0);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcue-"));
  const combinedPath = path.join(tmpDir, "combined.cue");
  fs.writeFileSync(combinedPath, parts.join("\n"));

  const t0 = Date.now();
  const stderr = await runCueVet(cuePath, combinedPath, 5000);
  log(`updateDiagnostics(${path.basename(doc.fileName)}): ${constraints.length + bodyInjects.length} checks, cue vet ${Date.now() - t0}ms, stderr=${stderr.length}B`);
  if (stderr && stderr.length < 2000) log(`  stderr:\n${stderr}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const cueErrors = parseCueErrors(stderr);
  const diagnosticsArr: vscode.Diagnostic[] = [...unknownDiags];
  // List-comprehension checks fire once per produced iteration, so cue vet
  // emits N copies of the same error. Dedupe by (line, col, message).
  const seen = new Set<string>();
  for (const err of cueErrors) {
    const origLine = combinedLineToOrig[err.line];
    if (origLine === undefined || origLine < 0) continue;
    const key = `${origLine}:${err.col}:${err.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const origLineText = lines[origLine] ?? "";
    const range = new vscode.Range(origLine, Math.max(0, err.col - 1), origLine, Math.max(origLineText.length, err.col));
    diagnosticsArr.push(new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error));
  }
  if (diagGen.get(uriKey) !== myGen) return;   // superseded by a newer run
  diagnostics.set(doc.uri, diagnosticsArr);
}

// ─────────────────────────────────────────────────────────────
// Regenerate command (unchanged behavior)
// ─────────────────────────────────────────────────────────────

async function regenerate(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("zettaCue");
  const pythonPath = await resolvePythonPath();
  const extractorPath = cfg.get<string>("extractorPath") || path.join(context.extensionPath, "extract.py");
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Zetta CUE: Regenerating metadata…", cancellable: false },
    () => new Promise<void>((resolve, reject) => {
      const child = cp.spawn(pythonPath, [extractorPath], { timeout: 120000 });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      // Drain stdout: a chatty import-time banner could otherwise fill the pipe
      // buffer and block the child forever. The cache dir is found on disk by
      // mtime, so the extractor's stdout is not needed here.
      child.stdout?.on("data", () => {});
      // A spawn failure (missing or stale interpreter path → ENOENT) emits
      // 'error' and never 'close'; without this listener the progress promise
      // would hang indefinitely instead of surfacing the problem.
      child.on("error", (err) => {
        vscode.window.showErrorMessage(
          `Zetta CUE: could not run Python '${pythonPath}': ${err.message}. ` +
          `Set 'zettaCue.pythonPath' to a Python interpreter with zetta_utils installed.`,
        );
        reject(err);
      });
      child.on("close", (code) => {
        if (code === 0) { vscode.window.showInformationMessage("Zetta CUE: metadata refreshed."); resolve(); }
        else {
          const hint = /No module named ['"]?zetta_utils/.test(stderr)
            ? "\n\nThis interpreter can't import zetta_utils — set 'zettaCue.pythonPath' to the venv that has it."
            : "";
          vscode.window.showErrorMessage(
            `Zetta CUE: extractor exited ${code}. Last stderr:\n${stderr.split("\n").slice(-8).join("\n")}${hint}`,
          );
          reject(new Error(`extractor exit ${code}`));
        }
      });
    }),
  );
}

// ─────────────────────────────────────────────────────────────
// Activation
// ─────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Zetta CUE");
  context.subscriptions.push(output);
  log(`activate: extensionPath=${context.extensionPath}`);

  const binPath = parserBinaryPath(context.extensionPath);
  if (!binPath || !fs.existsSync(binPath)) {
    vscode.window.showErrorMessage(
      `Zetta CUE: no parser binary for ${process.platform}/${process.arch}. ` +
      `Extension is disabled.`,
    );
    return;
  }
  try { fs.chmodSync(binPath, 0o755); } catch {}
  const parser = new Parser(binPath);
  log(`parser binary: ${binPath}`);

  const diagnostics = vscode.languages.createDiagnosticCollection("zetta-cue");
  context.subscriptions.push(diagnostics);

  let loaded = await loadMetadata();
  log(loaded
    ? `metadata: ${path.dirname(loaded.schemasPath)} — ${Object.keys(loaded.metadata.builders).length} builders`
    : `no metadata cache found under ${cacheRoot()}`);
  if (!loaded) {
    vscode.window.showInformationMessage(
      "Zetta CUE: no metadata cache. Run regeneration now?", "Regenerate", "Dismiss",
    ).then((pick) => { if (pick === "Regenerate") vscode.commands.executeCommand("zetta-cue.regenerate"); });
  }

  const cfg = vscode.workspace.getConfiguration("zettaCue");
  const cuePath = cfg.get<string>("cuePath") || "cue";

  // Hover: identifier ref → declaration preview; @type → builder doc
  context.subscriptions.push(vscode.languages.registerHoverProvider("cue", {
    provideHover(doc, pos) {
      const parsed = parser.parse(doc);
      if (!parsed) return null;
      // Priority 1: an identifier reference under the cursor that resolves to
      // a declaration in lexical scope (covers #DEFS, fields, let-bindings).
      const ref = (parsed.references ?? []).find((r) => positionInRange(pos, r.range));
      if (ref?.resolvesTo) {
        const def = ref.resolvesTo;
        const snippet = doc.getText(vscodeRange(def.bodyRange)).split("\n").slice(0, 20).join("\n");
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        const kindWord = def.kind === "definition" ? "definition"
          : def.kind === "let" ? "let-binding" : "field";
        md.appendMarkdown(`**\`${ref.name}\`** — ${kindWord} at line ${def.nameRange.start.line}\n\n`);
        md.appendCodeblock(snippet, "cue");
        return new vscode.Hover(md, vscodeRange(ref.range));
      }
      // Priority 2: @type builder — innermost enclosing block wins
      if (!loaded) return null;
      const at = findInnermostAtType(parsed, pos);
      if (!at) return null;
      const versions = loaded.metadata.builders[at.name];
      if (!versions) {
        return new vscode.Hover(
          new vscode.MarkdownString(`\`${at.name}\` is not a registered zetta_utils builder.`),
          vscodeRange(at.nameRange),
        );
      }
      const entry = resolveVersion(versions, at.version);
      if (!entry) return null;
      return new vscode.Hover(renderBuilderHover(at.name, entry), vscodeRange(at.nameRange));
    },
  }));

  // Definition provider: F12 / Ctrl+Click on any resolved identifier ref
  context.subscriptions.push(vscode.languages.registerDefinitionProvider("cue", {
    provideDefinition(doc, pos) {
      const parsed = parser.parse(doc);
      if (!parsed) return null;
      const ref = (parsed.references ?? []).find((r) => positionInRange(pos, r.range));
      if (!ref?.resolvesTo) return null;
      return new vscode.Location(doc.uri, vscodeRange(ref.resolvesTo.nameRange).start);
    },
  }));

  // Status-bar indicator.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  context.subscriptions.push(status);
  status.command = "zetta-cue.regenerate";
  const setStatus = (text: string, tooltip?: string) => {
    status.text = text;
    status.tooltip = tooltip ?? "Click to regenerate builder metadata";
    status.show();
  };
  setStatus(loaded ? "$(check) Zetta CUE" : "$(warning) Zetta CUE: no metadata");

  // Suppress diagnostics while stale or regenerating — prevents false alarms
  // when source has drifted from cached schema.
  let suppressed = false;
  const clearAll = () => {
    for (const doc of vscode.workspace.textDocuments) diagnostics.delete(doc.uri);
  };

  // Diagnostics (debounced)
  const debounces = new Map<string, NodeJS.Timeout>();
  const trigger = (doc: vscode.TextDocument) => {
    if (!loaded || suppressed) return;
    const key = doc.uri.toString();
    const existing = debounces.get(key);
    if (existing) clearTimeout(existing);
    debounces.set(key, setTimeout(
      () => updateDiagnostics(doc, parser, loaded!.metadata, loaded!.schemasPath, cuePath, diagnostics),
      250,
    ));
  };
  vscode.workspace.onDidOpenTextDocument(trigger, null, context.subscriptions);
  vscode.workspace.onDidChangeTextDocument((e) => trigger(e.document), null, context.subscriptions);
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("zettaCue.pythonPath")) clearDynamicCache();
  }, null, context.subscriptions);

  // Regeneration (shared by manual + auto paths).
  let regenInFlight: Promise<void> | null = null;
  const runRegen = async (reason: string): Promise<void> => {
    if (regenInFlight) return regenInFlight;
    suppressed = true;
    clearAll();
    setStatus("$(sync~spin) Zetta CUE: regenerating…", `Reason: ${reason}`);
    log(`regen start: ${reason}`);
    regenInFlight = (async () => {
      try {
        await regenerate(context);
        loaded = await loadMetadata();
        log(`regen done; loaded ${loaded ? Object.keys(loaded.metadata.builders).length : 0} builders`);
      } catch (e) {
        log(`regen failed: ${e}`);
        setStatus("$(error) Zetta CUE: regen failed", String(e));
      } finally {
        regenInFlight = null;
        suppressed = false;
        setStatus(loaded ? "$(check) Zetta CUE" : "$(warning) Zetta CUE: no metadata");
        vscode.workspace.textDocuments.forEach(trigger);
      }
    })();
    return regenInFlight;
  };

  // Staleness check: compare live source hash to cached metadata's cache_key.
  const isStale = (): boolean => {
    if (!loaded?.metadata.source_path) return false;
    if (!fs.existsSync(loaded.metadata.source_path)) return false;
    try {
      const extractPyPath = path.join(context.extensionPath, "extract.py");
      const live = hashSourceTree(loaded.metadata.source_path, extractPyPath);
      const cached = loaded.metadata.cache_key;
      if (live !== cached) log(`staleness: live=${live} cached=${cached}`);
      return live !== cached;
    } catch (e) {
      log(`hashSourceTree failed: ${e}`);
      return false;
    }
  };

  // 1. Check at activation; regenerate in background if stale.
  if (loaded && isStale()) {
    runRegen("activation: cache hash mismatch");
  } else {
    vscode.workspace.textDocuments.forEach(trigger);
  }

  // 2. Watch zetta_utils sources for edits; debounce + re-hash + regen on mismatch.
  if (loaded?.metadata.source_path) {
    const pattern = new vscode.RelativePattern(loaded.metadata.source_path, "**/*.py");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    context.subscriptions.push(watcher);
    let fsDebounce: NodeJS.Timeout | undefined;
    const onSrcChange = () => {
      if (fsDebounce) clearTimeout(fsDebounce);
      fsDebounce = setTimeout(() => {
        if (isStale()) runRegen("zetta_utils source changed");
      }, 1500);
    };
    watcher.onDidChange(onSrcChange);
    watcher.onDidCreate(onSrcChange);
    watcher.onDidDelete(onSrcChange);
  }

  // 3. Manual command.
  context.subscriptions.push(vscode.commands.registerCommand("zetta-cue.regenerate",
    () => runRegen("manual")));
}

export function deactivate() {}
