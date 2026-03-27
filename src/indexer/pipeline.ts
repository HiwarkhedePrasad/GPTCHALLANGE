/**
 * Pipeline — Orchestrates all 6 phases of code analysis.
 *
 * KEY CHANGE: Phase 0 loads every source file into a FileCache (RAM).
 * Phases 2, 3a, 3b receive the cache instead of reading disk independently.
 *
 * Disk read count:  BEFORE → files × 3 processors  (e.g. 500 files = 1500 reads)
 *                   AFTER  → files × 1              (e.g. 500 files = 500 reads)
 *
 * Memory cost:  ~10–40 MB for a typical 500-file repo (well within VS Code limits).
 * The cache is released (GC'd) as soon as pipeline.execute() returns.
 */

import * as vscode from 'vscode';
import { GraphNode, GraphEdge, KnowledgeGraph, NodeType } from './IndexerService';

import { FileCache } from './FileCache';

import { FilesystemWalker }   from './filesystem-walker';
import { StructureProcessor } from './structure-processor';
import { ParsingProcessor }   from './parsing-processor';
import { ImportProcessor }    from './import-processor';
import { CallProcessor }      from './call-processor';
import { CommunityProcessor, getCommunityColor } from './community-processor';
import { ClusterEnricher }    from './cluster-enricher';
import { ProcessProcessor }   from './process-processor';

export interface PipelineProgress {
    phase: number;
    phaseName: string;
    message: string;
    increment?: number;
}

export interface PipelineConfig {
    excludePatterns: string[];
    maxFileSize?: number;       // bytes; default 512 KB
    supportedLanguages?: string[];
}

/**
 * Deduplication layer for graph construction (GitNexus-style)
 */
class GraphBuilder {
    private readonly nodeMap = new Map<string, GraphNode>();
    private readonly edgeMap = new Map<string, GraphEdge>();

    addNode(node: GraphNode): boolean {
        if (this.nodeMap.has(node.id)) return false;
        this.nodeMap.set(node.id, node);
        return true;
    }

    addEdge(edge: GraphEdge): boolean {
        const key = `${edge.source}-${edge.type}-${edge.target}`;
        if (this.edgeMap.has(key)) return false;
        this.edgeMap.set(key, edge);
        return true;
    }

    get nodes(): GraphNode[] {
        return Array.from(this.nodeMap.values());
    }

    get edges(): GraphEdge[] {
        return Array.from(this.edgeMap.values());
    }
}

export class Pipeline {
    private readonly fsWalker          = new FilesystemWalker();
    private readonly structureProc     = new StructureProcessor();
    private readonly parsingProc       = new ParsingProcessor();
    private readonly importProc        = new ImportProcessor();
    private readonly callProc          = new CallProcessor();
    private readonly communityProc     = new CommunityProcessor();
    private readonly clusterEnricher   = new ClusterEnricher();
    private readonly processProc       = new ProcessProcessor();

    // ─── fast path ───────────────────────────────────────────────────────────

    /** Structure-only — shows the graph in <1 s without any file reads beyond the walk. */
    async executeStructureOnly(
        rootPath: string,
        config: PipelineConfig
    ): Promise<KnowledgeGraph> {
        const graph = new GraphBuilder();
        const walkResult = await this.fsWalker.walk(rootPath, config.excludePatterns);
        const structure = this.structureProc.process(
            walkResult.files,
            rootPath,
            (p, r) => this.fsWalker.getFileInfo(p, r)
        );

        for (const node of structure.nodes) graph.addNode(node);
        for (const edge of structure.edges) graph.addEdge(edge);

        return {
            nodes:    graph.nodes,
            edges:    graph.edges,
            clusters: [],
            metadata: {
                indexedAt:   new Date().toISOString(),
                fileCount:   walkResult.files.length,
                symbolCount: 0,
                languages:   [...walkResult.languages],
            },
        };
    }

