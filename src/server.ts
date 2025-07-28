/**
 * Main language server for Zetta Utils CUE support
 * Coordinates all modules and handles LSP protocol
 */

import {
    createConnection,
    TextDocuments,
    Diagnostic,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    HoverParams,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

// Import our modular components
import { ZettaUtilsCueSettings } from './types';
import {
    loadBuilderMetadata,
    refreshBuilderMetadata,
    extensionBuilders
} from './metadata';

import { provideCompletions } from './completion';
import { provideHover } from './hover';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Server capabilities
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// Extension settings
let settings: ZettaUtilsCueSettings = {
    enableAutocomplete: true,
    enableValidation: true,
    metadataPath: '',
    pythonPath: 'python3'
};

// Storage and initialization data from client
let storageUri: string | undefined;
let globalStorageUri: string | undefined;
let clientPythonPath: string | undefined;

// === Server Initialization ===

connection.onInitialize((params: InitializeParams): InitializeResult => {
    const capabilities = params.capabilities;

    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );

    // Get initialization options from client
    if (params.initializationOptions) {
        storageUri = params.initializationOptions.storageUri;
        globalStorageUri = params.initializationOptions.globalStorageUri;
        clientPythonPath = params.initializationOptions.pythonPath;

        connection.console.log(`Received storageUri: ${storageUri}`);
        connection.console.log(`Received globalStorageUri: ${globalStorageUri}`);
        connection.console.log(`Received pythonPath: ${clientPythonPath}`);

        // Use the Python path from client
        if (clientPythonPath) {
            settings.pythonPath = clientPythonPath;
        }
    }

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['"', '@', '_', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z']
            },
            hoverProvider: true
        }
    };

    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }

    return result;
});

connection.onInitialized(async () => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }

    // Set extension metadata path if not configured
    if (!settings.metadataPath) {
        settings.metadataPath = getExtensionMetadataPath();
        connection.console.log(`Using extension metadata path: ${settings.metadataPath}`);
    }

    // Load initial metadata
    loadBuilderMetadata(settings).catch(error => {
        connection.console.error(`Failed to load initial metadata: ${error}`);
    });
});

// === Python Extension Integration ===

// Python path is now provided by the client extension via initializationOptions

function getExtensionMetadataPath(): string {
    // Prefer workspace-specific storage
    if (storageUri) {
        const storagePath = storageUri.replace('file://', '');
        return `${storagePath}/zetta_utils_metadata.json`;
    }

    // Fallback to global storage
    if (globalStorageUri) {
        const storagePath = globalStorageUri.replace('file://', '');
        return `${storagePath}/zetta_utils_metadata.json`;
    }

    // Final fallback to global cache
    const path = require('path');
    const os = require('os');
    const cacheDir = path.join(os.homedir(), '.zetta_utils', 'vscode_cache');
    return `${cacheDir}/builder_metadata.json`;
}

// === Configuration Management ===

connection.onDidChangeConfiguration(async (_change) => {
    if (hasConfigurationCapability) {
        try {
            const config = await connection.workspace.getConfiguration('zettatUtilsCue');
            const previousSettings = { ...settings };

            // Get extension metadata path if not explicitly configured
            const extensionMetadataPath = config.metadataPath || getExtensionMetadataPath();

            // Update settings (Python path is set from client initialization)
            settings = {
                enableAutocomplete: config.enableAutocomplete ?? true,
                enableValidation: config.enableValidation ?? true,
                metadataPath: extensionMetadataPath,
                pythonPath: clientPythonPath || settings.pythonPath  // Use client-provided Python path
            };

            connection.console.log(`Workspace settings updated: ${JSON.stringify({
                enableAutocomplete: settings.enableAutocomplete,
                enableValidation: settings.enableValidation,
                metadataPath: settings.metadataPath,
                pythonPath: settings.pythonPath
            })}`);

            // Only reload metadata if metadataPath changed
            if (previousSettings.metadataPath !== settings.metadataPath) {
                connection.console.log('Metadata path changed, reloading metadata...');
                await loadBuilderMetadata(settings);
            }
        } catch (error) {
            connection.console.log(`Failed to update settings: ${(error as Error).message}`);
        }
    } else {
        // If no config capability, just reload metadata
        await loadBuilderMetadata(settings);
    }

    // Revalidate all open documents
    documents.all().forEach(doc => {
        validateTextDocumentWithConnection(doc);
    });
});

