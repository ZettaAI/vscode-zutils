// zcue-parse — parse a CUE file and emit structural info the extension needs.
// Uses cue/parser (AST-level) with a hand-rolled lexical scope tracker.
// Does NOT evaluate or run the compiler — staying lean.
//
// Output: JSON document on stdout.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"cuelang.org/go/cue/ast"
	"cuelang.org/go/cue/parser"
	"cuelang.org/go/cue/token"
)

// ── Output schema ─────────────────────────────────────────────────────────

type Pos struct {
	Offset int `json:"offset"`
	Line   int `json:"line"`
	Col    int `json:"col"`
}

type Range struct {
	Start Pos `json:"start"`
	End   Pos `json:"end"`
}

// AtType captures a "@type": "NAME" occurrence along with the enclosing
// struct's range and any sibling "@version"/"@mode".
type AtType struct {
	Name         string `json:"name"`
	NameRange    Range  `json:"nameRange"`
	KeyRange     Range  `json:"keyRange"`
	BlockRange   Range  `json:"blockRange"`
	Version      string `json:"version,omitempty"`
	VersionRange *Range `json:"versionRange,omitempty"`
	Mode         string `json:"mode,omitempty"`
	// Path is a CUE reference expression that selects this block's struct
	// from the file root, e.g. "target.stages[0].dst" or "#STAGE_TMPL.dst".
	// Empty if the @type lives inside a comprehension or other non-static
	// construct and cannot be reached by a static path.
	Path string `json:"path,omitempty"`
	// ListPath and RelPath are set when the @type sits inside a list
	// comprehension whose host list has a static path. The constraint
	// consumer can then validate via
	//     [for _x in <ListPath> if _x<RelPath>["@type"] == <Name> { _x<RelPath> & #<def> }]
	// which unifies each produced element (or a relative sub-struct of it)
	// with the builder schema. Empty when not applicable.
	ListPath string `json:"listPath,omitempty"`
	RelPath  string `json:"relPath,omitempty"`
	// ListMixed is true when the host list contains more than one
	// comprehension OR any literal mixed with a comprehension. In that case
	// only outer-level (RelPath == "") checks should be emitted — nested
	// paths are not guaranteed to exist across all iterations and would
	// error out mid-comprehension.
	ListMixed bool `json:"listMixed,omitempty"`
	// ExternalRefs are identifier uses inside BlockRange whose declarations
	// resolve OUTSIDE of BlockRange and aren't top-level `#`-defs. For a
	// body-inject fallback check (used when neither Path nor ListPath
	// resolve), these positions get substituted with `_` so the block can
	// be pasted standalone and still have cue vet the field names.
	ExternalRefs []RefPos `json:"externalRefs,omitempty"`
}

// RefPos is a reference location inside an AtType block that can't be
// resolved standalone. Replacement is the text to substitute at Range —
// typically the declaration's RHS expression so type propagation is
// preserved; "_" when the RHS isn't a safe single-line expression (multi-
// line values, self-referential loop-var decls).
type RefPos struct {
	Name        string `json:"name"`
	Range       Range  `json:"range"`
	Replacement string `json:"replacement"`
}

// Declaration: any lexical binding a reference can resolve to — #-definitions,
// regular fields (whose label is an identifier or plain string), and `let`
// clauses.
type DeclKind string

const (
	DeclDefinition DeclKind = "definition" // #NAME:
	DeclField      DeclKind = "field"      // name: or "name":
	DeclLet        DeclKind = "let"        // let name = ...
)

type Declaration struct {
	Name      string   `json:"name"` // for #-defs: includes '#'
	Kind      DeclKind `json:"kind"`
	NameRange Range    `json:"nameRange"` // label position (what you jump TO)
	BodyRange Range    `json:"bodyRange"` // rhs expression range
}