    // ─── full pipeline ────────────────────────────────────────────────────────

    async execute(
        rootPath: string,
        progress: vscode.Progress<PipelineProgress>,
        token: vscode.CancellationToken,
        config: PipelineConfig
    ): Promise<KnowledgeGraph> {
        const graph = new GraphBuilder();
        let fileCount    = 0;
        let symbolCount  = 0;
        let languages: Set<string> = new Set();

        const report = (phase: number, phaseName: string, message: string, increment?: number) =>
            progress.report({ phase, phaseName, message, increment });

        const cancelled = () => {
            if (token.isCancellationRequested) throw new Error('Indexing cancelled');
        };

        // ================================================================
        // PHASE 0 (new): Walk filesystem + load ALL files into RAM
        // ================================================================
        report(0, 'Loading', 'Reading source files into memory...');
        cancelled();

        const walkResult = await this.fsWalker.walk(rootPath, config.excludePatterns);
        fileCount = walkResult.files.length;
        languages = walkResult.languages;

        const cache = new FileCache();
        await cache.load(
            walkResult.files,
            rootPath,
            config.maxFileSize ?? 512 * 1024,
            (loaded, total) => report(0, 'Loading', `Loaded ${loaded}/${total} files into memory`)
        );

        const ramMB = (cache.bytesUsed / 1024 / 1024).toFixed(1);
        report(0, 'Loading', `${cache.size} files in RAM (${ramMB} MB)`, 10);
        cancelled();

        // ================================================================
        // PHASE 1: Structure — file/folder nodes (no file reads needed)
        // ================================================================
        report(1, 'Structure', 'Building file tree...');
        cancelled();

        const structure = this.structureProc.process(
            walkResult.files,
            rootPath,
            (p, r) => this.fsWalker.getFileInfo(p, r)
        );
        for (const node of structure.nodes) graph.addNode(node);
        for (const edge of structure.edges) graph.addEdge(edge);

        report(1, 'Structure', `Found ${fileCount} files`, 15);
        cancelled();

        // ================================================================
        // PHASE 2: Parsing — extract symbols (RAM only)
        // ================================================================
        report(2, 'Parsing', 'Extracting symbols...');
        cancelled();

        const symbolsByFile = await this.parsingProc.parseFiles(
            cache,
            (msg, cur, tot) => report(2, 'Parsing', msg)
        );

        // Build relative-path→symbols lookup and add symbol nodes + DEFINES edges
        console.log('[Pipeline] Processing', symbolsByFile.size, 'files with symbols');
        
        // First pass: collect all class IDs for linking
        const classIdsByFile = new Map<string, Map<string, string>>();
        
        for (const [absPath, symbols] of symbolsByFile.entries()) {
            const entry = cache.get(absPath);
            if (!entry) continue;
            const relPath = entry.relativePath.replace(/\\/g, '/');
            const classIds = new Map<string, string>();
            
            for (const sym of symbols) {
                if (sym.type === 'class') {
                    classIds.set(sym.name, `symbol:${relPath}:${sym.name}`);
                }
            }
            classIdsByFile.set(absPath, classIds);
        }
        
        // Second pass: add all symbols with proper edges
        for (const [absPath, symbols] of symbolsByFile.entries()) {
            const entry = cache.get(absPath);
            if (!entry) continue;

            const relPath = entry.relativePath.replace(/\\/g, '/');
            const classIds = classIdsByFile.get(absPath);

            for (const sym of symbols) {
                symbolCount++;
                const symId = `symbol:${relPath}:${sym.name}`;

                const added = graph.addNode({
                    id:       symId,
                    name:     sym.name,
                    type:     this.mapSymbolType(sym.type),
                    path:     absPath,
                    location: sym.location,
                    metadata: sym.metadata,
                });

                // File → Symbol (DEFINES)
                graph.addEdge({
                    source: `file:${relPath}`,
                    target: symId,
                    type:   'defines',
                    weight: 1,
                });

                // Class → Method/Property/Constructor (HAS_METHOD)
                if (sym.parentClass && classIds) {
                    const classId = classIds.get(sym.parentClass);
                    if (classId) {
                        graph.addEdge({
                            source: classId,
                            target: symId,
                            type:   'has_method',
                            weight: 1,
                        });
                    }
                }
            }
        }
        console.log('[Pipeline] Added', symbolCount, 'symbol nodes');

        report(2, 'Parsing', `Found ${symbolCount} symbols`, 15);
        cancelled();

        // ================================================================
        // PHASE 3: Resolution — imports + calls (RAM only)
        // ================================================================
        report(3, 'Resolution', 'Resolving imports...');
        cancelled();

        const importEdges = await this.importProc.process(
            cache,
            rootPath,
            (msg) => report(3, 'Resolution', msg)
        );
        for (const edge of importEdges) graph.addEdge(edge);

        report(3, 'Resolution', 'Resolving call graph...');

        const callEdges = await this.callProc.process(
            cache,
            symbolsByFile,
            rootPath,
            (msg) => report(3, 'Resolution', msg)
        );
        for (const edge of callEdges) graph.addEdge(edge);

        report(3, 'Resolution', `${importEdges.length} imports, ${callEdges.length} calls`, 15);
        cancelled();

        // ================================================================
        // PHASE 4: Clustering (Leiden algorithm via graphology)
        // ================================================================
        report(4, 'Clustering', 'Detecting communities...');
        cancelled();

        const communityResult = this.communityProc.process(
            graph.nodes,
            graph.edges,
            (msg, progress) => report(4, 'Clustering', msg)
        );

        for (const node of graph.nodes) {
            node.cluster = communityResult.nodeClusterMap.get(node.id);
        }

        const enrichedClusters = this.clusterEnricher.enrich(
            communityResult.communities.map(c => ({
                id: parseInt(c.id.split('_')[1]) || 0,
                name: c.label,
                color: getCommunityColor(parseInt(c.id.split('_')[1]) || 0),
                nodeCount: c.symbolCount
            })),
            graph.nodes,
            graph.edges,
            communityResult.nodeClusterMap
        );

        report(4, 'Clustering', `${communityResult.communities.length} clusters`, 15);
        cancelled();

        // ================================================================
        // PHASE 5: Execution flows (unchanged)
        // ================================================================
        report(5, 'Execution', 'Tracing execution flows...');
        cancelled();

        this.processProc.process(graph.nodes, graph.edges);

        // Calculate connection counts
        const connCounts = new Map<string, number>();
        for (const edge of graph.edges) {
            connCounts.set(edge.source, (connCounts.get(edge.source) ?? 0) + 1);
            connCounts.set(edge.target, (connCounts.get(edge.target) ?? 0) + 1);
        }
        for (const node of graph.nodes) {
            node.connections = connCounts.get(node.id) ?? 0;
        }

        report(5, 'Execution', 'Done', 15);

        // cache goes out of scope here → GC reclaims the RAM
        return {
            nodes: graph.nodes,
            edges: graph.edges,
            clusters: enrichedClusters.map(c => ({
                id:        c.id,
                name:      c.name,
                color:     c.color,
                nodeCount: c.nodeCount,
            })),
            metadata: {
                indexedAt:   new Date().toISOString(),
                fileCount,
                symbolCount,
                languages:   [...languages],
            },
        };
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    private mapSymbolType(type: string): NodeType {
        const knownTypes: NodeType[] = [
            'function', 'class', 'interface', 'method', 'variable', 'struct',
            'enum', 'trait', 'impl', 'namespace', 'module', 'constructor',
            'property', 'const', 'static', 'record', 'typedef', 'union', 'macro'
        ];
        if (type === 'type') return 'interface';
        if (knownTypes.includes(type as NodeType)) return type as NodeType;
        return 'variable';
    }
}
