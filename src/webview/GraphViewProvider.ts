/**
 * GraphViewProvider - Webview for knowledge graph visualization
 * Uses Sigma.js + Graphology for GitNexus-style beautiful graphs
 */

import * as vscode from 'vscode';
import { IndexerService, KnowledgeGraph } from '../indexer/IndexerService';

export interface MonologueEntry {
    type: 'thinking' | 'action' | 'result' | 'error';
    content: string;
    timestamp: number;
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'error';
    content: string;
}

export class GraphViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private currentGraph?: KnowledgeGraph;

    // Event handlers (set by extension.ts)
    public onChatMessage?: (text: string) => void;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly indexerService: IndexerService
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'media'),
                vscode.Uri.joinPath(this.extensionUri, 'dist'),
                vscode.Uri.joinPath(this.extensionUri, 'webview-dist')
            ]
        };

        webviewView.webview.html = this.getWebviewContent(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'node_click':
                    await this.handleNodeClick(message.nodeId);
                    break;
                case 'chat_message':
                    if (this.onChatMessage) {
                        this.onChatMessage(message.text);
                    } else {
                        vscode.commands.executeCommand('omnicode.askAgent');
                    }
                    break;
                case 'request_graph':
                    if (this.currentGraph) {
                        this.updateGraph(this.currentGraph);
                    }
                    break;
                case 'ready':
                    console.log('Webview ready');
                    if (this.currentGraph) {
                        this.updateGraph(this.currentGraph);
                    }
                    break;
            }
        });
    }

    updateGraph(graph: KnowledgeGraph): void {
        this.currentGraph = graph;
        
        const nodeTypes = graph.nodes.reduce((acc, n) => {
            acc[n.type] = (acc[n.type] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        
        console.log('Updating graph:', {
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
            nodeTypes,
            hasView: !!this.view
        });
        
        // If no nodes, show a message
        if (graph.nodes.length === 0) {
            console.warn('Graph has no nodes!');
        }
        
        this.postMessage({
            type: 'graph_data',
            data: {
                nodes: graph.nodes.map(node => ({
                    id: node.id,
                    name: node.name,
                    type: node.type,
                    path: node.path,
                    cluster: node.cluster,
                    startLine: node.location?.line,
                    endLine: node.location?.endLine
                })),
                edges: graph.edges.map(edge => ({
                    source: edge.source,
                    target: edge.target,
                    type: edge.type
                }))
            }
        });
    }

    highlightNodes(nodeIds: string[]): void {
        this.postMessage({
            type: 'highlight_nodes',
            data: { nodeIds }
        });
    }

    addMonologue(entry: MonologueEntry): void {
        this.postMessage({
            type: 'monologue',
            data: {
                text: entry.content,
                type: entry.type,
                timestamp: entry.timestamp
            }
        });
    }

    addMessage(message: ChatMessage): void {
        this.postMessage({
            type: 'chat_response',
            data: message
        });
    }

    private async handleNodeClick(nodeId: string): Promise<void> {
        if (!this.currentGraph) return;

        const node = this.currentGraph.nodes.find(n => n.id === nodeId);
        if (!node || !node.path) return;

        try {
            const uri = vscode.Uri.file(node.path);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);

            if (node.location) {
                const position = new vscode.Position(node.location.line, node.location.column);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }
        } catch (error) {
            console.error('Failed to open file:', error);
        }
    }

    private postMessage(message: unknown): void {
        if (this.view) {
            this.view.webview.postMessage(message);
        }
    }

    private getWebviewContent(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://esm.sh 'unsafe-inline' 'unsafe-eval'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; connect-src ${webview.cspSource} https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://esm.sh;">
    <title>OmniCode</title>
    <!-- Sigma.js v3 + Graphology -->
    <script src="https://cdn.jsdelivr.net/npm/graphology@0.25.4/dist/graphology.umd.min.js"></script>
    <script type="module">
        import Sigma from 'https://esm.sh/sigma@3.0.0';
        window.Sigma = Sigma;
    </script>
    <style>
        :root {
            --bg-void: #06060a;
            --bg-elevated: #12121c;
            --border-subtle: #2a2a3a;
            --text-primary: #f5f5f7;
            --text-secondary: #a1a1aa;
            --text-muted: #71717a;
            --accent: #10b981;
            --accent-glow: rgba(16, 185, 129, 0.3);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            background: var(--bg-void);
            color: var(--text-primary);
            font-family: 'JetBrains Mono', 'Fira Code', monospace;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        #graph-container { 
            flex: 1; 
            min-height: 300px;
            position: relative;
            background: linear-gradient(to bottom, #06060a, #0a0a10);
        }
        #sigma-container {
            width: 100%;
            height: 100%;
            cursor: grab;
        }
        #sigma-container:active { cursor: grabbing; }
        
        /* Radial gradient background - emerald glow */
        #graph-container::before {
            content: '';
            position: absolute;
            inset: 0;
            background: radial-gradient(circle at 50% 50%, rgba(16, 185, 129, 0.05) 0%, transparent 70%);
            pointer-events: none;
        }
        
        /* Controls overlay */
        .controls {
            position: absolute;
            bottom: 12px;
            right: 12px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            z-index: 10;
        }
        .control-btn {
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-elevated);
            border: 1px solid var(--border-subtle);
            border-radius: 6px;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 14px;
            transition: all 0.15s;
        }
        .control-btn:hover {
            background: #1e1e2e;
            color: var(--text-primary);
            border-color: var(--accent);
        }
        .control-btn.active {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); }
            50% { box-shadow: 0 0 12px 4px var(--accent-glow); }
        }
        
        /* Selection info bar - emerald theme */
        .selection-bar {
            position: absolute;
            top: 12px;
            left: 50%;
            transform: translateX(-50%);
            display: none;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            background: rgba(16, 185, 129, 0.15);
            border: 1px solid rgba(16, 185, 129, 0.3);
            border-radius: 12px;
            backdrop-filter: blur(8px);
            z-index: 20;
            animation: slideUp 0.2s ease-out;
        }
        .selection-bar.visible { display: flex; }
        @keyframes slideUp {
            from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
            to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        .selection-dot {
            width: 8px;
            height: 8px;
            background: var(--accent);
            border-radius: 50%;
            animation: pulse 1.5s infinite;
        }
        .selection-name {
            font-size: 13px;
            font-weight: 500;
        }
        .selection-type {
            font-size: 11px;
            color: var(--text-muted);
        }
        .selection-clear {
            margin-left: 8px;
            padding: 2px 8px;
            font-size: 11px;
            background: transparent;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            border-radius: 4px;
        }
        .selection-clear:hover {
            background: rgba(255,255,255,0.1);
            color: var(--text-primary);
        }
        
        /* Stats */
        #stats {
            position: absolute;
            top: 12px;
            left: 12px;
            font-size: 11px;
            color: var(--text-muted);
            background: rgba(18, 18, 28, 0.9);
            padding: 6px 10px;
            border-radius: 6px;
            border: 1px solid var(--border-subtle);
            z-index: 10;
            display: none;
        }
        
        /* Legend */
        .legend {
            position: absolute;
            top: 12px;
            right: 12px;
            font-size: 10px;
            background: rgba(18, 18, 28, 0.95);
            padding: 10px;
            border-radius: 8px;
            border: 1px solid var(--border-subtle);
            z-index: 10;
            display: none;
        }
        .legend-title {
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--text-primary);
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 4px 0;
            color: var(--text-secondary);
        }
        .legend-color {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            box-shadow: 0 0 4px currentColor;
        }
        
        /* Loading state */
        #loading {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            flex-direction: column;
            gap: 16px;
            color: var(--text-muted);
        }
        #loading .icon { font-size: 32px; }
        #loading button {
            margin-top: 8px;
            padding: 8px 16px;
            background: var(--accent);
            border: none;
            border-radius: 6px;
            color: white;
            cursor: pointer;
            font-size: 12px;
        }
        #loading button:hover { opacity: 0.9; }
        
        /* Panels */
        #panels {
            height: 200px;
            display: flex;
            flex-direction: column;
            border-top: 1px solid var(--border-subtle);
            background: var(--bg-elevated);
        }
        #tabs {
            display: flex;
            border-bottom: 1px solid var(--border-subtle);
        }
        .tab {
            padding: 8px 16px;
            cursor: pointer;
            border: none;
            background: transparent;
            color: var(--text-secondary);
            font-size: 12px;
            border-bottom: 2px solid transparent;
            transition: all 0.15s;
        }
        .tab:hover { color: var(--text-primary); }
        .tab.active {
            color: var(--text-primary);
            border-bottom-color: var(--accent);
        }
        .panel {
            flex: 1;
            overflow-y: auto;
            display: none;
            padding: 12px;
        }
        .panel.active { display: block; }
        .message, .log-entry { 
            padding: 8px 12px;
            margin: 4px 0;
            border-radius: 8px;
            font-size: 12px;
            line-height: 1.5;
        }
        .message.user { 
            background: rgba(124, 58, 237, 0.2);
            border-left: 3px solid var(--accent);
        }
        .message.assistant { 
            background: rgba(255, 255, 255, 0.05);
            border-left: 3px solid #10b981;
        }
        .message.error { 
            background: rgba(239, 68, 68, 0.15);
            border-left: 3px solid #ef4444;
        }
        .log-entry { color: var(--text-secondary); }
        .log-entry.thinking { color: #a78bfa; }
        .log-entry.action { color: #22d3ee; }
        .log-entry.result { color: #10b981; }
        .log-entry.error { color: #ef4444; }
        
        #input-container { 
            display: flex; 
            gap: 8px; 
            padding: 12px;
            border-top: 1px solid var(--border-subtle);
        }
        #chat-input { 
            flex: 1;
            background: var(--bg-void);
            border: 1px solid var(--border-subtle);
            color: var(--text-primary);
            padding: 10px 14px;
            border-radius: 8px;
            font-size: 13px;
            font-family: inherit;
        }
        #chat-input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 2px var(--accent-glow);
        }
        #chat-input::placeholder { color: var(--text-muted); }
        #send-btn {
            background: var(--accent);
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.15s;
        }
        #send-btn:hover { 
            background: #059669;
            transform: translateY(-1px);
        }
        
        /* Layout running indicator */
        .layout-indicator {
            position: absolute;
            bottom: 12px;
            left: 50%;
            transform: translateX(-50%);
            display: none;
            align-items: center;
            gap: 8px;
            padding: 6px 14px;
            background: rgba(16, 185, 129, 0.15);
            border: 1px solid rgba(16, 185, 129, 0.3);
            border-radius: 20px;
            backdrop-filter: blur(8px);
            z-index: 10;
        }
        .layout-indicator.visible { display: flex; }
        .layout-dot {
            width: 8px;
            height: 8px;
            background: #10b981;
            border-radius: 50%;
            animation: ping 1s infinite;
        }
        @keyframes ping {
            0% { transform: scale(1); opacity: 1; }
            75%, 100% { transform: scale(2); opacity: 0; }
        }
        .layout-text {
            font-size: 11px;
            color: #10b981;
            font-weight: 500;
        }
    </style>