// Reference: any identifier use that CUE treats as a lexical reference
// (not a label, not a selector target — the RHS `foo` in `x: foo`, etc.).
type Reference struct {
	Name  string `json:"name"`
	Range Range  `json:"range"`
	// ResolvesTo is the Declaration that lexical scoping maps this ref to,
	// or nil if unresolved (undefined / external / selector target).
	ResolvesTo *Declaration `json:"resolvesTo,omitempty"`
}

type Output struct {
	AtTypes      []AtType      `json:"atTypes"`
	Declarations []Declaration `json:"declarations"`
	References   []Reference   `json:"references"`
	ParseErrors  []string      `json:"parseErrors"`
}

// ── Position helpers ──────────────────────────────────────────────────────

func mkPos(p token.Pos) Pos          { return Pos{Offset: p.Offset(), Line: p.Line(), Col: p.Column()} }
func mkRange(lo, hi token.Pos) Range { return Range{Start: mkPos(lo), End: mkPos(hi)} }
func nodeRange(n ast.Node) Range     { return mkRange(n.Pos(), n.End()) }

// ── Label extraction ──────────────────────────────────────────────────────

// labelBinding returns the declaration-binding name introduced by a field
// label, along with the Range of that label. A binding is created only for
// identifier labels (`foo`), string labels (`"foo"`), and #-labels
// (`#foo`). Dynamic labels (`(expr)`) and pattern labels (`[...]`) don't bind.
func labelBinding(l ast.Label) (name string, r Range, kind DeclKind, ok bool) {
	switch lv := l.(type) {
	case *ast.Ident:
		// Ident covers both `foo` and `#foo` (the '#' is part of the name).
		k := DeclField
		if len(lv.Name) > 0 && lv.Name[0] == '#' {
			k = DeclDefinition
		}
		return lv.Name, nodeRange(lv), k, true
	case *ast.BasicLit:
		if lv.Kind == token.STRING {
			s := lv.Value
			if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
				return s[1 : len(s)-1], nodeRange(lv), DeclField, true
			}
		}
	}
	return "", Range{}, "", false
}

// stringValue: concrete "…" string literal, returns the inner value.
func stringValue(e ast.Expr) (string, Range, bool) {
	lit, ok := e.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", Range{}, false
	}
	s := lit.Value
	if len(s) < 2 || s[0] != '"' || s[len(s)-1] != '"' {
		return "", Range{}, false
	}
	return s[1 : len(s)-1], nodeRange(lit), true
}

// ── Scope tracker ────────────────────────────────────────────────────────

type scope struct {
	parent *scope
	// Name → Declaration. Multiple declarations of the same name collapse;
	// we keep the first (first-occurrence has the label most users jump to).
	decls map[string]*Declaration
}

func newScope(parent *scope) *scope { return &scope{parent: parent, decls: map[string]*Declaration{}} }

func (s *scope) declare(d *Declaration) {
	if s.decls[d.Name] == nil {
		s.decls[d.Name] = d
	}
}

func (s *scope) lookup(name string) *Declaration {
	for cur := s; cur != nil; cur = cur.parent {
		if d, ok := cur.decls[name]; ok {
			return d
		}
	}
	return nil
}

// ── Walker ───────────────────────────────────────────────────────────────

// pathSegment represents one step of a static path from the file root.
type pathSegment struct {
	text string // ".name", "[3]", "#DEF"
	// dynamic: the surrounding construct is fully unaddressable statically
	// (struct-level `for`/`if` comprehensions, dynamic keys, …). Anything
	// below is lost.
	dynamic bool
	// listComp: the host list containing this comprehension has a static
	// path; elements are produced dynamically but each element can still be
	// reached by iterating `for _x in <list path>`. At most one listComp
	// boundary per stack is considered recoverable.
	listComp bool
	// listCompMixed: when listComp is set, true if the host list has more
	// than one comprehension or mixes comprehensions with literal elements.
	// Nested checks (relative path != "") are disabled in that case.
	listCompMixed bool
}

