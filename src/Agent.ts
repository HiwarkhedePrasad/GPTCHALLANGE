/**
 * OmniCode Agent - ReAct Loop Implementation
 * Runs entirely within the VS Code extension (no external processes)
 */

import * as vscode from 'vscode';
import {
    LLMProvider,
    LLMMessage,
    ToolDefinition,
    ToolCall,
    createLLMProvider,
    ProviderType,
    DEFAULT_MODELS,
} from './LLMProvider';
import { IndexerService } from './indexer/IndexerService';
import { FileSystemProvider } from './providers/FileSystemProvider';
import { TerminalProvider } from './providers/TerminalProvider';

// ============================================================================
// TYPES
// ============================================================================

export interface AgentTool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, { type: string; description: string; enum?: string[] }>;
        required: string[];
    };
    execute: (params: Record<string, unknown>) => Promise<string>;
}

export interface AgentConfig {
    provider: ProviderType;
    apiKey: string;
    model?: string;
    maxIterations?: number;
    confirmDangerousOperations?: boolean;
}

export interface MonologueEntry {
    type: 'thinking' | 'action' | 'result' | 'error';
    content: string;
    timestamp: number;
}

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

const SYSTEM_PROMPT = `You are OmniCode, an expert AI coding assistant with deep access to the codebase.
You can read files, query the knowledge graph, write files, and run commands.

Your capabilities:
- Read and analyze source code files
- Query the knowledge graph to understand relationships between symbols
- Find symbol definitions and their callers/callees
- Understand code clusters and architecture
- Write and patch files (with user confirmation)
- Run terminal commands (tests, builds, lints)

When given a task:
1. Think step by step about what you need to do
2. Use tools to gather information and understand the codebase
3. Make changes if requested (files will be written with user confirmation)
4. Verify changes by running tests or builds
5. Provide clear explanations of what you did

For bug fixes:
1. First understand the bug by querying the graph and reading relevant files
2. Identify the impact radius - what else might be affected
3. Make the fix using patch_file or write_file
4. Run tests to verify the fix works

Always explain your reasoning and be specific about file paths and symbol names.
When referencing code, include relevant snippets to support your analysis.

Current knowledge graph clusters represent functional areas of the codebase.
Use them to understand the high-level architecture.`;

// ============================================================================
// OMNICODE AGENT
// ============================================================================

export class OmniCodeAgent {
    private llm: LLMProvider;
    private tools: AgentTool[];
    private toolDefinitions: ToolDefinition[];
    private maxIterations: number;
    private confirmDangerous: boolean;

    // Event emitters
    public onMonologue?: (entry: MonologueEntry) => void;
    public onGraphHighlight?: (nodeIds: string[]) => void;

