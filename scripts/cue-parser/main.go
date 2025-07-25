package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"cuelang.org/go/cue/ast"
	"cuelang.org/go/cue/parser"
	"cuelang.org/go/cue/token"
)

// ParameterInfo represents a parameter found in a CUE @type context
type ParameterInfo struct {
	Name     string `json:"name"`
	Line     int    `json:"line"`
	Column   int    `json:"column"`
	Context  string `json:"context"`
	Version  string `json:"version"`
}

// TypeContext represents an @type declaration and its scope
type TypeContext struct {
	Type      string `json:"type"`
	Version   string `json:"version"`
	Line      int    `json:"line"`
	Column    int    `json:"column"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
}

// ParseResult contains all the information we need for parameter validation
type ParseResult struct {
	Parameters []ParameterInfo `json:"parameters"`
	Contexts   []TypeContext   `json:"contexts"`
}

func main() {
	// Read CUE content from stdin
	content, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading from stdin: %v\n", err)
		os.Exit(1)
	}
	
	// Parse the CUE content from memory
	f, err := parser.ParseFile("stdin", content, parser.ParseComments)
	
	if err != nil {
		// Don't exit on syntax errors - try to extract what we can from partial AST
		fmt.Fprintf(os.Stderr, "Warning: CUE syntax errors detected, continuing with partial parsing: %v\n", err)
		
		// If parsing failed completely (f is nil), we can't proceed
		if f == nil {
			fmt.Fprintf(os.Stderr, "Error: Complete parsing failure, no AST available\n")
			os.Exit(1)
		}
	}

	// Extract information from the AST
	result := extractInfo(f)

	// Output as JSON
	output, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling JSON: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(string(output))
}

// extractInfo walks the AST and extracts @type contexts and parameters
func extractInfo(f *ast.File) ParseResult {
	var result ParseResult
	
	// Collect all struct literals with @type
	var typeContexts []TypeContext
	var structsWithTypes []*ast.StructLit
	
	// Walk the AST to find @type contexts - now all contexts are struct literals
	ast.Walk(f, func(node ast.Node) bool {
		// Skip nil nodes that might occur in malformed AST
		if node == nil {
			return false
		}
		
		switch n := node.(type) {
		case *ast.StructLit:
			// Skip if struct literal is malformed
			if n == nil || n.Elts == nil {
				return false
			}
			
			// Look for @type declarations in struct literals
			typeInfo := findTypeInStruct(n)
			if typeInfo != nil {
				typeContexts = append(typeContexts, *typeInfo)
				structsWithTypes = append(structsWithTypes, n)
			}
		}
		return true
	}, nil)
	
	// Extract parameters from each struct - parameters belong to their immediate struct
	for i, structLit := range structsWithTypes {
		contextInfo := typeContexts[i]
		params := extractParametersFromStruct(structLit, contextInfo.Type, contextInfo.Version)
		result.Parameters = append(result.Parameters, params...)
	}
	
	result.Contexts = typeContexts
	return result
}

// findTypeInStruct looks for @type field in a struct literal
func findTypeInStruct(structLit *ast.StructLit) *TypeContext {
	var typeValue, versionValue string
	var typeLine, typeColumn int

	for _, elt := range structLit.Elts {
		if field, ok := elt.(*ast.Field); ok {
			if label, ok := field.Label.(*ast.BasicLit); ok {
				if label.Value == `"@type"` {
					if basicValue, ok := field.Value.(*ast.BasicLit); ok {
						typeValue = basicValue.Value
						// Remove quotes
						if len(typeValue) >= 2 && typeValue[0] == '"' && typeValue[len(typeValue)-1] == '"' {
							typeValue = typeValue[1 : len(typeValue)-1]
						}
						pos := label.Pos()
						typeLine = int(pos.Line())
						typeColumn = int(pos.Column())
					}
				} else if label.Value == `"@version"` {
					if basicValue, ok := field.Value.(*ast.BasicLit); ok {
						versionValue = basicValue.Value
						// Remove quotes
						if len(versionValue) >= 2 && versionValue[0] == '"' && versionValue[len(versionValue)-1] == '"' {
							versionValue = versionValue[1 : len(versionValue)-1]
						}
					}
				}
			}
		}
	}

	if typeValue != "" {
		if versionValue == "" {
			versionValue = "0.0.0" // Default version
		}
		
		// Calculate struct boundaries
		startPos := structLit.Pos()
		endPos := structLit.End()
		
		return &TypeContext{
			Type:      typeValue,
			Version:   versionValue,
			Line:      typeLine,
			Column:    typeColumn,
			StartLine: int(startPos.Line()),
			EndLine:   int(endPos.Line()),
		}
	}

	return nil
}

// extractParametersFromStruct extracts parameter fields from a struct that belong directly to this struct
func extractParametersFromStruct(structLit *ast.StructLit, contextType, contextVersion string) []ParameterInfo {
	var params []ParameterInfo

	// Defensive check
	if structLit == nil || structLit.Elts == nil {
		return params
	}

	for _, elt := range structLit.Elts {
		// Skip nil elements that might occur in malformed AST
		if elt == nil {
			continue
		}
		
		if field, ok := elt.(*ast.Field); ok && field != nil && field.Label != nil {
			var paramName string
			var pos token.Pos
			
			// Handle different types of field labels
			switch label := field.Label.(type) {
			case *ast.BasicLit:
				if label == nil {
					continue
				}
				paramName = label.Value
				pos = label.Pos()
				// Remove quotes if present
				if len(paramName) >= 2 && paramName[0] == '"' && paramName[len(paramName)-1] == '"' {
					paramName = paramName[1 : len(paramName)-1]
				}
			case *ast.Ident:
				if label == nil {
					continue
				}
				paramName = label.Name
				pos = label.Pos()
			default:
				continue
			}

			// Skip CUE special fields, but allow @mode
			if paramName == "@type" || paramName == "@version" {
				continue
			}
			if len(paramName) > 0 && (paramName[0] == '_' || paramName[0] == '#') {
				continue
			}

			// Skip non-parameter fields
			if !isValidParameterName(paramName) {
				fmt.Fprintf(os.Stderr, "Skipping invalid parameter name: %s\n", paramName)
				continue
			}
			
			// All parameters in this struct belong to this context
			// This is the correct approach - structural relationship, not positional
			

			params = append(params, ParameterInfo{
				Name:    paramName,
				Line:    int(pos.Line()),
				Column:  int(pos.Column()),
				Context: contextType,
				Version: contextVersion,
			})
		}
	}

	return params
}

// findCorrectContextForParameter determines which context a parameter should belong to
// based on its position relative to @type declarations
func findCorrectContextForParameter(paramPos token.Pos, defaultContext string, allContexts []TypeContext) string {
	paramLine := int(paramPos.Line())
	paramColumn := int(paramPos.Column())
	
	// A parameter belongs to a context only if:
	// 1. The parameter appears AFTER the @type declaration (either on a later line, or same line but after the @type)
	// 2. The parameter is within the context's line boundaries
	
	// Check all contexts to see if this parameter should belong to any of them
	for _, context := range allContexts {
		// Skip if parameter is outside this context's boundaries
		if paramLine < context.StartLine || paramLine > context.EndLine {
			continue
		}
		
		// If parameter is on the same line as @type, check column position
		if paramLine == context.Line {
			// Parameter must come AFTER the @type declaration to belong to this context
			if paramColumn > context.Column {
				return context.Type
			}
			// If parameter comes before @type on same line, it belongs to outer context
			continue
		}
		
		// If parameter is on a line after @type, it could belong to this context
		// But we need to check if it's the most immediate parent
		if paramLine > context.Line {
			// This is a potential match, but we need to find the most immediate parent
			// Continue checking to find the most specific context
		}
	}
	
	// If no specific context claimed this parameter, it belongs to the default context
	return defaultContext
}

// hasTypeField checks if a struct literal contains an @type field
func hasTypeField(structLit *ast.StructLit) bool {
	if structLit == nil || structLit.Elts == nil {
		return false
	}
	
	for _, elt := range structLit.Elts {
		if field, ok := elt.(*ast.Field); ok && field.Label != nil {
			if label, ok := field.Label.(*ast.BasicLit); ok {
				if label.Value == `"@type"` {
					return true
				}
			}
		}
	}
	
	return false
}

// isValidParameterName checks if a name follows zetta_utils parameter naming rules
func isValidParameterName(name string) bool {
	if len(name) == 0 {
		return false
	}
	
	// Allow @mode as special case
	if name == "@mode" {
		return true
	}
	
	// Must start with letter or underscore (but we exclude _ fields elsewhere)
	first := name[0]
	if !((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first == '_') {
		return false
	}
	
	// Rest must be alphanumeric or underscore
	for i := 1; i < len(name); i++ {
		c := name[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	
	return true
}