type walker struct {
	out     *Output
	pathStk []pathSegment // current ancestor path
}

// currentStaticPath renders the ancestor stack into a CUE reference expression
// rooted at _spec_root, or returns "" if any segment is dynamic or crosses a
// list-comprehension boundary.
func (w *walker) currentStaticPath() string {
	b := []byte("_spec_root")
	for _, s := range w.pathStk {
		if s.dynamic || s.listComp {
			return ""
		}
		b = append(b, s.text...)
	}
	return string(b)
}

// currentListCompPath returns (listPath, relPath, mixed, true) when the
// ancestor stack contains exactly one list-comprehension boundary and no
// fully dynamic segments — i.e. the @type can be validated by iterating
// the host list. listPath is the static path up to (but not including) the
// boundary; relPath is the static path from the per-iteration element to
// the @type's struct (may be empty). mixed propagates the host list's
// mixed-element status.
func (w *walker) currentListCompPath() (listPath, relPath string, mixed, ok bool) {
	boundary := -1
	for i, s := range w.pathStk {
		if s.dynamic {
			return "", "", false, false
		}
		if s.listComp {
			if boundary >= 0 {
				// Nested list comprehension; we don't try to recover.
				return "", "", false, false
			}
			boundary = i
		}
	}
	if boundary < 0 {
		return "", "", false, false
	}
	lp := []byte("_spec_root")
	for _, s := range w.pathStk[:boundary] {
		lp = append(lp, s.text...)
	}
	rp := []byte{}
	for _, s := range w.pathStk[boundary+1:] {
		rp = append(rp, s.text...)
	}
	return string(lp), string(rp), w.pathStk[boundary].listCompMixed, true
}

func (w *walker) push(seg pathSegment) { w.pathStk = append(w.pathStk, seg) }
func (w *walker) pop()                 { w.pathStk = w.pathStk[:len(w.pathStk)-1] }

// visitStruct processes a struct (file body or inline). It opens a new scope,
// populates it with bindings from this struct's fields/let-clauses (both
// passes needed since CUE allows forward references within a struct), then
// visits children inside that scope.
func (w *walker) visitStruct(block ast.Node, decls []ast.Decl, parent *scope) {
	s := newScope(parent)

	// Pass 1: collect bindings from this struct's declarations.
	// Also detect @type / @version / @mode for AtType emission.
	var atTypeField *ast.Field
	var atTypeName string
	var atTypeNameRng Range
	var atTypeKeyRng Range
	var atVersion string
	var atVersionRange *Range
	var atMode string

	for _, d := range decls {
		switch v := d.(type) {
		case *ast.Field:
			name, nameRng, kind, ok := labelBinding(v.Label)
			if ok {
				decl := &Declaration{
					Name:      name,
					Kind:      kind,
					NameRange: nameRng,
					BodyRange: nodeRange(v.Value),
				}
				s.declare(decl)
				w.out.Declarations = append(w.out.Declarations, *decl)
			}
			// @type / @version / @mode detection (only when label is a quoted
			// meta-key "@type" etc.; labelBinding emits those as plain names).
			if ok {
				switch name {
				case "@type":
					if sVal, rng, okV := stringValue(v.Value); okV {
						atTypeField = v
						atTypeName = sVal
						atTypeNameRng = rng
						atTypeKeyRng = nodeRange(v.Label)
					}
				case "@version":
					if sVal, rng, okV := stringValue(v.Value); okV {
						atVersion = sVal
						rngCopy := rng
						atVersionRange = &rngCopy
					}
				case "@mode":
					if sVal, _, okV := stringValue(v.Value); okV {
						atMode = sVal
					}
				}
			}
		case *ast.LetClause:
			if v.Ident != nil {
				decl := &Declaration{
					Name:      v.Ident.Name,
					Kind:      DeclLet,
					NameRange: nodeRange(v.Ident),
					BodyRange: nodeRange(v.Expr),
				}
				s.declare(decl)
				w.out.Declarations = append(w.out.Declarations, *decl)
			}
		}
	}
	if atTypeField != nil {
		at := AtType{
			Name:         atTypeName,
			NameRange:    atTypeNameRng,
			KeyRange:     atTypeKeyRng,
			BlockRange:   nodeRange(block),
			Version:      atVersion,
			VersionRange: atVersionRange,
			Mode:         atMode,
			Path:         w.currentStaticPath(),
		}
		if at.Path == "" {
			if lp, rp, mixed, ok := w.currentListCompPath(); ok {
				at.ListPath = lp
				at.RelPath = rp
				at.ListMixed = mixed
			}
		}
		w.out.AtTypes = append(w.out.AtTypes, at)
	}

	// Pass 2: visit children in the new scope.
	for _, d := range decls {
		w.visitDecl(d, s)
	}
}

