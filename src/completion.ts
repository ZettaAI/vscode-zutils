/**
 * Code completion providers
 */

import {
    Position,
    CompletionItem,
    CompletionItemKind,
    MarkupKind,
    TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    CurrentWordInfo,
    ExtensionBuilderInfo
} from './types';
import {
    extractTypeFieldInfo,
    findBuilderForValidation
} from './parser';
import {
    extensionBuilders,
    stripVersionSuffix,
    isMetadataLoaded
} from './metadata';
import * as semver from 'semver';
import {
    generateCuePlaceholder,
    getRequiredParametersList
} from './type-system';

/**
 * Checks if completion can be provided
 */
export function canProvideCompletion(): boolean {
    // Always allow @ field completions even without metadata
    return true;
}

/**
 * Extracts exact version from version_spec using semver (e.g., ">=0.4" -> "0.4.0", "<=0.3" -> "0.3.0")
 */
function extractExactVersion(versionSpec: string): string {
    if (!versionSpec || versionSpec === ">=0.0") {
        return "";
    }

    try {
        // Use semver to parse and extract the version
        const coerced = semver.coerce(versionSpec);
        if (coerced) {
            return coerced.version;
        }
        return "";
    } catch (error) {
        console.warn(`Failed to parse version spec: ${versionSpec}`);
        return "";
    }
}

/**
 * Generates builder template with parameters
 */
export function generateBuilderTemplate(builder: ExtensionBuilderInfo): string {

    let template = `{\n\t"@type": "${stripVersionSuffix(builder.name)}"`;

    // Add @version if builder has version constraints (use exact version)
    if (builder.version_spec && builder.version_spec !== ">=0.0") {
        const exactVersion = extractExactVersion(builder.version_spec);
        if (exactVersion) {
            template += `,\n\t"@version": "${exactVersion}"`;
        }
    }

    const requiredParams = builder.parameters.filter(p => p.required);
    const optionalParams = builder.parameters.filter(p => !p.required);

    // Add comment and required parameters
    if (requiredParams.length > 0) {
        template += `,\n\n\t// Required parameters`;
        for (const param of requiredParams) {
            const placeholder = generateCuePlaceholder(param, 1, false);
            template += `,\n\t${param.name}: ${placeholder}`;
        }
    }

    // Add comment and ALL optional parameters
    if (optionalParams.length > 0) {
        template += `,\n\n\t// Optional parameters`;
        for (const param of optionalParams) {
            const placeholder = generateCuePlaceholder(param, 1, true);
            template += `,\n\t${param.name}?: ${placeholder}`;
        }
    }

    template += '\n}';
    return template;
}

/**
 * Provides @ field completions (like @type, @version, @mode)
 */
