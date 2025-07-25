/**
 * Shared types and interfaces for the Zetta Utils CUE VSCode extension
 */

import {
    Position,
    CompletionItem,
    Diagnostic,
    Hover
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

// === Core Data Structures ===

export interface BuilderMetadata {
    builders: ExtensionBuilderInfo[];
    default_version: string;
}

export interface ExtensionBuilderInfo {
    name: string;
    version_spec: string | null;
    parameters: ParameterInfo[];
    metadata: {
        file: string;
        line_number: number;
        function_name: string;
        module: string;
        documentation: {
            summary: string;
            parameters?: { [key: string]: string };
        };
    };
}

export interface TypeInfo {
    type_string: string;
    is_sequence: boolean;
    is_optional: boolean;
    inner_type?: string;
    literals: (string | number | boolean)[];
}

export interface ParameterInfo {
    name: string;
    type: string;
    required: boolean;
    default: any;
}

export interface BuilderLookup {
    [key: string]: ExtensionBuilderInfo;
}

export interface BuilderValidationResult {
    builder: ExtensionBuilderInfo;
    builderName: string;
}

// === Go Parser Integration ===

export interface CueParameterInfo {
    name: string;
    line: number;
    column: number;
    context: string;
    version: string;
}

export interface CueTypeContext {
    type: string;
    version: string;
    line: number;
    column: number;
    start_line: number;
    end_line: number;
}

export interface CueParseResult {
    parameters: CueParameterInfo[];
    contexts: CueTypeContext[];
}

// === Extension Settings ===

export interface ZettaUtilsCueSettings {
    enableAutocomplete: boolean;
    enableValidation: boolean;
    metadataPath: string;
    pythonPath: string;
}

// === UI Components ===

export interface TypeFieldInfo {
    isInTypeField: boolean;
    partialName: string;
    isAtTypePosition: boolean;
}

export interface CurrentWordInfo {
    currentWord: string;
    hasLeadingQuote: boolean;
    finalCurrentWord: string;
    finalHasLeadingQuote: boolean;
    hasTrailingQuote: boolean;
}

// === Function Signatures ===

export type ValidationFunction = (textDocument: TextDocument, diagnostics: Diagnostic[]) => Promise<void>;
export type CompletionProvider = (document: TextDocument, position: Position) => Promise<CompletionItem[]>;
export type HoverProvider = (document: TextDocument, position: Position) => Promise<Hover | null>;