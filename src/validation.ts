/**
 * Parameter validation and diagnostics
 */

import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { callGoCueParser } from './parser';
import { extensionBuilders, builderLookup, stripVersionSuffix, isMetadataLoaded, resolveBuilder } from './metadata';

/**
 * Calculates Levenshtein distance between two strings for fuzzy matching
 */
function levenshteinDistance(a: string, b: string): number {
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));

    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1,     // deletion
                matrix[j - 1][i] + 1,     // insertion
                matrix[j - 1][i - 1] + indicator  // substitution
            );
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Validates parameters in a CUE document using Go parser results
 */
export async function validateParameters(textDocument: TextDocument, diagnostics: Diagnostic[]): Promise<void> {
    // Don't validate if metadata isn't loaded yet
    if (!isMetadataLoaded) {
        return;
    }

    try {
        const parseResult = await callGoCueParser(textDocument);
        if (!parseResult || !parseResult.parameters) {
            return;
        }

        for (const param of parseResult.parameters) {
            // Skip special CUE/zetta_utils system fields
            if (param.name === '@type' || param.name === '@version' || param.name === '@mode') {
                continue;
            }

            // Find the builder for this parameter's context
            const builder = resolveBuilder(param.context, param.version);

            if (!builder) {
                continue;
            }

            const builderParam = builder.parameters.find(p => p.name === param.name);

            if (!builderParam) {
                // Parameter not found in builder definition
                const range: Range = {
                    start: { line: param.line - 1, character: param.column - 1 },
                    end: { line: param.line - 1, character: param.column + param.name.length - 1 }
                };

                let message = `Unknown parameter '${param.name}' for builder '${stripVersionSuffix(param.context)}'`;

                // Suggest similar parameter names
                const suggestions = builder.parameters
                    .map(p => ({ name: p.name, distance: levenshteinDistance(param.name.toLowerCase(), p.name.toLowerCase()) }))
                    .filter(s => s.distance <= 2)
                    .sort((a, b) => a.distance - b.distance)
                    .slice(0, 3)
                    .map(s => s.name);

                if (suggestions.length > 0) {
                    message += `. Did you mean: ${suggestions.join(', ')}?`;
                }

                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: range,
                    message: message,
                    source: 'zetta-utils-cue'
                });
            }
        }

        // Validate @type values
        for (const context of parseResult.contexts) {
            if (context.type) {
                const builderExists = builderLookup[context.type] ||
                    extensionBuilders.some(b => stripVersionSuffix(b.name) === context.type);

                if (!builderExists) {
                    // Find the line and highlight the builder name
                    const lines = textDocument.getText().split('\n');
                    const contextLine = lines[context.line - 1];

                    if (contextLine) {
                        // Find the builder name within quotes after @type
                        const builderNameMatch = contextLine.match(/"@type":\s*"([^"]+)"/);
                        if (builderNameMatch) {
                            const builderNameStart = contextLine.indexOf(builderNameMatch[1]);
                            const startPos = { line: context.line - 1, character: builderNameStart };
                            const endPos = { line: context.line - 1, character: builderNameStart + context.type.length };

                            let message = `Unknown builder type '${context.type}'`;

                            // Suggest similar builder names
                            const suggestions = extensionBuilders
                                .map(b => ({ name: stripVersionSuffix(b.name), distance: levenshteinDistance(context.type.toLowerCase(), stripVersionSuffix(b.name).toLowerCase()) }))
                                .filter(s => s.distance <= 3)
                                .sort((a, b) => a.distance - b.distance)
                                .slice(0, 3)
                                .map(s => s.name);

                            if (suggestions.length > 0) {
                                message += `. Did you mean: ${suggestions.join(', ')}?`;
                            }

                            diagnostics.push({
                                severity: DiagnosticSeverity.Error,
                                range: { start: startPos, end: endPos },
                                message: message,
                                source: 'zetta-utils-cue'
                            });
                        }
                    }
                }
            }
        }

    } catch (error) {
        console.error(`Error in validateParameters: ${error}`);
    }
}

/**
 * Main validation function for CUE documents
 */
export async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    const diagnostics: Diagnostic[] = [];

    try {
        // Only validate .cue files
        if (!textDocument.uri.endsWith('.cue')) {
            return;
        }

        console.log(`Validating document: ${textDocument.uri}`);

        // Validate parameters using Go parser
        await validateParameters(textDocument, diagnostics);

    } catch (error) {
        console.error(`Validation error for ${textDocument.uri}: ${error}`);
    }

    // Send diagnostics to client (this would need to be injected or imported)
    // For now, this is a placeholder - the actual connection would be passed in
    console.log(`Generated ${diagnostics.length} diagnostics for ${textDocument.uri}`);
}