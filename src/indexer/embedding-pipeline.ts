/**
 * Embedding Pipeline Module
 *
 * Orchestrates the embedding generation process:
 * 1. Query embeddable nodes from the knowledge graph
 * 2. Generate text representations
 * 3. Generate TF-IDF embeddings
 * 4. Store embeddings for semantic search
 *
 * Note: Uses TF-IDF instead of transformer models because VS Code extensions
 * don't support native modules required by ONNX Runtime.
 */

import {
    initEmbedder,
    embedBatch,
    embedText,
    embeddingToArray,
    isEmbedderReady,
    trainOnCorpus
} from './embedder';
import { generateBatchEmbeddingTexts, generateEmbeddingText } from './text-generator';
import {
    type EmbeddingProgress,
    type EmbeddingConfig,
    type EmbeddableNode,
    type SemanticSearchResult,
    type ModelProgress,
    DEFAULT_EMBEDDING_CONFIG,
    EMBEDDABLE_LABELS
} from './embedding-types';
import { GraphNode, KnowledgeGraph } from './IndexerService';

/**
 * Progress callback type
 */
export type EmbeddingProgressCallback = (progress: EmbeddingProgress) => void;

/**
 * In-memory storage for embeddings
 */
interface EmbeddingStore {
    embeddings: Map<string, number[]>;
    isIndexBuilt: boolean;
}

const embeddingStore: EmbeddingStore = {
    embeddings: new Map(),
    isIndexBuilt: false
};

/**
 * Extract content from a node based on its type
 */
function extractNodeContent(node: GraphNode): string {
    if (node.metadata?.content) {
        return node.metadata.content as string;
    }
    return '';
}

/**
 * Create embeddable nodes from graph nodes
 */
function createEmbeddableNodes(graph: KnowledgeGraph): EmbeddableNode[] {
    const nodes: EmbeddableNode[] = [];

    for (const node of graph.nodes) {
        // Skip non-embeddable types
        if (!['function', 'class', 'method', 'interface', 'file'].includes(node.type)) {
            continue;
        }

        // Map our node type to embedder label
        const labelMap: Record<string, string> = {
            'function': 'Function',
            'class': 'Class',
            'method': 'Method',
            'interface': 'Interface',
            'file': 'File'
        };

        nodes.push({
            id: node.id,
            name: node.name,
            label: labelMap[node.type] || node.type,
            filePath: node.path || '',
            content: extractNodeContent(node),
            startLine: node.location?.line,
            endLine: node.location?.endLine
        });
    }

    return nodes;
}

/**
 * Run the embedding pipeline on a knowledge graph
 *
 * @param graph - The knowledge graph to embed
 * @param onProgress - Callback for progress updates
 * @param config - Optional configuration override
 * @param skipNodeIds - Optional set of node IDs that already have embeddings (incremental mode)
 */
