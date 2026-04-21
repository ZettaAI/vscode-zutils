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
	text    string // ".name", "[3]", "#DEF"
	dynamic bool   // true if inside a comprehension or similar non-static scope
}

type walker struct {
	out     *Output
	pathStk []pathSegment // current ancestor path
}

// currentStaticPath renders the ancestor stack into a CUE reference expression
// rooted at _spec_root, or returns "" if any segment is dynamic.
func (w *walker) currentStaticPath() string {
	b := []byte("_spec_root")
	for _, s := range w.pathStk {
		if s.dynamic {
			return ""
		}
		b = append(b, s.text...)
	}
	return string(b)
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
		w.out.AtTypes = append(w.out.AtTypes, AtType{
			Name:         atTypeName,
			NameRange:    atTypeNameRng,
			KeyRange:     atTypeKeyRng,
			BlockRange:   nodeRange(block),
			Version:      atVersion,
			VersionRange: atVersionRange,
			Mode:         atMode,
			Path:         w.currentStaticPath(),
		})
	}

	// Pass 2: visit children in the new scope.
	for _, d := range decls {
		w.visitDecl(d, s)
	}
}

func (w *walker) visitDecl(d ast.Decl, s *scope) {
	switch v := d.(type) {
	case *ast.Field:
		// Push a path segment for this field's label (when static).
		name, _, kind, ok := labelBinding(v.Label)
		pushed := false
		if ok {
			var seg pathSegment
			if kind == DeclDefinition {
				seg = pathSegment{text: "." + name}
			} else if isCUEIdent(name) && !isMetaLabel(name) {
				seg = pathSegment{text: "." + name}
			} else {
				// Quoted label that's not a plain ident — escape it.
				seg = pathSegment{text: fmt.Sprintf("[%q]", name)}
			}
			w.push(seg)
			pushed = true
		}
		w.visitExpr(v.Value, s)
		if pushed {
			w.pop()
		}
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
		for i, el := range v.Elts {
			// If the element is a Comprehension, visitExpr handles it and
			// marks the scope dynamic; otherwise this is a concrete index.
			if _, isComp := el.(*ast.Comprehension); isComp {
				w.visitExpr(el, s)
				continue
			}
			w.push(pathSegment{text: fmt.Sprintf("[%d]", i)})
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