// === Document Management ===

documents.onDidClose(e => {
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

documents.onDidChangeContent(change => {
    if (settings.enableValidation) {
        validateTextDocumentWithConnection(change.document);
    }
});

// === Validation with Connection ===

async function validateTextDocumentWithConnection(textDocument: TextDocument): Promise<void> {
    const diagnostics: Diagnostic[] = [];

    try {
        // Only validate .cue files
        if (!textDocument.uri.endsWith('.cue')) {
            return;
        }

        connection.console.log(`Validating document: ${textDocument.uri}`);

        // Import validation function and run it
        const { validateParameters } = await import('./validation');
        await validateParameters(textDocument, diagnostics);

    } catch (error) {
        connection.console.error(`Validation error for ${textDocument.uri}: ${error}`);
    }

    // Send diagnostics to client
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// === LSP Feature Handlers ===

connection.onCompletion(
    async (textDocumentPosition: TextDocumentPositionParams) => {
        if (!settings.enableAutocomplete) {
            return [];
        }

        const document = documents.get(textDocumentPosition.textDocument.uri);
        if (!document) {
            return [];
        }

        const position = textDocumentPosition.position;

        try {
            return await provideCompletions(document, position);
        } catch (error) {
            connection.console.error(`Completion error: ${error}`);
            return [];
        }
    }
);

connection.onCompletionResolve(
    (item) => {
        // For now, just return the item as-is
        // Could add additional details here if needed
        return item;
    }
);

connection.onHover(
    async (params: HoverParams) => {
        const document = documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        try {
            return await provideHover(document, params.position);
        } catch (error) {
            connection.console.error(`Hover error: ${error}`);
            return null;
        }
    }
);

// === Custom Commands ===

// Command to refresh metadata
connection.onRequest('zettaUtils/refreshMetadata', async () => {
    try {
        connection.console.log('Refreshing builder metadata...');

        // Use the current extension metadata path
        const targetPath = settings.metadataPath || getExtensionMetadataPath();
        await refreshBuilderMetadata(targetPath, settings.pythonPath);

        // Revalidate all documents after refresh
        documents.all().forEach(doc => {
            validateTextDocumentWithConnection(doc);
        });

        connection.console.log(`Metadata refreshed successfully. Loaded ${extensionBuilders.length} builders.`);
        return { success: true, message: `Refreshed ${extensionBuilders.length} builders` };
    } catch (error) {
        const errorMessage = `Failed to refresh metadata: ${error}`;
        connection.console.error(errorMessage);
        return { success: false, message: errorMessage };
    }
});

// Command to get builder info
connection.onRequest('zettaUtils/getBuilderInfo', async (params: { builderName: string }) => {
    try {
        const { builderLookup } = await import('./metadata');
        const builder = builderLookup[params.builderName];

        if (builder) {
            return {
                success: true,
                builder: {
                    name: builder.name,
                    module: builder.metadata.module,
                    function_name: builder.metadata.function_name,
                    parameters: builder.parameters.length,
                    documentation: builder.metadata.documentation.summary
                }
            };
        } else {
            return { success: false, message: `Builder '${params.builderName}' not found` };
        }
    } catch (error) {
        return { success: false, message: `Error getting builder info: ${error}` };
    }
});

// === Error Handling ===

connection.onExit(() => {
    connection.console.log('Language server exiting...');
});

process.on('unhandledRejection', (reason, promise) => {
    connection.console.error(`Unhandled rejection at ${promise}: ${reason}`);
});

process.on('uncaughtException', (error) => {
    connection.console.error(`Uncaught exception: ${error}`);
    process.exit(1);
});

// === Start Server ===

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();

connection.console.log('Zetta Utils CUE Language Server started');