func (w *walker) visitDecl(d ast.Decl, s *scope) {
	switch v := d.(type) {
	case *ast.Field:
		// Push a path segment for this field's label.
		name, _, kind, ok := labelBinding(v.Label)
		var seg pathSegment
		if ok {
			if kind == DeclDefinition {
				seg = pathSegment{text: "." + name}
			} else if isCUEIdent(name) && !isMetaLabel(name) {
				seg = pathSegment{text: "." + name}
			} else {
				// Quoted label that's not a plain ident — escape it.
				seg = pathSegment{text: fmt.Sprintf("[%q]", name)}
			}
		} else {
			// Interpolated label (`"\(expr)": ...`), pattern label ([=~"…"]:),
			// etc. — the key is not a static path segment, so paths through
			// this field are not addressable.
			seg = pathSegment{dynamic: true}
		}
		w.push(seg)
		w.visitExpr(v.Value, s)
		w.pop()
	case *ast.LetClause:
		w.visitExpr(v.Expr, s)
	case *ast.EmbedDecl:
		w.visitExpr(v.Expr, s)
	case *ast.Comprehension:
		// Comprehensions produce values that cannot be reached by a static
		// path — mark descent as dynamic so AtTypes inside get Path == "".
		w.push(pathSegment{dynamic: true})
		cs := newScope(s)
		for _, c := range v.Clauses {
			w.visitClause(c, cs)
		}
		if v.Value != nil {
			w.visitExpr(v.Value, cs)
		}
		w.pop()
	}
}

// isMetaLabel returns true for labels that are field *metadata* in our sense
// and should not appear in a CUE reference path ("@type", "@version", "@mode").
func isMetaLabel(s string) bool {
	return len(s) > 0 && s[0] == '@'
}

// isCUEIdent returns true if s is a valid CUE identifier (letters, digits,
// underscore, '$'; first char not a digit). Rough but good enough.
func isCUEIdent(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_' || r == '$'
		if !ok && i > 0 {
			ok = r >= '0' && r <= '9'
		}
		if !ok {
			return false
		}
	}
	return true
}

func (w *walker) visitClause(c ast.Clause, s *scope) {
	switch cv := c.(type) {
	case *ast.ForClause:
		w.visitExpr(cv.Source, s)
		// `for k, v in X`: k and v become visible afterwards.
		if cv.Key != nil {
			s.declare(&Declaration{
				Name: cv.Key.Name, Kind: DeclField,
				NameRange: nodeRange(cv.Key), BodyRange: nodeRange(cv.Key),
			})
		}
		if cv.Value != nil {
			s.declare(&Declaration{
				Name: cv.Value.Name, Kind: DeclField,
				NameRange: nodeRange(cv.Value), BodyRange: nodeRange(cv.Value),
			})
		}
	case *ast.IfClause:
		w.visitExpr(cv.Condition, s)
	case *ast.LetClause:
		w.visitExpr(cv.Expr, s)
		if cv.Ident != nil {
			s.declare(&Declaration{
				Name: cv.Ident.Name, Kind: DeclLet,
				NameRange: nodeRange(cv.Ident), BodyRange: nodeRange(cv.Expr),
			})
		}
	}
}

