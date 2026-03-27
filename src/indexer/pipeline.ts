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
import { GraphNode, GraphEdge, KnowledgeGraph } from './IndexerService';

import { FileCache } from './FileCache';

import { FilesystemWalker }   from './filesystem-walker';
import { StructureProcessor } from './structure-processor';
import { ParsingProcessor }   from './parsing-processor';
import { ImportProcessor }    from './import-processor';
import { CallProcessor }      from './call-processor';
import { CommunityProcessor } from './community-processor';
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
        const walkResult = await this.fsWalker.walk(rootPath, config.excludePatterns);
        const structure  = this.structureProc.process(
            walkResult.files,
            rootPath,
            (p, r) => this.fsWalker.getFileInfo(p, r)
        );

        return {
            nodes:    structure.nodes,
            edges:    structure.edges,
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
        const nodes: GraphNode[]  = [];
        const edges: GraphEdge[]  = [];
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
        nodes.push(...structure.nodes);
        edges.push(...structure.edges);

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

        // Build relative-path→symbols lookup and add symbol nodes + CONTAINS edges
        for (const [absPath, symbols] of symbolsByFile.entries()) {
            const entry = cache.get(absPath);
            if (!entry) continue;

            const relPath = entry.relativePath.replace(/\\/g, '/');

            for (const sym of symbols) {
                symbolCount++;
                const symId = `symbol:${relPath}:${sym.name}`;

                nodes.push({
                    id:       symId,
                    name:     sym.name,
                    type:     this.mapSymbolType(sym.type),
                    path:     absPath,
                    location: sym.location,
                    metadata: sym.metadata,
                });

                edges.push({
                    source: `file:${relPath}`,
                    target: symId,
                    type:   'contains',
                    weight: 1,
                });
            }
        }

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
        edges.push(...importEdges);

        report(3, 'Resolution', 'Resolving call graph...');

        const callEdges = await this.callProc.process(
            cache,
            symbolsByFile,
            rootPath,
            (msg) => report(3, 'Resolution', msg)
        );
        edges.push(...callEdges);

        report(3, 'Resolution', `${importEdges.length} imports, ${callEdges.length} calls`, 15);
        cancelled();

        // ================================================================
        // PHASE 4: Clustering (unchanged — pure in-memory graph algorithm)
        // ================================================================
        report(4, 'Clustering', 'Detecting communities...');
        cancelled();

        const communityResult = this.communityProc.process(nodes, edges);

        for (const node of nodes) {
            node.cluster = communityResult.nodeClusterMap.get(node.id);
        }

        const enrichedClusters = this.clusterEnricher.enrich(
            communityResult.clusters,
            nodes,
            edges,
            communityResult.nodeClusterMap
        );

        report(4, 'Clustering', `${communityResult.clusters.length} clusters`, 15);
        cancelled();

        // ================================================================
        // PHASE 5: Execution flows (unchanged)
        // ================================================================
        report(5, 'Execution', 'Tracing execution flows...');
        cancelled();

        this.processProc.process(nodes, edges);

        // Calculate connection counts
        const connCounts = new Map<string, number>();
        for (const edge of edges) {
            connCounts.set(edge.source, (connCounts.get(edge.source) ?? 0) + 1);
            connCounts.set(edge.target, (connCounts.get(edge.target) ?? 0) + 1);
        }
        for (const node of nodes) {
            node.connections = connCounts.get(node.id) ?? 0;
        }

        report(5, 'Execution', 'Done', 15);

        // cache goes out of scope here → GC reclaims the RAM
        return {
            nodes,
            edges,
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

    private mapSymbolType(type: string): GraphNode['type'] {
        const map: Record<string, GraphNode['type']> = {
            function:  'function',
            class:     'class',
            interface: 'interface',
            method:    'method',
            variable:  'variable',
            type:      'interface',
        };
        return map[type] ?? 'variable';
    }
}
