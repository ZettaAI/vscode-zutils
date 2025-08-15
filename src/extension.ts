import * as vscode from 'vscode';
import * as path from 'path';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

/**
 * Gets the active Python interpreter path using the Python extension API
 * @returns Promise resolving to Python interpreter path or null if not available
 */
async function getPythonPath(): Promise<string | null> {
    try {
        // Get the Python extension through VS Code extensions API
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');

        if (!pythonExtension) {
            console.log('Python extension not found');
            return null;
        }

        // Ensure the extension is activated
        if (!pythonExtension.isActive) {
            await pythonExtension.activate();
        }

        const pythonApi = pythonExtension.exports;

        if (!pythonApi) {
            console.log('Python extension API not available');
            return null;
        }

        // Get the active Python environment path for the current workspace
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const environmentPath = pythonApi.environments?.getActiveEnvironmentPath(workspaceFolder?.uri);

        if (environmentPath) {
            // Resolve the environment to get detailed information
            const environment = await pythonApi.environments?.resolveEnvironment(environmentPath);

            if (environment?.executable?.uri) {
                const pythonPath = environment.executable.uri.fsPath;
                console.log(`Found Python interpreter via Python extension: ${pythonPath}`);
                return pythonPath;
            }
        }

        console.log('No active Python environment found via Python extension');
        return null;
    } catch (error) {
        console.log(`Failed to get Python path from Python extension: ${error}`);
        return null;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // The server is implemented in TypeScript and compiled to JavaScript
    const serverModule = context.asAbsolutePath(
        path.join('out', 'server.js')
    );

    // Debug server options - runs server in node runtime
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    // Server options for different run modes
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions
        }
    };

    // Get Python path from Python extension
    const pythonPath = await getPythonPath();

    if (!pythonPath) {
        // Show error message to user if no Python path is available
        vscode.window.showErrorMessage(
            'Zetta Utils CUE Extension: No Python interpreter found. ' +
            'Please install the Python extension and select a Python interpreter with zetta_utils installed.',
            'Install Python Extension',
            'Select Python Interpreter'
        ).then(selection => {
            if (selection === 'Install Python Extension') {
                vscode.commands.executeCommand('vscode.open', vscode.Uri.parse('vscode:extension/ms-python.python'));
            } else if (selection === 'Select Python Interpreter') {
                vscode.commands.executeCommand('python.setInterpreter');
            }
        });
    }

    // Client options for language client configuration
    const clientOptions: LanguageClientOptions = {
        // Register server for CUE documents
        documentSelector: [{ scheme: 'file', language: 'cue' }],
        synchronize: {
            // Notify server about file changes to CUE files in workspace
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.cue')
        },
        initializationOptions: {
            // Pass storage URI and Python path to language server
            storageUri: context.storageUri?.toString(),
            globalStorageUri: context.globalStorageUri?.toString(),
            pythonPath: pythonPath
        }
    };

    // Create and start the language client
    client = new LanguageClient(
        'zettatUtilsCueLanguageServer',
        'Zetta Utils CUE Language Server',
        serverOptions,
        clientOptions
    );

    // Register commands
    const refreshMetadataCommand = vscode.commands.registerCommand(
        'zettatUtilsCue.refreshMetadata',
        async () => {
            try {
                vscode.window.showInformationMessage('Refreshing builder metadata...');
                const result = await client.sendRequest('zettaUtils/refreshMetadata');
                if (result && (result as any).success) {
                    vscode.window.showInformationMessage((result as any).message || 'Builder metadata refreshed successfully!');
                } else {
                    vscode.window.showErrorMessage((result as any).message || 'Failed to refresh builder metadata');
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to refresh builder metadata: ${error}`);
            }
        }
    );

    const selectPythonInterpreterCommand = vscode.commands.registerCommand(
        'zettatUtilsCue.selectPythonInterpreter',
        async () => {
            // Use the Python extension command to select interpreter
            await vscode.commands.executeCommand('python.setInterpreter');

            // Show info message to user
            vscode.window.showInformationMessage(
                'Please select a Python interpreter that has zetta_utils installed. ' +
                'The extension will refresh automatically once a valid interpreter is selected.'
            );

            // Trigger metadata refresh with new Python path
            setTimeout(() => {
                client.sendRequest('zettaUtils/refreshMetadata');
            }, 1000); // Small delay to allow Python extension to update
        }
    );

    // Register providers and start client
    context.subscriptions.push(
        refreshMetadataCommand,
        selectPythonInterpreterCommand
    );

    // Start the client separately
    client.start();

    // Show activation message
    vscode.window.showInformationMessage('Zetta Utils CUE Support activated!');
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}