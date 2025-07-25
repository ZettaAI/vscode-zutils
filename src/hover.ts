/**
 * Hover information providers
 */

import { Position, Hover, MarkupKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import {
    ExtensionBuilderInfo,
    ParameterInfo
} from './types';
import {
    getTypeAtPosition,
    getParameterNameAtPosition,
    findBuilderForValidation
} from './parser';
import {
    extensionBuilders,
    stripVersionSuffix,
    isMetadataLoaded
} from './metadata';

/**
 * Resolves file paths to proper URIs for VSCode links
 */
function resolveFilePathToUri(filePath: string): string | null {
    try {
        if (!filePath) return null;

        // Convert to URI format that VSCode can open
        const uri = URI.file(filePath);
        return uri.toString();
    } catch (error) {
        console.error(`Failed to resolve file path to URI: ${filePath}`, error);
        return null;
    }
}

/**
 * Creates hover information for a parameter
 */
export function createParameterHover(
    parameterName: string,
    contextBuilderName: string,
    builder: ExtensionBuilderInfo,
    parameter: ParameterInfo
): Hover {
    const paramDoc = builder.metadata.documentation.parameters?.[parameterName];

    let hoverText = `**${parameterName}** (${contextBuilderName})\n\n`;

    // Add clickable link to builder source code if available
    if (builder.metadata?.file) {
        const fileUri = resolveFilePathToUri(builder.metadata.file);
        if (fileUri) {
            hoverText += `[View source (line ${builder.metadata.line_number})](${fileUri}#${builder.metadata.line_number})\n\n`;
        }
    }

    hoverText += `**Type**: \`${parameter.type}\`\n\n`;

    if (paramDoc && paramDoc.trim()) {
        hoverText += paramDoc;
    } else {
        hoverText += `*No documentation available for this parameter.*`;
    }

    if (parameter.default !== null && parameter.default !== undefined) {
        hoverText += `\n\n**Default**: \`${parameter.default}\``;
    }

    if (parameter.required) {
        hoverText += `\n\n*Required parameter*`;
    } else {
        hoverText += `\n\n*Optional parameter*`;
    }

    return {
        contents: {
            kind: MarkupKind.Markdown,
            value: hoverText
        }
    };
}

/**
 * Creates hover information for a builder
 */
export function createBuilderHover(builderName: string, builder: ExtensionBuilderInfo): Hover {
    let hoverText = `**${builderName}**\n\n`;

    // Add clickable link to source code if file is available
    if (builder.metadata?.file) {
        const fileUri = resolveFilePathToUri(builder.metadata.file);
        if (fileUri) {
            hoverText += `[View source (line ${builder.metadata.line_number})](${fileUri}#${builder.metadata.line_number})\n\n`;
        }
    }

    // Add function name and module
    hoverText += `**Function**: \`${builder.metadata.function_name}\`\n\n`;
    hoverText += `**Module**: \`${builder.metadata.module}\`\n\n`;

    // Add documentation summary
    if (builder.metadata.documentation.summary) {
        hoverText += `${builder.metadata.documentation.summary}\n\n`;
    }

    // Add parameter summary
    const requiredParams = builder.parameters.filter(p => p.required);
    const optionalParams = builder.parameters.filter(p => !p.required);

    if (requiredParams.length > 0) {
        hoverText += `**Required Parameters**: ${requiredParams.length}\n`;
        hoverText += requiredParams.map(p => `- \`${p.name}\`: ${p.type}`).join('\n');
        hoverText += '\n\n';
    }

    if (optionalParams.length > 0) {
        hoverText += `**Optional Parameters**: ${optionalParams.length}\n`;
        // Show first few optional parameters
        const displayParams = optionalParams.slice(0, 5);
        hoverText += displayParams.map(p => `- \`${p.name}\`: ${p.type}`).join('\n');
        if (optionalParams.length > 5) {
            hoverText += `\n- *... and ${optionalParams.length - 5} more*`;
        }
    }

    return {
        contents: {
            kind: MarkupKind.Markdown,
            value: hoverText
        }
    };
}

/**
 * Main hover provider
 */
export async function provideHover(document: TextDocument, position: Position): Promise<Hover | null> {
    if (!isMetadataLoaded || extensionBuilders.length === 0) {
        return null;
    }

    // Get the builder context for this position
    const builderResult = await findBuilderForValidation(document, position);
    if (builderResult) {
        const { builder, builderName } = builderResult;

        // Check if hovering over a builder name in @type field
        const typeAtPosition = await getTypeAtPosition(document, position);
        if (typeAtPosition) {
            return createBuilderHover(builderName, builder);
        }

        // Check if hovering over a parameter name
        const hoveredParameterName = await getParameterNameAtPosition(document, position);
        if (hoveredParameterName) {
            const parameter = builder.parameters.find(p => p.name === hoveredParameterName);
            if (parameter) {
                return createParameterHover(hoveredParameterName, stripVersionSuffix(builder.name), builder, parameter);
            }
        }
    }

    return null;
}