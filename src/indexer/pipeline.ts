/**
 * Pipeline - Orchestrates all 6 phases of code analysis
 * Combines GitNexus-style multi-phase processing into a unified pipeline
 */

import * as vscode from 'vscode';
import { GraphNode, GraphEdge, KnowledgeGraph, ClusterInfo } from './IndexerService';

// Phase 1: Structure
import { FilesystemWalker, WalkResult } from './filesystem-walker';
import { StructureProcessor, ProcessedStructure } from './structure-processor';

// Phase 2: Parsing
import { ParsingProcessor, ParsedSymbol } from './parsing-processor';
import { TreeSitterQueries } from './tree-sitter-queries';

// Phase 3: Resolution
import { ImportProcessor } from './import-processor';
import { CallProcessor, SymbolReference } from './call-processor';

// Phase 4: Clustering
import { CommunityProcessor, CommunityDetectionResult } from './community-processor';
import { ClusterEnricher, EnrichedCluster } from './cluster-enricher';

// Phase 5: Process/Execution
import { ProcessProcessor, ProcessInfo } from './process-processor';

// Phase 6: Search (built-in to IndexerService)

export interface PipelineProgress {
    phase: number;
    phaseName: string;
    message: string;
    increment?: number;
}

export interface PipelineConfig {
    excludePatterns: string[];
    maxFileSize?: number;
    supportedLanguages?: string[];
}

export class Pipeline {
    private fsWalker: FilesystemWalker;
    private structureProcessor: StructureProcessor;
    private parsingProcessor: ParsingProcessor;
    private treeSitterQueries: TreeSitterQueries;
    private importProcessor: ImportProcessor;
    private callProcessor: CallProcessor;
    private communityProcessor: CommunityProcessor;
    private clusterEnricher: ClusterEnricher;
    private processProcessor: ProcessProcessor;

    constructor() {
        // Initialize all processors
        this.fsWalker = new FilesystemWalker();
        this.structureProcessor = new StructureProcessor();
        this.parsingProcessor = new ParsingProcessor();
        this.treeSitterQueries = new TreeSitterQueries();
        this.importProcessor = new ImportProcessor();
        this.callProcessor = new CallProcessor();
        this.communityProcessor = new CommunityProcessor();
        this.clusterEnricher = new ClusterEnricher();
        this.processProcessor = new ProcessProcessor();
    }

    /**
     * Fast structure-only execution - just file/folder nodes
     * Completes in <1 second for most projects
     */
    async executeStructureOnly(
        rootPath: string,
        config: PipelineConfig
    ): Promise<KnowledgeGraph> {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        
        // Only Phase 1: Structure
        const walkResult = await this.fsWalker.walk(rootPath, config.excludePatterns);
        const structure = this.structureProcessor.process(
            walkResult.files,
            rootPath,
            (path, root) => this.fsWalker.getFileInfo(path, root)
        );

        nodes.push(...structure.nodes);
        edges.push(...structure.edges);

        return {
            nodes,
            edges,
            clusters: [],
            metadata: {
                indexedAt: new Date().toISOString(),
                fileCount: walkResult.files.length,
                symbolCount: 0,
                languages: Array.from(walkResult.languages)
            }
        };
    }

