/**
 * Go CUE parser integration
 */

import * as path from 'path';
import { spawn } from 'child_process';
import { Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    CueParseResult,
    BuilderValidationResult,
    TypeFieldInfo
} from './types';
import { extensionBuilders, builderLookup, resolveBuilder, stripVersionSuffix, defaultVersion } from './metadata';

// Cache for parser results
const parserCache = new Map<string, { result: CueParseResult | null, timestamp: number }>();
const CACHE_TTL = 2000; // 2 seconds cache TTL

/**
 * Calls the Go CUE parser to analyze the document
 */
export async function callGoCueParser(document: TextDocument): Promise<CueParseResult | null> {
    const content = document.getText();
    const cacheKey = `${document.uri}:${content.length}:${content.substring(0, 100)}`;

    // Check cache first
    const cached = parserCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.result;
    }
    return new Promise((resolve) => {
        try {
            const parserPath = path.join(__dirname, '..', 'scripts', 'cue-parser', 'cue-parser');
            const child = spawn(parserPath, [], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                let result: CueParseResult | null = null;
                if (code === 0) {
                    try {
                        const rawResult = JSON.parse(stdout);

                        // Adjust line numbers if we added a fake wrapper
                        if (lineOffset > 0 && rawResult) {
                            result = {
                                parameters: rawResult.parameters?.map((param: any) => ({
                                    ...param,
                                    line: param.line - lineOffset
                                })) || [],
                                contexts: rawResult.contexts?.map((ctx: any) => ({
                                    ...ctx,
                                    line: ctx.line - lineOffset,
                                    start_line: ctx.start_line - lineOffset,
                                    end_line: ctx.end_line - lineOffset
                                })) || []
                            };
                        } else {
                            result = rawResult;
                        }
                    } catch (parseError) {
                        console.error(`Failed to parse Go parser output: ${parseError}`);
                    }
                } else {
                    console.error(`Go parser exited with code ${code}. stderr: ${stderr}`);
                }

                // Cache the result
                parserCache.set(cacheKey, { result, timestamp: Date.now() });

                // Clean up old cache entries
                if (parserCache.size > 100) {
                    const now = Date.now();
                    for (const [key, value] of parserCache.entries()) {
                        if (now - value.timestamp > CACHE_TTL * 2) {
                            parserCache.delete(key);
                        }
                    }
                }

                resolve(result);
            });

            child.on('error', (error) => {
                console.error(`Go parser spawn error: ${error}`);
                resolve(null);
            });

            // Wrap the content in a fake struct if it doesn't start with {
            let content = document.getText().trim();
            let lineOffset = 0;

            if (!content.startsWith('{')) {
                // Add fake wrapper struct for consistent parsing
                content = `{\n${content}\n}`;
                lineOffset = 1; // Account for the added opening brace line
            }

            // Send wrapped content to stdin and close it
            child.stdin.write(content);
            child.stdin.end();

            // Add timeout
            const timeoutId = setTimeout(() => {
                if (!child.killed) {
                    child.kill();
                    console.error('Go parser timed out');
                    // Cache timeout result to avoid repeated calls
                    parserCache.set(cacheKey, { result: null, timestamp: Date.now() });
                    resolve(null);
                }
            }, 3000); // Reduced to 3 seconds

            // Clear timeout when process completes
            child.on('close', () => {
                clearTimeout(timeoutId);
            });

        } catch (error) {
            console.error(`Go parser error: ${error}`);
            resolve(null);
        }
    });
}

/**
 * Finds the builder context for validation at a given position
 */
export async function findBuilderForValidation(document: TextDocument, position: Position): Promise<BuilderValidationResult | null> {
    try {
        const parseResult = await callGoCueParser(document);
        if (!parseResult) {
            return null;
        }

        const targetLine = position.line + 1; // Go parser uses 1-based line numbers

        // First, check if there's a parameter at this exact line and use its context
        const parameterAtLine = parseResult.parameters.find(param => param.line === targetLine);
        let containingContext = null;

        if (parameterAtLine) {
            // Use the context that this parameter was assigned to by the Go parser
            // Match both type and version to handle multiple builders of the same type
            containingContext = parseResult.contexts.find(ctx => 
                ctx.type === parameterAtLine.context && ctx.version === parameterAtLine.version);
        } else {
            // Fall back to finding context by line boundaries
            const containingContexts = parseResult.contexts.filter(context =>
                targetLine >= context.start_line && targetLine <= context.end_line
            );

            // Use the most specific context that contains this line
            containingContext = containingContexts.sort((a, b) => {
                const sizeA = (a.end_line - a.start_line);
                const sizeB = (b.end_line - b.start_line);
                return sizeA - sizeB;
            })[0];
        }

        if (containingContext && containingContext.type) {
            const builderName = containingContext.type;
            const version = containingContext.version || defaultVersion;

            // Use shared builder resolution logic
            const builder = resolveBuilder(builderName, version);
            if (builder) {
                return {
                    builder: builder,
                    builderName: builderName
                };
            }
        }

        return null;
    } catch (error) {
        console.error(`Error in findBuilderForValidation: ${error}`);
        return null;
    }
}

