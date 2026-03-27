import * as vscode from 'vscode';
import Fuse from 'fuse.js';

// Pipeline imports
import { Pipeline } from './pipeline';
import { PipelineProgress } from './pipeline';

export interface GraphNode {
    id: string;
    name: string;
    type: 'file' | 'folder' | 'class' | 'function' | 'interface' | 'variable' | 'method';
    path?: string;
    cluster?: number;
    connections?: number;
    location?: { line: number; column: number };
    metadata?: Record<string, unknown>;
}

export interface GraphEdge {
    source: string;
    target: string;
    type: 'imports' | 'calls' | 'extends' | 'implements' | 'contains' | 'exports';
    weight?: number;
}

export interface KnowledgeGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    clusters: ClusterInfo[];
    metadata: {
        indexedAt: string;
        fileCount: number;
        symbolCount: number;
        languages: string[];
    };
}

export interface ClusterInfo {
    id: number;
    name: string;
    color: string;
    nodeCount: number;
}

export class IndexerService {
    private currentGraph: KnowledgeGraph | null = null;
    private searchIndex: Fuse<GraphNode> | null = null;
    private pipeline: Pipeline;

    constructor(context: vscode.ExtensionContext) {
        this.pipeline = new Pipeline();
    }

    /**
     * Fast structure-only indexing - shows graph immediately
     * Only scans file/folder structure (< 1 second)
     */
    async indexStructureOnly(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<KnowledgeGraph> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        const rootPath = workspaceFolder.uri.fsPath;
        const config = vscode.workspace.getConfiguration('omnicode');
        const excludePatterns = config.get<string[]>('indexer.excludePatterns', []);

        progress.report({ message: 'Scanning file structure...', increment: 10 });

        const graph = await this.pipeline.executeStructureOnly(
            rootPath,
            { excludePatterns }
        );

        progress.report({ message: 'Structure indexed!', increment: 90 });

        this.currentGraph = graph;
        this.buildSearchIndex(graph.nodes);
        return graph;
    }

    /**
     * Full workspace indexing with all analysis phases
     * Use this in background after showing initial structure
     */
    async indexWorkspace(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<KnowledgeGraph> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        const rootPath = workspaceFolder.uri.fsPath;

        // Load exclude patterns from config
        const config = vscode.workspace.getConfiguration('omnicode');
        const excludePatterns = config.get<string[]>('indexer.excludePatterns', []);

        // Wrap progress to convert PipelineProgress to simple progress
        const pipelineProgress: vscode.Progress<PipelineProgress> = {
            report: (p: PipelineProgress) => {
                progress.report({ message: `${p.phaseName}: ${p.message}`, increment: p.increment });
            }
        };

        // Execute the pipeline
        const graph = await this.pipeline.execute(
            rootPath,
            pipelineProgress,
            token,
            { excludePatterns }
        );

        // Build search index
        this.buildSearchIndex(graph.nodes);

        this.currentGraph = graph;
        return graph;
    }

    private buildSearchIndex(nodes: GraphNode[]): void {
        this.searchIndex = new Fuse(nodes, {
            keys: ['name', 'path', 'type'],
            threshold: 0.3,
            includeScore: true,
            ignoreLocation: true,
        });
    }

    // Search nodes using fuzzy search
    searchNodes(query: string, limit: number = 50): GraphNode[] {
        if (!this.currentGraph) return [];

        if (this.searchIndex) {
            const results = this.searchIndex.search(query, { limit });
            return results.map(r => r.item);
        }

        const lowerQuery = query.toLowerCase();
        return this.currentGraph.nodes
            .filter(node =>
                node.name.toLowerCase().includes(lowerQuery) ||
                node.path?.toLowerCase().includes(lowerQuery)
            )
            .slice(0, limit);
    }

    getCallGraph(symbolName: string): { symbol: GraphNode | null; callers: GraphNode[]; callees: GraphNode[] } {
        if (!this.currentGraph) return { symbol: null, callers: [], callees: [] };

        const symbol = this.currentGraph.nodes.find(n => n.name === symbolName);
        if (!symbol) return { symbol: null, callers: [], callees: [] };

        const callers: GraphNode[] = [];
        const callees: GraphNode[] = [];

        for (const edge of this.currentGraph.edges) {
            if (edge.target === symbol.id && edge.type === 'calls') {
                const caller = this.currentGraph.nodes.find(n => n.id === edge.source);
                if (caller) callers.push(caller);
            }
            if (edge.source === symbol.id && edge.type === 'calls') {
                const callee = this.currentGraph.nodes.find(n => n.id === edge.target);
                if (callee) callees.push(callee);
            }
        }

        return { symbol, callers, callees };
    }

    findImpactRadius(symbolName: string): { directly: GraphNode[]; transitively: GraphNode[] } {
        if (!this.currentGraph) return { directly: [], transitively: [] };

        const symbol = this.currentGraph.nodes.find(n => n.name === symbolName);
        if (!symbol) return { directly: [], transitively: [] };

        const directly: Set<string> = new Set();
        const transitively: Set<string> = new Set();

        const queue: { id: string; depth: number }[] = [{ id: symbol.id, depth: 0 }];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const { id, depth } = queue.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);

            for (const edge of this.currentGraph.edges) {
                if (edge.target === id && ['imports', 'calls', 'extends', 'implements'].includes(edge.type)) {
                    if (depth === 0) {
                        directly.add(edge.source);
                    } else {
                        transitively.add(edge.source);
                    }
                    queue.push({ id: edge.source, depth: depth + 1 });
                }
            }
        }

        for (const id of directly) {
            transitively.delete(id);
        }

        return {
            directly: Array.from(directly).map(id => this.currentGraph!.nodes.find(n => n.id === id)!).filter(Boolean),
            transitively: Array.from(transitively).map(id => this.currentGraph!.nodes.find(n => n.id === id)!).filter(Boolean),
        };
    }

    getClusterInfo(clusterId: number): ClusterInfo | null {
        return this.currentGraph?.clusters.find(c => c.id === clusterId) || null;
    }

    getNodesInCluster(clusterId: number): GraphNode[] {
        if (!this.currentGraph) return [];
        return this.currentGraph.nodes.filter(n => n.cluster === clusterId);
    }

    getArchitectureSummary(): {
        clusters: ClusterInfo[];
        entryPoints: GraphNode[];
        mostConnected: GraphNode[];
        languages: string[];
    } {
        if (!this.currentGraph) {
            return { clusters: [], entryPoints: [], mostConnected: [], languages: [] };
        }

        const entryPoints = this.currentGraph.nodes
            .filter(n => n.type === 'file' && (
                n.name.includes('main') ||
                n.name.includes('index') ||
                n.name.includes('app') ||
                n.name.includes('server')
            ))
            .slice(0, 10);

        const mostConnected = [...this.currentGraph.nodes]
            .sort((a, b) => (b.connections || 0) - (a.connections || 0))
            .slice(0, 10);

        return {
            clusters: this.currentGraph.clusters,
            entryPoints,
            mostConnected,
            languages: this.currentGraph.metadata.languages,
        };
    }

    getNodeById(id: string): GraphNode | undefined {
        return this.currentGraph?.nodes.find(n => n.id === id);
    }

    getEdgesForNode(nodeId: string): GraphEdge[] {
        if (!this.currentGraph) return [];
        return this.currentGraph.edges.filter(e =>
            e.source === nodeId || e.target === nodeId
        );
    }

    getGraph(): KnowledgeGraph | null {
        return this.currentGraph;
    }

    getAllClusters(): ClusterInfo[] {
        return this.currentGraph?.clusters || [];
    }
}