func (w *walker) visitExpr(e ast.Expr, s *scope) {
	if e == nil {
		return
	}
	switch v := e.(type) {
	case *ast.StructLit:
		w.visitStruct(v, v.Elts, s)
	case *ast.ListLit:
		// Classify the list. "mixed" = the list contains more than one
		// comprehension OR any literal element alongside a comprehension;
		// in that case nested relPath checks are unsafe because iterations
		// can produce structs of differing shape. "homogeneous" = exactly
		// one comprehension and no literals: all iterations share a shape,
		// nested checks are safe. "static" = no comprehensions at all, use
		// AST indexing.
		nComp, nLit := 0, 0
		for _, el := range v.Elts {
			if _, isComp := el.(*ast.Comprehension); isComp {
				nComp++
			} else {
				nLit++
			}
		}
		hasComp := nComp > 0
		mixed := hasComp && (nComp > 1 || nLit > 0)
		for i, el := range v.Elts {
			if comp, isComp := el.(*ast.Comprehension); isComp {
				w.push(pathSegment{listComp: true, listCompMixed: mixed})
				cs := newScope(s)
				for _, c := range comp.Clauses {
					w.visitClause(c, cs)
				}
				if comp.Value != nil {
					w.visitExpr(comp.Value, cs)
				}
				w.pop()
				continue
			}
			if hasComp {
				// Literal element adjacent to a comprehension — AST index
				// is unreliable; fall back to iteration (always mixed).
				w.push(pathSegment{listComp: true, listCompMixed: true})
			} else {
				w.push(pathSegment{text: fmt.Sprintf("[%d]", i)})
			}
			w.visitExpr(el, s)
			w.pop()
		}
	case *ast.BinaryExpr:
		w.visitExpr(v.X, s)
		w.visitExpr(v.Y, s)
	case *ast.UnaryExpr:
		w.visitExpr(v.X, s)
	case *ast.ParenExpr:
		w.visitExpr(v.X, s)
	case *ast.CallExpr:
		w.visitExpr(v.Fun, s)
		for _, a := range v.Args {
			w.visitExpr(a, s)
		}
	case *ast.SelectorExpr:
		// Only the base is a scope reference; the selector tail is a field
		// navigation, not a lexical reference.
		w.visitExpr(v.X, s)
	case *ast.IndexExpr:
		w.visitExpr(v.X, s)
		w.visitExpr(v.Index, s)
	case *ast.SliceExpr:
		w.visitExpr(v.X, s)
		w.visitExpr(v.Low, s)
		w.visitExpr(v.High, s)
	case *ast.Interpolation:
		for _, part := range v.Elts {
			w.visitExpr(part, s)
		}
	case *ast.Ident:
		// A reference. Skip well-known builtins ("string", "int", "_", etc.);
		// we won't find them in scope and they would pollute the "unresolved"
		// signal. Also skip the empty identifier.
		if v.Name == "" {
			return
		}
		if isBuiltin(v.Name) {
			return
		}
		ref := Reference{
			Name:  v.Name,
			Range: nodeRange(v),
		}
		if decl := s.lookup(v.Name); decl != nil {
			// Copy to avoid sharing the pointer from the scope map.
			d := *decl
			ref.ResolvesTo = &d
		}
		w.out.References = append(w.out.References, ref)
	case *ast.Comprehension:
		// Same as the visitDecl case: values produced by a comprehension
		// cannot be addressed by a static path, so mark descent dynamic.
		// This matters for list comprehensions like `[ for x in xs { ... } ]`
		// where the comprehension is a ListLit element.
		w.push(pathSegment{dynamic: true})
		cs := newScope(s)
		for _, c := range v.Clauses {
			w.visitClause(c, cs)
		}
		if v.Value != nil {
			w.visitExpr(v.Value, cs)
		}
		w.pop()
	}
}