    constructor(
        config: AgentConfig,
        private indexer: IndexerService,
        private fileSystem: FileSystemProvider,
        private terminal: TerminalProvider
    ) {
        this.llm = createLLMProvider(config.provider, {
            apiKey: config.apiKey,
            model: config.model || DEFAULT_MODELS[config.provider],
        });
        this.maxIterations = config.maxIterations || 10;
        this.confirmDangerous = config.confirmDangerousOperations ?? true;

        this.tools = this.buildTools();
        this.toolDefinitions = this.tools.map(t => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));
    }

    /**
     * Run the agent on a task
     */
    async run(task: string): Promise<string> {
        const messages: LLMMessage[] = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: task },
        ];

        this.emitMonologue('thinking', `Starting task: ${task}`);

        for (let i = 0; i < this.maxIterations; i++) {
            try {
                // Call LLM
                const response = await this.llm.chat(messages, this.toolDefinitions);

                // If LLM has thinking/content, emit it
                if (response.content) {
                    this.emitMonologue('thinking', response.content);
                    messages.push({ role: 'assistant', content: response.content, tool_calls: response.tool_calls });
                } else if (response.tool_calls) {
                    messages.push({ role: 'assistant', content: '', tool_calls: response.tool_calls });
                }

                // If no tool calls, we're done
                if (response.finish_reason !== 'tool_calls' || !response.tool_calls) {
                    return response.content || 'Task completed.';
                }

                // Execute tool calls
                for (const toolCall of response.tool_calls) {
                    const result = await this.executeTool(toolCall);
                    messages.push({
                        role: 'tool',
                        content: result,
                        tool_call_id: toolCall.id,
                        name: toolCall.function.name,
                    });
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                this.emitMonologue('error', `Error: ${errorMsg}`);
                messages.push({ role: 'user', content: `Error occurred: ${errorMsg}. Please try a different approach.` });
            }
        }

        return 'Reached maximum iterations. Here is what I found so far.';
    }

    /**
     * Execute a single tool call
     */
    private async executeTool(toolCall: ToolCall): Promise<string> {
        const toolName = toolCall.function.name;
        const tool = this.tools.find(t => t.name === toolName);

        if (!tool) {
            const error = `Unknown tool: ${toolName}`;
            this.emitMonologue('error', error);
            return JSON.stringify({ error });
        }

        let params: Record<string, unknown>;
        try {
            params = JSON.parse(toolCall.function.arguments);
        } catch {
            const error = `Invalid tool arguments: ${toolCall.function.arguments}`;
            this.emitMonologue('error', error);
            return JSON.stringify({ error });
        }

        this.emitMonologue('action', `Calling ${toolName}: ${JSON.stringify(params)}`);

        try {
            const result = await tool.execute(params);
            this.emitMonologue('result', `${toolName} returned: ${result.substring(0, 200)}...`);
            return result;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.emitMonologue('error', `${toolName} failed: ${errorMsg}`);
            return JSON.stringify({ error: errorMsg });
        }
    }

    /**
     * Build all available tools
     */
    private buildTools(): AgentTool[] {
        return [
            // READ TOOLS
            {
                name: 'read_file',
                description: 'Read the contents of a file',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path to the file relative to workspace root' },
                    },
                    required: ['path'],
                },
                execute: async (params) => {
                    const content = await this.fileSystem.readFile(params.path as string);
                    return JSON.stringify({ content });
                },
            },
            {
                name: 'list_files',
                description: 'List files in a directory',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Directory path relative to workspace root' },
                        pattern: { type: 'string', description: 'Glob pattern to filter files (optional)' },
                    },
                    required: ['path'],
                },
                execute: async (params) => {
                    const files = await this.fileSystem.listDirectory(params.path as string);
                    return JSON.stringify({ files });
                },
            },
            {
                name: 'search_code',
                description: 'Search for symbols/code in the indexed codebase',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query (symbol name, function, class)' },
                        limit: { type: 'number', description: 'Max results to return (default 10)' },
                    },
                    required: ['query'],
                },
                execute: async (params) => {
                    const results = this.indexer.searchNodes(params.query as string, (params.limit as number) || 10);
                    if (this.onGraphHighlight) {
                        this.onGraphHighlight(results.map(r => r.id));
                    }
                    return JSON.stringify({ results });
                },
            },

            // GRAPH TOOLS
            {
                name: 'query_graph',
                description: 'Query the knowledge graph for a symbol and its relationships',
                parameters: {
                    type: 'object',
                    properties: {
                        symbol: { type: 'string', description: 'Symbol name to query' },
                    },
                    required: ['symbol'],
                },
                execute: async (params) => {
                    const nodes = this.indexer.searchNodes(params.symbol as string, 5);
                    const edges = nodes.flatMap(n => this.indexer.getEdgesForNode(n.id));
                    if (this.onGraphHighlight && nodes.length > 0) {
                        this.onGraphHighlight(nodes.map(n => n.id));
                    }
                    return JSON.stringify({ nodes, edges });
                },
            },
            {
                name: 'get_call_graph',
                description: 'Get functions that call or are called by a given function',
                parameters: {
                    type: 'object',
                    properties: {
                        function_name: { type: 'string', description: 'Name of the function' },
                    },
                    required: ['function_name'],
                },
                execute: async (params) => {
                    const result = this.indexer.getCallGraph(params.function_name as string);
                    return JSON.stringify(result);
                },
            },
            {
                name: 'find_impact_radius',
                description: 'Find all code that would be affected if a function is changed',
                parameters: {
                    type: 'object',
                    properties: {
                        function_name: { type: 'string', description: 'Name of the function to analyze' },
                    },
                    required: ['function_name'],
                },
                execute: async (params) => {
                    const result = this.indexer.findImpactRadius(params.function_name as string);
                    if (this.onGraphHighlight) {
                        const ids = [...result.directly, ...result.transitively].map(n => n.id);
                        this.onGraphHighlight(ids);
                    }
                    return JSON.stringify({
                        directlyAffected: result.directly,
                        transitivelyAffected: result.transitively,
                    });
                },
            },
            {
                name: 'get_architecture_summary',
                description: 'Get a high-level summary of the codebase architecture',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: [],
                },
                execute: async () => {
                    const summary = this.indexer.getArchitectureSummary();
                    return JSON.stringify(summary);
                },
            },
            {
                name: 'get_cluster_info',
                description: 'Get information about code clusters/modules',
                parameters: {
                    type: 'object',
                    properties: {
                        cluster_id: { type: 'number', description: 'Cluster ID (optional, returns all if omitted)' },
                    },
                    required: [],
                },
                execute: async (params) => {
                    if (params.cluster_id !== undefined) {
                        const nodes = this.indexer.getNodesInCluster(params.cluster_id as number);
                        return JSON.stringify({ clusterId: params.cluster_id, nodes });
                    }
                    const allClusters = this.indexer.getAllClusters();
                    return JSON.stringify({ clusters: allClusters });
                },
            },

            // WRITE TOOLS
            {
                name: 'write_file',
                description: 'Write content to a file (creates or overwrites)',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path to the file relative to workspace root' },
                        content: { type: 'string', description: 'Content to write to the file' },
                    },
                    required: ['path', 'content'],
                },
                execute: async (params) => {
                    if (this.confirmDangerous) {
                        const result = await vscode.window.showWarningMessage(
                            `Agent wants to write to: ${params.path}`,
                            'Allow',
                            'Deny'
                        );
                        if (result !== 'Allow') {
                            return JSON.stringify({ error: 'User denied file write operation' });
                        }
                    }
                    await this.fileSystem.writeFile(params.path as string, params.content as string);
                    return JSON.stringify({ success: true, path: params.path });
                },
            },
            {
                name: 'patch_file',
                description: 'Replace a specific section of a file. Use replaceAll=true to replace all occurrences, or provide unique surrounding context to target a specific one.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path to the file' },
                        search: { type: 'string', description: 'Text to find in the file (include surrounding context for uniqueness)' },
                        replace: { type: 'string', description: 'Text to replace it with' },
                        replaceAll: { type: 'boolean', description: 'If true, replaces all occurrences. Default is false (only first occurrence).' },
                    },
                    required: ['path', 'search', 'replace'],
                },
                execute: async (params) => {
                    if (this.confirmDangerous) {
                        const result = await vscode.window.showWarningMessage(
                            `Agent wants to patch: ${params.path}\nFind: ${(params.search as string).substring(0, 50)}...`,
                            'Allow',
                            'Deny'
                        );
                        if (result !== 'Allow') {
                            return JSON.stringify({ error: 'User denied file patch operation' });
                        }
                    }
                    const fileInfo = await this.fileSystem.readFile(params.path as string);
                    const content = fileInfo.content;
                    const searchStr = params.search as string;
                    const replaceStr = params.replace as string;
                    const replaceAll = params.replaceAll === true;
                    
                    // Count occurrences
                    let count = 0;
                    let pos = 0;
                    while ((pos = content.indexOf(searchStr, pos)) !== -1) {
                        count++;
                        pos += searchStr.length;
                    }
                    
                    if (count === 0) {
                        return JSON.stringify({ error: 'Search text not found in file' });
                    }
                    
                    if (count > 1 && !replaceAll) {
                        return JSON.stringify({ 
                            error: `Found ${count} occurrences. Use replaceAll=true to replace all, or provide more specific surrounding context to target one.` 
                        });
                    }
                    
                    const newContent = replaceAll 
                        ? content.split(searchStr).join(replaceStr)
                        : content.replace(searchStr, replaceStr);
                        
                    await this.fileSystem.writeFile(params.path as string, newContent);
                    return JSON.stringify({ success: true, path: params.path, replaced: replaceAll ? count : 1 });
                },
            },
            {
                name: 'create_file',
                description: 'Create a new file',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path for the new file' },
                        content: { type: 'string', description: 'Content for the file' },
                    },
                    required: ['path', 'content'],
                },
                execute: async (params) => {
                    if (this.confirmDangerous) {
                        const result = await vscode.window.showWarningMessage(
                            `Agent wants to create: ${params.path}`,
                            'Allow',
                            'Deny'
                        );
                        if (result !== 'Allow') {
                            return JSON.stringify({ error: 'User denied file creation' });
                        }
                    }
                    await this.fileSystem.createFile(params.path as string, params.content as string);
                    return JSON.stringify({ success: true, path: params.path });
                },
            },
            {
                name: 'delete_file',
                description: 'Delete a file',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path to the file to delete' },
                    },
                    required: ['path'],
                },
                execute: async (params) => {
                    const result = await vscode.window.showWarningMessage(
                        `Agent wants to DELETE: ${params.path}`,
                        { modal: true },
                        'Allow Delete',
                        'Cancel'
                    );
                    if (result !== 'Allow Delete') {
                        return JSON.stringify({ error: 'User denied file deletion' });
                    }
                    await this.fileSystem.deleteFile(params.path as string);
                    return JSON.stringify({ success: true, path: params.path });
                },
            },

            // TERMINAL TOOLS
            {
                name: 'run_command',
                description: 'Run a terminal command',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'Command to run' },
                        cwd: { type: 'string', description: 'Working directory (optional)' },
                    },
                    required: ['command'],
                },
                execute: async (params) => {
                    if (this.confirmDangerous) {
                        const result = await vscode.window.showWarningMessage(
                            `Agent wants to run: ${params.command}`,
                            'Allow',
                            'Deny'
                        );
                        if (result !== 'Allow') {
                            return JSON.stringify({ error: 'User denied terminal command' });
                        }
                    }
                    const output = await this.terminal.runCommand(
                        params.command as string,
                        { cwd: params.cwd as string | undefined }
                    );
                    return JSON.stringify({ output });
                },
            },
            {
                name: 'run_tests',
                description: 'Run the project test suite',
                parameters: {
                    type: 'object',
                    properties: {
                        test_command: { type: 'string', description: 'Test command (defaults to npm test)' },
                    },
                    required: [],
                },
                execute: async (params) => {
                    const cmd = (params.test_command as string) || 'npm test';
                    if (this.confirmDangerous) {
                        const result = await vscode.window.showWarningMessage(
                            `Agent wants to run tests: ${cmd}`,
                            'Allow',
                            'Deny'
                        );
                        if (result !== 'Allow') {
                            return JSON.stringify({ error: 'User denied test execution' });
                        }
                    }
                    const output = await this.terminal.runCommand(cmd);
                    return JSON.stringify({ output });
                },
            },
            {
                name: 'run_build',
                description: 'Run the project build',
                parameters: {
                    type: 'object',
                    properties: {
                        build_command: { type: 'string', description: 'Build command (defaults to npm run build)' },
                    },
                    required: [],
                },
                execute: async (params) => {
                    const cmd = (params.build_command as string) || 'npm run build';
                    if (this.confirmDangerous) {
                        const result = await vscode.window.showWarningMessage(
                            `Agent wants to build: ${cmd}`,
                            'Allow',
                            'Deny'
                        );
                        if (result !== 'Allow') {
                            return JSON.stringify({ error: 'User denied build execution' });
                        }
                    }
                    const output = await this.terminal.runCommand(cmd);
                    return JSON.stringify({ output });
                },
            },
        ];
    }

    /**
     * Emit a monologue entry
     */
    private emitMonologue(type: MonologueEntry['type'], content: string): void {
        if (this.onMonologue) {
            this.onMonologue({
                type,
                content,
                timestamp: Date.now(),
            });
        }
    }
}