export const runEmbeddingPipeline = async (
    graph: KnowledgeGraph,
    onProgress: EmbeddingProgressCallback,
    config: Partial<EmbeddingConfig> = {},
    skipNodeIds?: Set<string>,
): Promise<void> => {
    const finalConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };

    try {
        // Phase 1: Initialize embedder
        onProgress({
            phase: 'loading-model',
            percent: 0,
            modelDownloadPercent: 0,
        });

        if (!isEmbedderReady()) {
            await initEmbedder((modelProgress: ModelProgress) => {
                const downloadPercent = modelProgress.progress ?? 0;
                onProgress({
                    phase: 'loading-model',
                    percent: Math.round(downloadPercent * 0.2),
                    modelDownloadPercent: downloadPercent,
                });
            }, finalConfig);
        }

        onProgress({
            phase: 'loading-model',
            percent: 20,
            modelDownloadPercent: 100,
        });

        // Phase 2: Query embeddable nodes
        let nodes = createEmbeddableNodes(graph);

        // Incremental mode: filter out nodes that already have embeddings
        if (skipNodeIds && skipNodeIds.size > 0) {
            const beforeCount = nodes.length;
            nodes = nodes.filter(n => !skipNodeIds.has(n.id));
            console.log(`[Embedding] Incremental: ${beforeCount} total, ${skipNodeIds.size} cached, ${nodes.length} to embed`);
        }

        const totalNodes = nodes.length;

        console.log(`[Embedding] Found ${totalNodes} embeddable nodes`);

        if (totalNodes === 0) {
            onProgress({
                phase: 'ready',
                percent: 100,
                nodesProcessed: 0,
                totalNodes: 0,
            });
            return;
        }

        // Phase 3: Train on corpus for better TF-IDF
        onProgress({
            phase: 'embedding',
            percent: 25,
            nodesProcessed: 0,
            totalNodes,
            currentBatch: 0,
            totalBatches: 1,
        });

        // Generate texts for training
        const allTexts = generateBatchEmbeddingTexts(nodes, finalConfig);

        // Train the embedder on the corpus
        trainOnCorpus(allTexts);

        // Phase 4: Batch embed nodes
        const batchSize = finalConfig.batchSize;
        const totalBatches = Math.ceil(totalNodes / batchSize);
        let processedNodes = 0;

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const start = batchIndex * batchSize;
            const end = Math.min(start + batchSize, totalNodes);
            const batch = nodes.slice(start, end);

            // Generate texts for this batch
            const texts = generateBatchEmbeddingTexts(batch, finalConfig);

            // Embed the batch
            const embeddings = await embedBatch(texts);

            // Store embeddings
            for (let i = 0; i < batch.length; i++) {
                embeddingStore.embeddings.set(
                    batch[i].id,
                    embeddingToArray(embeddings[i])
                );
            }

            processedNodes += batch.length;

            // Report progress (25-90% for embedding phase)
            const embeddingProgress = 25 + ((processedNodes / totalNodes) * 65);
            onProgress({
                phase: 'embedding',
                percent: Math.round(embeddingProgress),
                nodesProcessed: processedNodes,
                totalNodes,
                currentBatch: batchIndex + 1,
                totalBatches,
            });
        }

        // Phase 5: Index is now built
        embeddingStore.isIndexBuilt = true;

        onProgress({
            phase: 'indexing',
            percent: 95,
            nodesProcessed: totalNodes,
            totalNodes,
        });

        console.log(`[Embedding] Pipeline complete! ${totalNodes} nodes embedded.`);

        // Complete
        onProgress({
            phase: 'ready',
            percent: 100,
            nodesProcessed: totalNodes,
            totalNodes,
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Embedding] Error:', errorMessage);

        onProgress({
            phase: 'error',
            percent: 0,
            error: errorMessage,
        });

        throw error;
    }
};

/**
 * Perform semantic search using the stored embeddings
 *
 * @param query - Search query text
 * @param graph - The knowledge graph to search in
 * @param k - Number of results to return (default: 10)
 * @param maxDistance - Maximum distance threshold (default: 1.0)
 * @returns Array of search results ordered by relevance
 */
export const semanticSearch = async (
    query: string,
    graph: KnowledgeGraph,
    k: number = 10,
    maxDistance: number = 1.0
): Promise<SemanticSearchResult[]> => {
    if (embeddingStore.embeddings.size === 0) {
        return [];
    }

    // Embed the query
    const queryEmbedding = await embedText(query);
    const queryVec = embeddingToArray(queryEmbedding);

    // Calculate cosine distance to all embedded nodes
    const results: Array<{ nodeId: string; distance: number }> = [];

    for (const [nodeId, embedding] of embeddingStore.embeddings) {
        const distance = cosineDistance(queryVec, embedding);
        if (distance <= maxDistance) {
            results.push({ nodeId, distance });
        }
    }

    // Sort by distance and take top k
    results.sort((a, b) => a.distance - b.distance);
    const topResults = results.slice(0, k);

    // Map to SemanticSearchResult with node metadata
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

    return topResults.map(r => {
        const node = nodeMap.get(r.nodeId);
        return {
            nodeId: r.nodeId,
            name: node?.name || '',
            label: node?.type || '',
            filePath: node?.path || '',
            distance: r.distance,
            startLine: node?.location?.line,
            endLine: node?.location?.endLine
        };
    });
};

/**
 * Calculate cosine distance between two vectors
 */
function cosineDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error('Vector dimensions must match');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

    // Convert similarity (-1 to 1) to distance (0 to 1)
    return (1 - similarity) / 2;
}

/**
 * Clear all stored embeddings
 */
export const clearEmbeddings = (): void => {
    embeddingStore.embeddings.clear();
    embeddingStore.isIndexBuilt = false;
};

/**
 * Check if embeddings are ready for search
 */
export const areEmbeddingsReady = (): boolean => {
    return embeddingStore.isIndexBuilt && embeddingStore.embeddings.size > 0;
};

/**
 * Get embedding count
 */
export const getEmbeddingCount = (): number => {
    return embeddingStore.embeddings.size;
};