export async function getAtFieldCompletions(document: TextDocument, position: Position): Promise<CompletionItem[] | null> {
    try {
        // Check if we're at a position where @ field completion makes sense
        const lineText = document.getText({
            start: { line: position.line, character: 0 },
            end: position
        });

        // Simple check for @ field context - if we see the pattern for starting an @ field
        const atFieldMatch = lineText.match(/^[^"]*"(@[a-zA-Z_]*)$/);
        if (atFieldMatch) {
            const partialAtField = atFieldMatch[1];
            console.log(`🔧 Completing @ field: "${partialAtField}"`);

            // Provide zetta_utils specific @ field completions + @mode
            const atFieldCompletions = ['@type', '@version', '@mode'].filter(field =>
                field.startsWith(partialAtField)
            );

            return atFieldCompletions.map(field => ({
                label: field,
                kind: CompletionItemKind.Property,
                data: field,
                detail: field === '@type' ? 'Builder type specification' :
                    field === '@version' ? 'Version specification' :
                        'Mode specification (partial/regular)',
                insertText: field,
                insertTextFormat: 1,
                sortText: '0' + field
            }));
        }

        return null;
    } catch (error) {
        console.error(`Error in getAtFieldCompletions: ${error}`);
        return null;
    }
}

/**
 * Extracts current word information for completion context
 */
export async function extractCurrentWord(document: TextDocument, position: Position): Promise<CurrentWordInfo> {
    try {
        // Get text up to cursor position
        const lineStart = document.getText({
            start: { line: position.line, character: 0 },
            end: position
        });

        // Check if we're typing a partial word that could be a builder (but NOT @ fields)
        // Include qualified names like np.can_cast and handle leading quotes
        // When VSCode auto-completes quotes, user types inside: "subch|" (cursor between text and closing quote)
        const wordAtCursor = lineStart.match(/("?)([a-zA-Z_][a-zA-Z0-9_.]*)$/);
        const currentWord = wordAtCursor ? wordAtCursor[2] : '';
        const hasLeadingQuote = wordAtCursor ? wordAtCursor[1] === '"' : false;

        // Also check if we're inside quotes by looking at the full line context
        const fullLine = document.getText({
            start: { line: position.line, character: 0 },
            end: {
                line: position.line, character: position.line === document.lineCount - 1 ?
                    document.getText().split('\n')[position.line].length :
                    document.getText().split('\n')[position.line].length
            }
        });
        const beforeCursor = fullLine.substring(0, position.character);
        const afterCursor = fullLine.substring(position.character);

        // Check if we're typing inside auto-completed quotes: "subch|"
        const insideQuotesMatch = beforeCursor.match(/.*"([a-zA-Z_][a-zA-Z0-9_.]*)$/);
        const hasTrailingQuote = afterCursor.startsWith('"');

        // Use the inside-quotes match if we're in that situation
        const finalCurrentWord = insideQuotesMatch && hasTrailingQuote ? insideQuotesMatch[1] : currentWord;
        const finalHasLeadingQuote = insideQuotesMatch && hasTrailingQuote ? true : hasLeadingQuote;

        return {
            currentWord,
            hasLeadingQuote,
            finalCurrentWord,
            finalHasLeadingQuote,
            hasTrailingQuote
        };
    } catch (error) {
        console.error(`Error in extractCurrentWord: ${error}`);
        // Return safe defaults
        return {
            currentWord: '',
            hasLeadingQuote: false,
            finalCurrentWord: '',
            finalHasLeadingQuote: false,
            hasTrailingQuote: false
        };
    }
}

/**
 * Creates builder completion items
 */
export function createBuilderCompletions(
    searchTerm: string,
    isInTypeField: boolean,
    position: Position,
    partialName: string,
    wordInfo: CurrentWordInfo
): CompletionItem[] {
    console.log(`Providing builder completions for: "${searchTerm}" (inTypeField: ${isInTypeField})`);

    // Filter builders based on partial input (only if builders are available)
    if (extensionBuilders.length === 0) {
        console.log('No builders available - metadata not loaded');
        return [];
    }

    const matchingBuilders = extensionBuilders.filter(builder => {
        if (searchTerm.length === 0) {
            return true;
        }
        return builder.name.toLowerCase().startsWith(searchTerm.toLowerCase()) ||
            builder.name.toLowerCase().includes(searchTerm.toLowerCase());
    });

    const results = matchingBuilders.slice(0, 50).map(builder => { // Limit to 50 results
        const builderName = builder.name;

        // Boost priority for exact prefix matches, especially build_ builders
        let priority = '2'; // Default priority
        if (builderName.toLowerCase().startsWith(partialName.toLowerCase())) {
            priority = '1'; // Higher priority for prefix matches
        }

        // Determine what type of completion to provide
        if (isInTypeField) {
            // In @type field - provide simple text completion
            const textCompletion: CompletionItem = {
                label: builderName,
                kind: CompletionItemKind.Value,
                data: builderName,
                detail: `${builder.metadata.function_name}`,
                documentation: {
                    kind: MarkupKind.Markdown,
                    value: `**${builderName}**\\n\\n${builder.metadata.documentation.summary}\\n\\nModule: \`${builder.metadata.module}\``
                },
                insertText: stripVersionSuffix(builderName),
                insertTextFormat: 1, // Plain text
                filterText: wordInfo.finalCurrentWord, // Use what user typed for filtering
                sortText: priority + builderName,
                // Replace only the typed word, use additionalTextEdits to remove quotes
                textEdit: wordInfo.finalCurrentWord ? {
                    range: {
                        start: { line: position.line, character: position.character - wordInfo.finalCurrentWord.length },
                        end: { line: position.line, character: position.character }
                    },
                    newText: builderName
                } as TextEdit : undefined,

                // Remove surrounding quotes if we're inside quotes
                additionalTextEdits: (wordInfo.finalHasLeadingQuote && wordInfo.hasTrailingQuote) ? [
                    {
                        range: {
                            start: { line: position.line, character: position.character - wordInfo.finalCurrentWord.length - 1 },
                            end: { line: position.line, character: position.character - wordInfo.finalCurrentWord.length }
                        },
                        newText: ""
                    },
                    {
                        range: {
                            start: { line: position.line, character: position.character },
                            end: { line: position.line, character: position.character + 1 }
                        },
                        newText: ""
                    }
                ] : []
            };

            return textCompletion;
        } else {
            // Outside @type field - provide full template with required parameters
            const template = generateBuilderTemplate(builder);

            const templateCompletion: CompletionItem = {
                label: builderName,
                kind: CompletionItemKind.Snippet,
                data: builderName,
                detail: `${builder.metadata.function_name} (Template)`,
                documentation: {
                    kind: MarkupKind.Markdown,
                    value: `**${builderName}** (Full Template)\\n\\n${builder.metadata.documentation.summary}\\n\\nRequired: ${getRequiredParametersList(builder)}\\n\\nModule: \`${builder.metadata.module}\``
                },
                insertText: template,
                insertTextFormat: 1, // Plain text format
                filterText: wordInfo.finalCurrentWord,
                sortText: priority + builderName,
                // Replace only the typed word
                textEdit: wordInfo.finalCurrentWord ? {
                    range: {
                        start: { line: position.line, character: position.character - wordInfo.finalCurrentWord.length },
                        end: { line: position.line, character: position.character }
                    },
                    newText: template
                } as TextEdit : undefined
            };

            return templateCompletion;
        }
    });

    console.log(`Returning ${results.length} builder completions`);
    return results;
}

/**
 * Provides parameter completions for the current builder context
 */
export async function getParameterCompletions(document: TextDocument, position: Position): Promise<CompletionItem[]> {
    // Check if we're completing parameters for a known builder
    const builderResult = await findBuilderForValidation(document, position);
    if (builderResult) {
        const { builder, builderName } = builderResult;
        const parameters = builder.parameters;

        return parameters.map(param => {
            const paramName = param.name;
            const completion: CompletionItem = {
                label: paramName,
                kind: CompletionItemKind.Property,
                data: `${builderName}.${paramName}`,
                detail: param.type,
                documentation: {
                    kind: MarkupKind.Markdown,
                    value: `**${paramName}**: ${param.type}\\n\\n${param.required ? 'Required' : 'Optional'}${param.default !== null ? ` (default: ${param.default})` : ''}`
                },
                insertText: `${paramName}: `
            };

            return completion;
        });
    }
    return [];
}

/**
 * Main completion handler
 */
export async function provideCompletions(document: TextDocument, position: Position): Promise<CompletionItem[]> {
    if (!canProvideCompletion() || !isMetadataLoaded) {
        return [];
    }

    const typeFieldInfo = await extractTypeFieldInfo(document, position);
    console.log(`Line: completion requested, isInTypeField: ${typeFieldInfo.isInTypeField}, partialName: "${typeFieldInfo.partialName}"`);

    // Check for @ field completions first
    const atFieldCompletions = await getAtFieldCompletions(document, position);
    if (atFieldCompletions) {
        return atFieldCompletions;
    }

    const wordInfo = await extractCurrentWord(document, position);

    // Provide builder completions in two cases:
    // 1. Inside @type field (use partialName from quotes)
    // 2. Outside @type field but typing a word that could match builder names (avoid numpy pollution)
    const searchTerm = typeFieldInfo.isInTypeField ? typeFieldInfo.partialName : wordInfo.finalCurrentWord;
    const shouldProvideBuilders = typeFieldInfo.isInTypeField ?
        (searchTerm || searchTerm === '') :  // @type field: always show builders
        (searchTerm.length >= 1 &&
            extensionBuilders.some(b =>
                b.name.toLowerCase().includes(searchTerm.toLowerCase())
            )); // Outside: show if any builder contains the search term

    if (shouldProvideBuilders) {
        return createBuilderCompletions(
            searchTerm,
            typeFieldInfo.isInTypeField,
            position,
            typeFieldInfo.partialName,
            wordInfo
        );
    }

    // Check for parameter completions
    const parameterCompletions = await getParameterCompletions(document, position);
    if (parameterCompletions.length > 0) {
        return parameterCompletions;
    }

    return [];
}