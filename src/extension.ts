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

function hashSourceTree(sourcePath: string): string {
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
  let lastMessage = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const pathMatch = line.trim().match(/^(?:\.\.\/)*\.?\/?([^:]+):(\d+):(\d+)$/);
    const locM = /:(\d+):(\d+)\s*$/.exec(line.trim());
    if (pathMatch && lastMessage && pathMatch[1].endsWith("combined.cue")) {
      errors.push({
        line: parseInt(pathMatch[2], 10),
        col: parseInt(pathMatch[3], 10),
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

async function updateDiagnostics(
  doc: vscode.TextDocument,
  parser: Parser,
  metadata: Metadata,
  schemasPath: string,
  cuePath: string,
  diagnostics: vscode.DiagnosticCollection,
) {
  if (doc.languageId !== "cue") return;
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
  const constraints: string[] = [];
  let skipped = 0;
  for (let i = 0; i < atTypes.length; i++) {
    const at = atTypes[i];
    if (!at.path) { skipped++; continue; }
    const def = pickDefName(at.name, at.version);
    if (!def) continue; // unknown builder
    constraints.push(`_check_${i}: ${at.path} & ${def}`);
  }
  if (!constraints.length) {
    diagnostics.set(doc.uri, []);
    return;
  }
  log(`  ${constraints.length} constraints (${skipped} inside comprehensions skipped)`);

  // Build combined.cue preserving per-line origin mapping.
  const lines = doc.getText().split("\n");
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcue-"));
  const combinedPath = path.join(tmpDir, "combined.cue");
  fs.writeFileSync(combinedPath, parts.join("\n"));

  const t0 = Date.now();
  const stderr = await runCueVet(cuePath, combinedPath, 5000);
  log(`updateDiagnostics(${path.basename(doc.fileName)}): ${constraints.length} checks, cue vet ${Date.now() - t0}ms, stderr=${stderr.length}B`);
  if (stderr && stderr.length < 2000) log(`  stderr:\n${stderr}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const cueErrors = parseCueErrors(stderr);
  const diagnosticsArr: vscode.Diagnostic[] = [];
  for (const err of cueErrors) {
    const origLine = combinedLineToOrig[err.line];
    if (origLine === undefined || origLine < 0) continue;
    const origLineText = lines[origLine] ?? "";
    const range = new vscode.Range(origLine, Math.max(0, err.col - 1), origLine, Math.max(origLineText.length, err.col));
    diagnosticsArr.push(new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error));
  }
  diagnostics.set(doc.uri, diagnosticsArr);
}

// ─────────────────────────────────────────────────────────────
// Regenerate command (unchanged behavior)
// ─────────────────────────────────────────────────────────────

async function regenerate(context: vscode.ExtensionContext) {
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
  const extractorPath = cfg.get<string>("extractorPath") || path.join(context.extensionPath, "extract.py");
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Zetta CUE: Regenerating metadata…", cancellable: false },
    () => new Promise<void>((resolve, reject) => {
      const child = cp.spawn(pythonPath, [extractorPath], { timeout: 120000 });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => {
        if (code === 0) { vscode.window.showInformationMessage("Zetta CUE: metadata refreshed."); resolve(); }
        else {
          vscode.window.showErrorMessage(`Zetta CUE: extractor exited ${code}. Last stderr:\n${stderr.split("\n").slice(-8).join("\n")}`);
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
      const live = hashSourceTree(loaded.metadata.source_path);
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
