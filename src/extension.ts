/**
 * OmniCode VS Code Extension
 * Self-contained agentic AI assistant with visual codebase mapping
 */

import * as vscode from 'vscode';
import { GraphViewProvider } from './webview/GraphViewProvider';
import { IndexerService } from './indexer/IndexerService';
import { FileSystemProvider } from './providers/FileSystemProvider';
import { TerminalProvider } from './providers/TerminalProvider';
import { OmniCodeAgent, AgentConfig, MonologueEntry } from './Agent';
import { ProviderType, DEFAULT_MODELS } from './LLMProvider';

let indexerService: IndexerService | undefined;
let graphViewProvider: GraphViewProvider | undefined;
let agent: OmniCodeAgent | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('OmniCode extension activating...');

    // Initialize providers
    const fileSystemProvider = new FileSystemProvider();
    const terminalProvider = new TerminalProvider();

    // Initialize the indexer service
    indexerService = new IndexerService(context);

    // Initialize the webview provider
    graphViewProvider = new GraphViewProvider(
        context.extensionUri,
        indexerService
    );

    // Register the webview provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'omnicode.graphView',
            graphViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // ========================================================================
    // COMMANDS
    // ========================================================================

    // Open Graph command
    context.subscriptions.push(
        vscode.commands.registerCommand('omnicode.openGraph', () => {
            vscode.commands.executeCommand('omnicode.graphView.focus');
        })
    );

    // Index Workspace command
    context.subscriptions.push(
        vscode.commands.registerCommand('omnicode.indexWorkspace', async () => {
            if (!indexerService) {
                vscode.window.showErrorMessage('Indexer not initialized');
                return;
            }

            // First: Show structure immediately (fast!)
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'OmniCode: Quick scan...',
                    cancellable: false
                },
                async (progress, token) => {
                    try {
                        const structureGraph = await indexerService!.indexStructureOnly(progress, token);
                        graphViewProvider?.updateGraph(structureGraph);
                        vscode.window.showInformationMessage(
                            `📊 Found ${structureGraph.metadata.fileCount} files - Graph ready! Full analysis running in background...`
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(`Quick scan failed: ${error}`);
                    }
                }
            );

            // Second: Full analysis in background (optional, slower)
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'OmniCode: Deep analysis...',
                    cancellable: true
                },
                async (progress, token) => {
                    try {
                        const fullGraph = await indexerService!.indexWorkspace(progress, token);
                        graphViewProvider?.updateGraph(fullGraph);
                        vscode.window.showInformationMessage(
                            `✅ Full analysis complete: ${fullGraph.nodes.length} nodes, ${fullGraph.edges.length} edges`
                        );
                    } catch (error) {
                        if (!token.isCancellationRequested) {
                            vscode.window.showErrorMessage(`Deep analysis failed: ${error}`);
                        }
                    }
                }
            );
        })
    );

    // Ask Agent command
    context.subscriptions.push(
        vscode.commands.registerCommand('omnicode.askAgent', async () => {
            // Check if API key is configured
            const config = vscode.workspace.getConfiguration('omnicode');
            let apiKey = config.get<string>('llm.apiKey', '');

            if (!apiKey) {
                // Try to get from secret storage
                apiKey = await context.secrets.get('omnicode.apiKey') || '';
            }

            if (!apiKey) {
                const result = await vscode.window.showWarningMessage(
                    'No API key configured. Would you like to configure one now?',
                    'Configure',
                    'Cancel'
                );
                if (result === 'Configure') {
                    vscode.commands.executeCommand('omnicode.configureApiKey');
                }
                return;
            }

            // Get user input
            const task = await vscode.window.showInputBox({
                prompt: 'What would you like the agent to do?',
                placeHolder: 'e.g., Explain the auth flow, Find all API endpoints, Fix the bug in UserService...',
            });

            if (!task) return;

            // Initialize agent if needed
            if (!agent) {
                agent = createAgent(config, apiKey, context, indexerService!, fileSystemProvider, terminalProvider);
            }

            // Run agent with progress
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'OmniCode Agent working...',
                    cancellable: false
                },
                async (progress) => {
                    try {
                        agent!.onMonologue = (entry: MonologueEntry) => {
                            progress.report({ message: entry.content.substring(0, 50) + '...' });
                            graphViewProvider?.addMonologue(entry);
                        };

                        agent!.onGraphHighlight = (nodeIds: string[]) => {
                            graphViewProvider?.highlightNodes(nodeIds);
                        };

                        const result = await agent!.run(task);

                        // Show result
                        const doc = await vscode.workspace.openTextDocument({
                            content: `# Agent Response\n\n${result}`,
                            language: 'markdown'
                        });
                        await vscode.window.showTextDocument(doc, { preview: true });

                        graphViewProvider?.addMessage({
                            role: 'assistant',
                            content: result,
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(`Agent error: ${error}`);
                    }
                }
            );
        })
    );

    // Configure API Key command
    context.subscriptions.push(
        vscode.commands.registerCommand('omnicode.configureApiKey', async () => {
            const config = vscode.workspace.getConfiguration('omnicode');
            const provider = config.get<ProviderType>('llm.provider', 'openai');

            const apiKey = await vscode.window.showInputBox({
                prompt: `Enter your ${provider.toUpperCase()} API key`,
                password: true,
                placeHolder: 'sk-...',
                ignoreFocusOut: true,
            });

            if (apiKey) {
                // Store in VS Code's secure storage
                await context.secrets.store('omnicode.apiKey', apiKey);
                vscode.window.showInformationMessage('API key saved securely!');

                // Reset agent to use new key
                agent = undefined;
            }
        })
    );

    // ========================================================================
    // AUTO-INDEX ON STARTUP
    // ========================================================================

    if (vscode.workspace.workspaceFolders?.length) {
        // Check if API key exists
        const apiKey = await context.secrets.get('omnicode.apiKey');
        if (!apiKey) {
            // Show welcome message for first-time users
            const result = await vscode.window.showInformationMessage(
                'Welcome to OmniCode! Configure your API key to start using the AI agent.',
                'Configure API Key',
                'Later'
            );
            if (result === 'Configure API Key') {
                vscode.commands.executeCommand('omnicode.configureApiKey');
            }
        }

        // Delay indexing to not block activation
        setTimeout(() => {
            vscode.commands.executeCommand('omnicode.indexWorkspace');
        }, 2000);
    }

    console.log('OmniCode extension activated');
}

/**
 * Create an agent instance with current configuration
 */
function createAgent(
    config: vscode.WorkspaceConfiguration,
    apiKey: string,
    context: vscode.ExtensionContext,
    indexer: IndexerService,
    fileSystem: FileSystemProvider,
    terminal: TerminalProvider
): OmniCodeAgent {
    const provider = config.get<ProviderType>('llm.provider', 'openai');
    const model = config.get<string>('llm.model', '') || DEFAULT_MODELS[provider];
    const maxIterations = config.get<number>('agent.maxIterations', 10);
    const confirmDangerous = config.get<boolean>('agent.confirmDangerousOperations', true);

    const agentConfig: AgentConfig = {
        provider,
        apiKey,
        model,
        maxIterations,
        confirmDangerousOperations: confirmDangerous,
    };

    return new OmniCodeAgent(agentConfig, indexer, fileSystem, terminal);
}

export function deactivate() {
    console.log('OmniCode extension deactivated');
}