// CUE built-in identifier names. Not exhaustive; covers the common ones we'd
// otherwise spam as "unresolved" refs.
var builtinNames = map[string]bool{
	"_": true, "_|_": true,
	"string": true, "int": true, "float": true, "number": true,
	"bool": true, "bytes": true, "null": true, "true": true, "false": true,
	"uint": true, "uint8": true, "uint16": true, "uint32": true, "uint64": true,
	"int8": true, "int16": true, "int32": true, "int64": true,
	"float32": true, "float64": true,
	"len": true, "close": true, "and": true, "or": true, "div": true, "mod": true, "quo": true, "rem": true,
}

func isBuiltin(name string) bool { return builtinNames[name] }

// ── Main ──────────────────────────────────────────────────────────────────

func run(path string) (*Output, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	f, err := parser.ParseFile(path, src, parser.ParseComments)
	out := &Output{}
	if err != nil {
		out.ParseErrors = append(out.ParseErrors, err.Error())
		if f == nil {
			return out, nil
		}
	}
	w := &walker{out: out}
	// Imports in f.Imports aren't user-scoped bindings we care about for ref
	// resolution; they're handled separately by CUE.
	w.visitStruct(f, f.Decls, nil)

	// Post-pass: compute ExternalRefs for each AtType. An "external" ref is
	// an identifier inside the block whose declaration sits outside the
	// block (loop variables, hidden fields of ancestor defs) AND which is
	// not a top-level `#`-def (those are globally addressable and keep
	// their meaning when the block is pasted standalone). Unresolved refs
	// also count — they'd break a standalone paste just as badly.
	//
	// For each external ref we record a Replacement string to splice at
	// the ref's position. Prefer the declaration's RHS expression so type
	// propagation survives; fall back to "_" when the RHS isn't a safe
	// single-line expression (multi-line values, self-referential loop-var
	// decls, or unresolvable refs).
	safeInline := func(body []byte, refName string) string {
		text := string(body)
		if text == "" || text == refName {
			return "_"
		}
		for _, b := range body {
			if b == '\n' {
				return "_"
			}
		}
		// Wrap in parens so the splice is a single operand regardless of
		// internal operators (e.g. "_ | *null").
		return "(" + text + ")"
	}
	for i := range out.AtTypes {
		at := &out.AtTypes[i]
		bs, be := at.BlockRange.Start.Offset, at.BlockRange.End.Offset
		for _, ref := range out.References {
			ro := ref.Range.Start.Offset
			if ro < bs || ro >= be {
				continue
			}
			rep := "_"
			if ref.ResolvesTo == nil {
				// unresolved — stays "_"
			} else {
				d := ref.ResolvesTo
				do := d.NameRange.Start.Offset
				if do >= bs && do < be {
					continue // declared inside the block; local binding, keep
				}
				if len(d.Name) > 0 && d.Name[0] == '#' {
					// `#`-def declared outside the block. In combined.cue the
					// user body is nested under `_spec_root`, so top-level
					// `#FOO` must be rewritten to `_spec_root.#FOO` to stay
					// reachable from the body-inject check's top-level scope.
					rep = "_spec_root." + d.Name
				} else {
					dbs, dbe := d.BodyRange.Start.Offset, d.BodyRange.End.Offset
					if dbs >= 0 && dbe <= len(src) && dbs < dbe {
						rep = safeInline(src[dbs:dbe], ref.Name)
					}
				}
			}
			at.ExternalRefs = append(at.ExternalRefs, RefPos{
				Name:        ref.Name,
				Range:       ref.Range,
				Replacement: rep,
			})
		}
	}
	return out, nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: zcue-parse <file.cue>")
		os.Exit(2)
	}
	out, err := run(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