    /**
     * Full pipeline execution with all 6 phases
     */
    async execute(
        rootPath: string,
        progress: vscode.Progress<PipelineProgress>,
        token: vscode.CancellationToken,
        config: PipelineConfig
    ): Promise<KnowledgeGraph> {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        let languages: Set<string> = new Set();
        let fileCount = 0;
        let symbolCount = 0;

        // Helper to report progress
        const report = (phase: number, phaseName: string, message: string, increment?: number) => {
            progress.report({ phase, phaseName, message, increment });
        };

        // ================================================================
        // PHASE 1: Structure - Walk file tree and create file/folder nodes
        // ================================================================
        report(1, 'Structure', 'Scanning file structure...');

        if (token.isCancellationRequested) {
            throw new Error('Indexing cancelled');
        }

        const walkResult = await this.fsWalker.walk(rootPath, config.excludePatterns);
        const structure = this.structureProcessor.process(
            walkResult.files,
            rootPath,
            (path, root) => this.fsWalker.getFileInfo(path, root)
        );

        nodes.push(...structure.nodes);
        edges.push(...structure.edges);
        fileCount = walkResult.files.length;
        languages = walkResult.languages;

        report(1, 'Structure', `Found ${fileCount} files`, 16);

        // ================================================================
        // PHASE 2: Parsing - Extract symbols from files
        // ================================================================
        report(2, 'Parsing', 'Extracting symbols from files...');

        if (token.isCancellationRequested) {
            throw new Error('Indexing cancelled');
        }

        const symbolsByFile = await this.parsingProcessor.parseFiles(
            walkResult.files,
            rootPath,
            (msg, current, total) => report(2, 'Parsing', msg)
        );

        // Convert to symbol references for later phases
        const symbolReferences = this.buildSymbolReferences(symbolsByFile, rootPath);

        // Add symbol nodes with CONTAINS edges
        for (const [filePath, symbols] of symbolsByFile.entries()) {
            const relativePath = this.getRelativePath(filePath, rootPath);

            for (const symbol of symbols) {
                symbolCount++;
                const symbolId = `symbol:${relativePath}:${symbol.name}`;

                nodes.push({
                    id: symbolId,
                    name: symbol.name,
                    type: this.mapSymbolType(symbol.type),
                    path: filePath,
                    location: symbol.location,
                    metadata: symbol.metadata
                });

                // Add CONTAINS edge from file to symbol
                edges.push({
                    source: `file:${relativePath}`,
                    target: symbolId,
                    type: 'contains',
                    weight: 1
                });
            }
        }

        report(2, 'Parsing', `Found ${symbolCount} symbols`, 16);

        // ================================================================
        // PHASE 3: Resolution - Resolve imports and calls
        // ================================================================
        report(3, 'Resolution', 'Resolving imports and references...');

        if (token.isCancellationRequested) {
            throw new Error('Indexing cancelled');
        }

        // Process imports - create IMPORTS edges
        const importEdges = await this.importProcessor.process(
            walkResult.files,
            rootPath,
            (msg, current, total) => report(3, 'Resolution', msg)
        );
        edges.push(...importEdges);

        // Process calls - create CALLS edges between functions
        const callEdges = await this.callProcessor.process(
            walkResult.files,
            rootPath,
            symbolReferences,
            (msg, current, total) => report(3, 'Resolution', msg)
        );
        edges.push(...callEdges);

        report(3, 'Resolution', `Found ${importEdges.length + callEdges.length} references`, 16);

        // ================================================================
        // PHASE 4: Clustering - Group related symbols into communities
        // ================================================================
        report(4, 'Clustering', 'Detecting functional communities...');

        if (token.isCancellationRequested) {
            throw new Error('Indexing cancelled');
        }

        const communityResult = this.communityProcessor.process(nodes, edges);

        // Assign clusters to nodes
        for (const node of nodes) {
            node.cluster = communityResult.nodeClusterMap.get(node.id);
        }

        // Enrich clusters with metadata
        const enrichedClusters = this.clusterEnricher.enrich(
            communityResult.clusters,
            nodes,
            edges,
            communityResult.nodeClusterMap
        );

        report(4, 'Clustering', `Found ${communityResult.clusters.length} clusters`, 16);

        // ================================================================
        // PHASE 5: Process - Trace execution flows
        // ================================================================
        report(5, 'Execution', 'Tracing execution flows...');

        if (token.isCancellationRequested) {
            throw new Error('Indexing cancelled');
        }

        const processInfo = this.processProcessor.process(nodes, edges);

        // Calculate connection counts
        const connectionCounts = this.calculateConnections(nodes, edges);
        for (const node of nodes) {
            node.connections = connectionCounts.get(node.id) || 0;
        }

        report(5, 'Execution', 'Execution flows traced', 16);

        // ================================================================
        // PHASE 6: Search - Already handled by IndexerService using Fuse.js
        // ================================================================
        report(6, 'Search', 'Indexing complete...', 20);

        // Build final graph
        const graph: KnowledgeGraph = {
            nodes,
            edges,
            clusters: enrichedClusters.map(c => ({
                id: c.id,
                name: c.name,
                color: c.color,
                nodeCount: c.nodeCount
            })),
            metadata: {
                indexedAt: new Date().toISOString(),
                fileCount,
                symbolCount,
                languages: Array.from(languages)
            }
        };

        return graph;
    }

    private buildSymbolReferences(
        symbolsByFile: Map<string, ParsedSymbol[]>,
        rootPath: string
    ): Map<string, SymbolReference[]> {
        const result = new Map<string, SymbolReference[]>();

        for (const [filePath, symbols] of symbolsByFile.entries()) {
            const refs: SymbolReference[] = symbols.map(s => ({
                name: s.name,
                filePath,
                type: this.mapSymbolType(s.type) as 'function' | 'class' | 'interface' | 'method',
                location: s.location
            }));
            result.set(filePath, refs);
        }

        return result;
    }

    private getRelativePath(filePath: string, rootPath: string): string {
        // Simple path relative calculation
        const normalizedRoot = rootPath.replace(/\\/g, '/');
        const normalizedFile = filePath.replace(/\\/g, '/');

        if (normalizedFile.startsWith(normalizedRoot)) {
            return normalizedFile.substring(normalizedRoot.length).replace(/^\//, '');
        }
        return filePath;
    }

    private mapSymbolType(type: string): GraphNode['type'] {
        const typeMap: Record<string, GraphNode['type']> = {
            'function': 'function',
            'class': 'class',
            'interface': 'interface',
            'method': 'method',
            'variable': 'variable',
            'type': 'interface'
        };
        return typeMap[type] || 'variable';
    }

    private calculateConnections(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
        const counts = new Map<string, number>();

        for (const edge of edges) {
            counts.set(edge.source, (counts.get(edge.source) || 0) + 1);
            counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
        }

        return counts;
    }
}