</head>
<body>
    <div id="graph-container">
        <div id="loading">
            <span class="icon">🔮</span>
            <span style="font-size: 16px; font-weight: 500;">Knowledge Graph</span>
            <span style="font-size: 12px;">Run "OmniCode: Index Workspace" to generate</span>
            <button onclick="vscode.postMessage({type: 'request_graph'})">Refresh</button>
        </div>
        <div id="sigma-container" style="display: none;"></div>
        <div id="stats"></div>
        <div class="legend">
            <div class="legend-title">Node Types</div>
            <div class="legend-item"><span class="legend-color" style="background: #10b981;"></span>Folder</div>
            <div class="legend-item"><span class="legend-color" style="background: #22d3ee;"></span>File</div>
            <div class="legend-item"><span class="legend-color" style="background: #f97316;"></span>Class</div>
            <div class="legend-item"><span class="legend-color" style="background: #ef4444;"></span>Function</div>
            <div class="legend-item"><span class="legend-color" style="background: #14b8a6;"></span>Interface</div>
        </div>
        <div class="selection-bar">
            <span class="selection-dot"></span>
            <span class="selection-name"></span>
            <span class="selection-type"></span>
            <button class="selection-clear">Clear</button>
        </div>
        <div class="layout-indicator">
            <span class="layout-dot"></span>
            <span class="layout-text">Layout optimizing...</span>
        </div>
        <div class="controls">
            <button class="control-btn" id="zoom-in" title="Zoom In">+</button>
            <button class="control-btn" id="zoom-out" title="Zoom Out">−</button>
            <button class="control-btn" id="zoom-reset" title="Reset View">⟲</button>
            <button class="control-btn" id="layout-toggle" title="Toggle Layout">▶</button>
        </div>
    </div>
    <div id="panels">
        <div id="tabs">
            <button class="tab active" data-panel="chat">💬 Chat</button>
            <button class="tab" data-panel="monologue">🧠 Agent</button>
        </div>
        <div id="chat-panel" class="panel active">
            <div id="messages"></div>
        </div>
        <div id="monologue-panel" class="panel">
            <div id="monologue-log"></div>
        </div>
        <div id="input-container">
            <input type="text" id="chat-input" placeholder="Ask the agent... (e.g., 'Explain the auth flow')" />
            <button id="send-btn">Send</button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        
        // === CONFIG - Warm colors only (NO blue/violet) ===
        const NODE_COLORS = {
            folder: '#10b981',      // Emerald
            file: '#22d3ee',        // Cyan
            class: '#f97316',       // Orange
            function: '#ef4444',    // Red
            method: '#ec4899',      // Pink
            interface: '#14b8a6',   // Teal
            variable: '#64748b',    // Slate
            import: '#475569',      // Dark slate
            type: '#f59e0b',        // Amber
            struct: '#f97316',      // Orange (like class)
            enum: '#eab308',        // Yellow
            trait: '#a78bfa',       // Violet
            impl: '#c084fc',        // Purple
            namespace: '#22c55e',   // Green
            module: '#10b981',      // Emerald
            constructor: '#f43f5e', // Rose
            property: '#64748b',    // Slate
            const: '#eab308',       // Yellow
            static: '#94a3b8',      // Light slate
            record: '#f59e0b',      // Amber
            typedef: '#d946ef',     // Fuchsia
            union: '#14b8a6',       // Teal
            macro: '#f43f5e',       // Rose
            community: '#8b5cf6',   // Purple
            process: '#06b6d4'      // Cyan
        };
        
        const NODE_SIZES = {
            folder: 12,
            file: 8,
            class: 10,
            function: 6,
            method: 5,
            interface: 9,
            variable: 4,
            import: 3,
            type: 5,
            struct: 10,
            enum: 7,
            trait: 8,
            impl: 7,
            namespace: 11,
            module: 10,
            constructor: 5,
            property: 4,
            const: 4,
            static: 4,
            record: 6,
            typedef: 5,
            union: 6,
            macro: 5,
            community: 10,
            process: 8
        };
        
        // Warm community colors - NO blue/violet
        const COMMUNITY_COLORS = [
            '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
            '#10b981', '#f59e0b', '#d946ef', '#ec4899', '#f43f5e'
        ];
        
        // Edge colors - NO blue/violet (GitNexus-style)
        const EDGE_COLORS = {
            contains: '#2d5a3d',
            defines: '#059669',
            imports: '#14b8a6',
            calls: '#f97316',
            extends: '#c2410c',
            implements: '#be185d',
            has_method: '#ec4899',
            member_of: '#f59e0b',
            participates_in: '#8b5cf6',
            // Legacy aliases
            import: '#14b8a6',
            call: '#f97316'
        };
        
        // === STATE ===
        let sigma = null;
        let graph = null;
        let layoutWorker = null;
        let isLayoutRunning = false;
        let selectedNode = null;
        let highlightedNodes = new Set();
        let rawGraphData = null;
        let sigmaReady = typeof window.Sigma !== 'undefined';
        
        // === DOM ELEMENTS ===
        const container = document.getElementById('sigma-container');
        const loadingEl = document.getElementById('loading');
        const statsEl = document.getElementById('stats');
        const legendEl = document.querySelector('.legend');
        const selectionBar = document.querySelector('.selection-bar');
        const layoutIndicator = document.querySelector('.layout-indicator');
        const messagesEl = document.getElementById('messages');
        const monologueEl = document.getElementById('monologue-log');
        const inputEl = document.getElementById('chat-input');
        
        // === GRAPH BUILDING (GitNexus style) ===
        function buildGraphology(data) {
            console.log('Building graphology from data:', data.nodes.length, 'nodes');
            
            if (!data.nodes || data.nodes.length === 0) {
                console.error('No nodes in data!');
                return null;
            }
            
            const g = new graphology.Graph();
            const nodeCount = data.nodes.length;
            
            // Build parent-child relationships (GitNexus-style: contains, defines, has_method)
            // Priority: has_method > defines > contains (methods should cluster with their class)
            const parentToChildren = new Map();
            const childToParent = new Map();
            
            data.edges.forEach(edge => {
                if (['contains', 'defines', 'has_method'].includes(edge.type)) {
                    // Prefer has_method edges for positioning (methods near class)
                    const existingParent = childToParent.get(edge.target);
                    if (!existingParent || edge.type === 'has_method') {
                        childToParent.set(edge.target, edge.source);
                        
                        if (!parentToChildren.has(edge.source)) {
                            parentToChildren.set(edge.source, []);
                        }
                        parentToChildren.get(edge.source).push(edge.target);
                    }
                }
            });
            
            // Spread factor based on graph size
            const spread = Math.sqrt(nodeCount) * 30;
            const childJitter = Math.sqrt(nodeCount) * 5;
            
            // Position map
            const positions = new Map();
            
            // Golden angle for even distribution
            const goldenAngle = Math.PI * (3 - Math.sqrt(5));
            
            // Separate structural vs content nodes
            const structuralTypes = new Set(['folder', 'file']);
            const structuralNodes = data.nodes.filter(n => structuralTypes.has(n.type));
            const contentNodes = data.nodes.filter(n => !structuralTypes.has(n.type));
            
            // Position structural nodes first (radial pattern)
            structuralNodes.forEach((node, i) => {
                const angle = i * goldenAngle;
                const radius = spread * Math.sqrt((i + 1) / structuralNodes.length);
                const jitter = spread * 0.1;
                
                const x = radius * Math.cos(angle) + (Math.random() - 0.5) * jitter;
                const y = radius * Math.sin(angle) + (Math.random() - 0.5) * jitter;
                
                positions.set(node.id, { x, y });
                
                const size = getNodeSize(node.type, nodeCount);
                const color = node.cluster !== undefined 
                    ? COMMUNITY_COLORS[node.cluster % COMMUNITY_COLORS.length]
                    : NODE_COLORS[node.type] || '#6b7280';
                
                g.addNode(node.id, {
                    x: x || 0,
                    y: y || 0,
                    size: size || 6,
                    color: color || '#6b7280',
                    label: node.name || node.id,
                    nodeType: node.type || 'unknown',
                    filePath: node.path || '',
                    cluster: node.cluster ?? -1
                });
            });
            
            // Position content nodes near their parents
            contentNodes.forEach((node, i) => {
                const parentId = childToParent.get(node.id);
                const parentPos = parentId ? positions.get(parentId) : null;
                
                let x, y;
                if (parentPos) {
                    x = parentPos.x + (Math.random() - 0.5) * childJitter;
                    y = parentPos.y + (Math.random() - 0.5) * childJitter;
                } else {
                    // Orphan node - position randomly
                    x = (Math.random() - 0.5) * spread * 0.5;
                    y = (Math.random() - 0.5) * spread * 0.5;
                }
                
                positions.set(node.id, { x, y });
                
                const size = getNodeSize(node.type, nodeCount);
                const color = node.cluster !== undefined 
                    ? COMMUNITY_COLORS[node.cluster % COMMUNITY_COLORS.length]
                    : NODE_COLORS[node.type] || '#6b7280';
                
                g.addNode(node.id, {
                    x: x || 0,
                    y: y || 0,
                    size: size || 6,
                    color: color || '#6b7280',
                    label: node.name || node.id,
                    nodeType: node.type || 'unknown',
                    filePath: node.path || '',
                    cluster: node.cluster ?? -1
                });
            });
            
            console.log('Added', g.order, 'nodes to graph');
            
            // Add edges with curved styling - each edge gets random curvature
            const edgeSize = nodeCount > 5000 ? 0.3 : nodeCount > 1000 ? 0.5 : 0.8;

            data.edges.forEach((edge, i) => {
                if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
                    if (!g.hasEdge(edge.source, edge.target)) {
                        const color = EDGE_COLORS[edge.type] || '#3a3a4a';
                        g.addEdge(edge.source, edge.target, {
                            size: edgeSize,
                            color,
                            edgeType: edge.type
                        });
                    }
                }
            });
            
            return g;
        }
        
        function getNodeSize(type, nodeCount) {
            const base = NODE_SIZES[type] || 6;
            // Scale down for large graphs
            if (nodeCount > 5000) return Math.max(2, base * 0.5);
            if (nodeCount > 1000) return Math.max(3, base * 0.7);
            return base;
        }
        
        // === SIGMA RENDERER ===
        function renderGraph() {
            console.log('renderGraph called, rawGraphData:', rawGraphData);
            
            if (!rawGraphData) {
                console.error('No graph data to render!');
                return;
            }
            
            if (!rawGraphData.nodes || rawGraphData.nodes.length === 0) {
                console.error('Graph data has no nodes!');
                loadingEl.innerHTML = '<span class="icon">⚠️</span><span>No files found in workspace</span>';
                return;
            }
            
            // Wait for Sigma to load if not ready
            if (typeof Sigma === 'undefined') {
                console.log('Waiting for Sigma to load...');
                loadingEl.innerHTML = '<span class="icon">🔮</span><span>Loading graph renderer...</span>';
                setTimeout(renderGraph, 100);
                return;
            }
            
            container.style.display = 'block';
            loadingEl.style.display = 'none';
            statsEl.style.display = 'block';
            legendEl.style.display = 'block';
            
            statsEl.textContent = rawGraphData.nodes.length + ' nodes · ' + rawGraphData.edges.length + ' edges';
            
            console.log('Creating graph with', rawGraphData.nodes.length, 'nodes');
            
            // Destroy previous instance
            if (sigma) {
                sigma.kill();
                sigma = null;
            }
            
            // Build graphology graph
            graph = buildGraphology(rawGraphData);
            
            if (!graph) {
                console.error('Failed to build graph!');
                loadingEl.innerHTML = '<span class="icon">❌</span><span>Failed to build graph</span>';
                return;
            }
            
            console.log('Graph built successfully, node count:', graph.order);

            // Ensure container has dimensions before creating Sigma
            container.style.width = '100%';
            container.style.height = '100%';

            try {
                // Create Sigma instance (v3 compatible)
                sigma = new Sigma(graph, container, {
                renderLabels: true,
                labelFont: 'JetBrains Mono, monospace',
                labelSize: 11,
                labelWeight: '500',
                labelColor: { color: '#e4e4ed' },
                labelRenderedSizeThreshold: 6,
                labelDensity: 0.15,

                defaultNodeColor: '#6b7280',
                defaultEdgeColor: '#2a2a3a',

                minCameraRatio: 0.01,
                maxCameraRatio: 100,
                
                nodeReducer: (node, data) => {
                    const res = { ...data };
                    
                    // Highlight effect
                    if (highlightedNodes.has(node)) {
                        res.color = '#ffd700';
                        res.size = (data.size || 6) * 1.5;
                    }
                    
                    // Selected node effect
                    if (selectedNode === node) {
                        res.color = '#22d3ee';
                        res.size = (data.size || 6) * 1.8;
                    }
                    
                    return res;
                },
                
                edgeReducer: (edge, data) => {
                    const res = { ...data };

                    // Dim edges not connected to selected node
                    if (selectedNode) {
                        const source = graph.source(edge);
                        const target = graph.target(edge);
                        if (source !== selectedNode && target !== selectedNode) {
                            res.color = '#1a1a24';
                            res.size = 0.2;
                        } else {
                            res.size = 1.5;
                        }
                    }
                    
                    return res;
                }
            });
            
            // Event handlers
            sigma.on('clickNode', ({ node }) => {
                selectNode(node);
                vscode.postMessage({ type: 'node_click', nodeId: node });
            });

            sigma.on('clickStage', () => {
                clearSelection();
            });

            // Reset camera to show all nodes
            sigma.getCamera().animatedReset({ duration: 0 });

            // Run initial ForceAtlas2 layout
            startLayout();
            } catch (error) {
                console.error('Failed to create Sigma instance:', error);
                loadingEl.innerHTML = '<span class="icon">❌</span><span>Failed to render graph: ' + (error.message || 'Unknown error') + '</span>';
                loadingEl.style.display = 'flex';
                container.style.display = 'none';
            }
        }
        
        function selectNode(nodeId) {
            selectedNode = nodeId;
            const data = graph.getNodeAttributes(nodeId);
            
            selectionBar.classList.add('visible');
            selectionBar.querySelector('.selection-name').textContent = data.label;
            selectionBar.querySelector('.selection-type').textContent = '(' + data.nodeType + ')';
            
            sigma.refresh();
        }
        
        function clearSelection() {
            selectedNode = null;
            selectionBar.classList.remove('visible');
            sigma.refresh();
        }

        // Optimized force layout using Barnes-Hut approximation
        function simpleForceLayout(iterations = 50) {
            if (!graph) return;

            const nodeCount = graph.order;
            if (nodeCount === 0) return;

            // Build node lookup map once
            const nodeMap = new Map();
            graph.forEachNode((id, attrs) => {
                nodeMap.set(id, { id, x: attrs.x || 0, y: attrs.y || 0 });
            });

            // Build edge adjacency map once
            const edgeMap = new Map();
            graph.forEachEdge((edge, attrs, source, target) => {
                if (!edgeMap.has(source)) edgeMap.set(source, []);
                if (!edgeMap.has(target)) edgeMap.set(target, []);
                edgeMap.get(source).push(target);
                edgeMap.get(target).push(source);
            });

            const theta = 1.5; // Barnes-Hut approximation parameter
            const k = Math.sqrt(nodeCount * 200) / 2;
            const k2 = k * k;
            const gravity = 0.1;

            for (let iter = 0; iter < iterations; iter++) {
                const cooling = 1 - iter / iterations;
                
                // Apply forces using Barnes-Hut approximation
                const nodes = Array.from(nodeMap.values());
                const forces = new Map(nodes.map(n => [n.id, { fx: 0, fy: 0 }]));

                // Repulsive forces - only between nearby nodes (simplified)
                const spatialIndex = new Map();
                const cellSize = k * 2;
                
                // Build spatial grid
                nodes.forEach(n => {
                    const cellX = Math.floor(n.x / cellSize);
                    const cellY = Math.floor(n.y / cellSize);
                    const key = cellX + ',' + cellY;
                    if (!spatialIndex.has(key)) spatialIndex.set(key, []);
                    spatialIndex.get(key).push(n);
                });

                // Repulsive from neighbors only
                nodes.forEach(n1 => {
                    const cellX = Math.floor(n1.x / cellSize);
                    const cellY = Math.floor(n1.y / cellSize);
                    
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            const key = (cellX + dx) + ',' + (cellY + dy);
                            const cell = spatialIndex.get(key);
                            if (!cell) continue;
                            
                            cell.forEach(n2 => {
                                if (n1.id === n2.id) return;
                                const ddx = n1.x - n2.x;
                                const ddy = n1.y - n2.y;
                                let dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
                                const force = k2 / dist * cooling * 0.01;
                                const f = forces.get(n1.id);
                                f.fx += (ddx / dist) * force;
                                f.fy += (ddy / dist) * force;
                            });
                        }
                    }
                });

                // Attractive forces (along edges only - O(m))
                graph.forEachEdge((edge, attrs, source, target) => {
                    const s = nodeMap.get(source);
                    const t = nodeMap.get(target);
                    if (!s || !t) return;
                    
                    const ddx = t.x - s.x;
                    const ddy = t.y - s.y;
                    let dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
                    const force = dist / k * cooling * 0.1;
                    
                    forces.get(s.id).fx += (ddx / dist) * force;
                    forces.get(s.id).fy += (ddy / dist) * force;
                    forces.get(t.id).fx -= (ddx / dist) * force;
                    forces.get(t.id).fy -= (ddy / dist) * force;
                });

                // Gravity and apply forces
                nodes.forEach(n => {
                    const f = forces.get(n.id);
                    f.fx -= n.x * gravity;
                    f.fy -= n.y * gravity;
                    
                    const maxMove = 10 * cooling;
                    const move = Math.sqrt(f.fx * f.fx + f.fy * f.fy);
                    if (move > maxMove) {
                        f.fx = (f.fx / move) * maxMove;
                        f.fy = (f.fy / move) * maxMove;
                    }
                    
                    n.x += f.fx;
                    n.y += f.fy;
                    graph.setNodeAttribute(n.id, 'x', n.x);
                    graph.setNodeAttribute(n.id, 'y', n.y);
                });
            }
        }

        function startLayout() {
            if (!graph || isLayoutRunning) return;

            stopLayout();

            const nodeCount = graph.order;
            if (nodeCount === 0) return;

            isLayoutRunning = true;
            layoutIndicator.classList.add('visible');
            document.getElementById('layout-toggle').classList.add('active');
            document.getElementById('layout-toggle').textContent = '⏸';

            // Adaptive iterations based on graph size - keep UI responsive
            let iteration = 0;
            const maxIterations = nodeCount < 100 ? 30 : nodeCount < 500 ? 20 : 15;
            const itersPerFrame = nodeCount < 500 ? 3 : 1;
            const frameInterval = nodeCount < 500 ? 16 : 32; // ms

            let lastFrameTime = 0;
            
            function layoutFrame() {
                if (!isLayoutRunning || !graph) {
                    stopLayout();
                    return;
                }

                const now = performance.now();
                if (now - lastFrameTime < frameInterval) {
                    layoutWorker.rafId = requestAnimationFrame(layoutFrame);
                    return;
                }
                lastFrameTime = now;

                simpleForceLayout(itersPerFrame);
                if (sigma) sigma.refresh();

                iteration += itersPerFrame;
                if (iteration >= maxIterations) {
                    stopLayout();
                    return;
                }

                layoutWorker.rafId = requestAnimationFrame(layoutFrame);
            }

            layoutWorker = {
                rafId: requestAnimationFrame(layoutFrame)
            };
        }
        
        function stopLayout() {
            if (layoutWorker) {
                if (layoutWorker.rafId) {
                    cancelAnimationFrame(layoutWorker.rafId);
                }
                if (layoutWorker.interval) {
                    clearInterval(layoutWorker.interval);
                }
                layoutWorker = null;
            }

            isLayoutRunning = false;
            layoutIndicator.classList.remove('visible');
            document.getElementById('layout-toggle').classList.remove('active');
            document.getElementById('layout-toggle').textContent = '▶';
        }
        
        // === ZOOM CONTROLS ===
        document.getElementById('zoom-in').addEventListener('click', () => {
            if (sigma) {
                const camera = sigma.getCamera();
                camera.animatedZoom({ ratio: camera.ratio / 1.5 });
            }
        });
        
        document.getElementById('zoom-out').addEventListener('click', () => {
            if (sigma) {
                const camera = sigma.getCamera();
                camera.animatedZoom({ ratio: camera.ratio * 1.5 });
            }
        });
        
        document.getElementById('zoom-reset').addEventListener('click', () => {
            if (sigma) {
                sigma.getCamera().animatedReset();
            }
        });
        
        document.getElementById('layout-toggle').addEventListener('click', () => {
            if (isLayoutRunning) {
                stopLayout();
            } else {
                startLayout();
            }
        });
        
        document.querySelector('.selection-clear').addEventListener('click', clearSelection);
        
        // === TAB SWITCHING ===
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.panel + '-panel').classList.add('active');
            });
        });
        
        // === MESSAGE HANDLING ===
        console.log('Webview initialized, requesting graph...');
        vscode.postMessage({ type: 'ready' });
        
        window.addEventListener('message', event => {
            const message = event.data;
            console.log('Received message:', message.type, message);
            
            switch (message.type) {
                case 'graph_data':
                    console.log('Got graph data:', message.data.nodes.length, 'nodes', message.data.edges.length, 'edges');
                    rawGraphData = message.data;
                    renderGraph();
                    break;
                case 'monologue':
                    addLogEntry(message.data.type, message.data.text);
                    break;
                case 'chat_response':
                    addMessage(message.data.role, message.data.content);
                    break;
                case 'highlight_nodes':
                    highlightedNodes = new Set(message.data.nodeIds);
                    if (sigma) sigma.refresh();
                    break;
            }
        });
        
        function addMessage(role, content) {
            const div = document.createElement('div');
            div.className = 'message ' + role;
            div.textContent = content;
            messagesEl.appendChild(div);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        
        function addLogEntry(type, content) {
            const icons = { thinking: '💭', action: '⚡', result: '✅', error: '❌' };
            const div = document.createElement('div');
            div.className = 'log-entry ' + type;
            div.textContent = (icons[type] || '•') + ' ' + content;
            monologueEl.appendChild(div);
            monologueEl.scrollTop = monologueEl.scrollHeight;
            
            // Auto-switch to agent tab on actions/errors
            if (type === 'action' || type === 'error') {
                document.querySelector('[data-panel="monologue"]').click();
            }
        }
        
        function sendMessage() {
            const text = inputEl.value.trim();
            if (!text) return;
            addMessage('user', text);
            vscode.postMessage({ type: 'chat_message', text });
            inputEl.value = '';
        }
        
        document.getElementById('send-btn').addEventListener('click', sendMessage);
        inputEl.addEventListener('keypress', e => {
            if (e.key === 'Enter') sendMessage();
        });
        
        // Handle resize
        window.addEventListener('resize', () => {
            if (sigma) sigma.refresh();
        });
    </script>
</body>
</html>`;
    }
}
