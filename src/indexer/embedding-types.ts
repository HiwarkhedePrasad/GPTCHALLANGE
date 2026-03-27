/**
 * Embedding Pipeline Types
 *
 * Type definitions for the embedding generation and semantic search system.
 */

/**
 * Node labels that should be embedded for semantic search
 * These are code elements that benefit from semantic matching
 */
export const EMBEDDABLE_LABELS = [
    'Function',
    'Class',
    'Method',
    'Interface',
    'File',
] as const;

export type EmbeddableLabel = typeof EMBEDDABLE_LABELS[number];

/**
 * Check if a label should be embedded
 */
export const isEmbeddableLabel = (label: string): label is EmbeddableLabel =>
    EMBEDDABLE_LABELS.includes(label as EmbeddableLabel);

/**
 * Embedding pipeline phases
 */
export type EmbeddingPhase =
    | 'idle'
    | 'loading-model'
    | 'embedding'
    | 'indexing'
    | 'ready'
    | 'error';

/**
 * Progress information for the embedding pipeline
 */
export interface EmbeddingProgress {
    phase: EmbeddingPhase;
    percent: number;
    modelDownloadPercent?: number;
    nodesProcessed?: number;
    totalNodes?: number;
    currentBatch?: number;
    totalBatches?: number;
    error?: string;
}

/**
 * Configuration for the embedding pipeline
 */
export interface EmbeddingConfig {
    /** Model identifier for transformers.js (local) */
    modelId: string;
    /** Device to use for inference: 'auto', 'cpu', 'cuda', 'dml', 'wasm' */
    device: 'auto' | 'cpu' | 'cuda' | 'dml' | 'wasm';
    /** Batch size for embedding generation */
    batchSize: number;
    /** Maximum snippet length for code content */
    maxSnippetLength: number;
    /** Embedding dimensions */
    dimensions: number;
}

/**
 * Default embedding configuration using snowflake-arctic-embed-xs model
 */
export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
    modelId: 'snowflake-arctic-embed-xs',
    device: 'auto',
    batchSize: 32,
    maxSnippetLength: 512,
    dimensions: 384,
};

/**
 * Model progress callback type
 */
export interface ModelProgress {
    status: string;
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
}

/**
 * Embeddable node from the knowledge graph
 */
export interface EmbeddableNode {
    id: string;
    name: string;
    label: string;
    filePath: string;
    content: string;
    startLine?: number;
    endLine?: number;
}

/**
 * Semantic search result
 */
export interface SemanticSearchResult {
    nodeId: string;
    name: string;
    label: string;
    filePath: string;
    distance: number;
    startLine?: number;
    endLine?: number;
}