/**
 * Gets the @type value at a specific position using Go parser
 * Only returns a value if hovering over the actual @type field text
 */
export async function getTypeAtPosition(document: TextDocument, position: { line: number; character: number }): Promise<string | null> {
    try {
        const parseResult = await callGoCueParser(document);
        if (!parseResult) {
            return null;
        }

        const targetLine = position.line + 1; // Go parser uses 1-based line numbers

        // Check if we're actually hovering over a @type field by examining the line text
        const lineText = document.getText({
            start: { line: position.line, character: 0 },
            end: { line: position.line + 1, character: 0 }
        });

        // Check if this line contains @type and if we're positioned over it
        const typeMatch = lineText.match(/"@type":\s*"([^"]+)"/);
        if (typeMatch) {
            const typeStart = lineText.indexOf('"@type"');
            const typeEnd = typeStart + '"@type"'.length;
            const valueStart = lineText.indexOf(typeMatch[1]);
            const valueEnd = valueStart + typeMatch[1].length;

            // Check if cursor is positioned over either "@type" key or its value
            if ((position.character >= typeStart && position.character <= typeEnd) ||
                (position.character >= valueStart && position.character <= valueEnd)) {
                return typeMatch[1];
            }
        }

        return null;
    } catch (error) {
        console.error(`Error in getTypeAtPosition: ${error}`);
        return null;
    }
}

/**
 * Gets the parameter name at a specific position using Go parser
 */
export async function getParameterNameAtPosition(document: TextDocument, position: Position): Promise<string | null> {
    try {
        const parseResult = await callGoCueParser(document);
        if (!parseResult) {
            return null;
        }

        const targetLine = position.line + 1; // Go parser uses 1-based line numbers
        const targetColumn = position.character + 1; // Go parser uses 1-based column numbers

        // Find parameter where cursor is within the parameter name range
        const parameter = parseResult.parameters.find(param => {
            if (param.line !== targetLine) {
                return false;
            }

            // Check if cursor is within parameter name boundaries
            // param.column is 1-based start position of parameter name
            const paramStart = param.column;
            const paramEnd = param.column + param.name.length;

            return targetColumn >= paramStart && targetColumn <= paramEnd;
        });

        return parameter ? parameter.name : null;
    } catch (error) {
        console.error(`Error in getParameterNameAtPosition: ${error}`);
        return null;
    }
}

/**
 * Extracts information about @type field context for completions
 */
export async function extractTypeFieldInfo(document: TextDocument, position: Position): Promise<TypeFieldInfo> {
    try {
        const parseResult = await callGoCueParser(document);
        if (!parseResult) {
            return { isInTypeField: false, partialName: '', isAtTypePosition: false };
        }

        const targetLine = position.line + 1; // Go parser uses 1-based line numbers

        // Check if we're in a context with a type
        const containingContext = parseResult.contexts.find(context =>
            targetLine >= context.start_line && targetLine <= context.end_line
        );

        // Also check if we're directly on a @type line
        const lineText = document.getText({
            start: { line: position.line, character: 0 },
            end: { line: position.line + 1, character: 0 }
        });

        const isAtTypePosition = lineText.includes('"@type"');

        if (isAtTypePosition) {
            // Extract partial builder name being typed
            let partialName = '';
            const typeMatch = lineText.match(/"@type":\s*"([^"]*)$/);
            if (typeMatch) {
                partialName = typeMatch[1];
            }

            return {
                isInTypeField: true,
                partialName: partialName,
                isAtTypePosition: true
            };
        }

        return { isInTypeField: false, partialName: '', isAtTypePosition: false };

    } catch (error) {
        console.error(`Error in extractTypeFieldInfo: ${error}`);
        return { isInTypeField: false, partialName: '', isAtTypePosition: false };
    }
}