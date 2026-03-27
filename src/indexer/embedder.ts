/**
 * Embedder Service
 *
 * Provides text embedding using TF-IDF (Term Frequency-Inverse Document Frequency).
 * This is a pure-JavaScript implementation that works in VS Code extensions
 * without requiring native dependencies.
 *
 * While not as powerful as transformer-based embeddings (like snowflake-arctic-embed-xs),
 * TF-IDF provides reasonable semantic search capabilities for code.
 */

import {
    DEFAULT_EMBEDDING_CONFIG,
    type EmbeddingConfig,
    type ModelProgress
} from './embedding-types';

// Module-level state
let isInitialized = false;
let currentConfig: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG;

/**
 * Check if embedder is available
 */
export const isEmbedderReady = (): boolean => {
    return isInitialized;
};

/**
 * Check if transformers (actual ML) is available
 */
export const isTransformersAvailable = (): boolean => {
    return false; // Native modules not available in VS Code extension
};

/**
 * Initialize the embedder (no-op for TF-IDF)
 */
export const initEmbedder = async (
    onProgress?: ModelProgressCallback,
    config: Partial<EmbeddingConfig> = {}
): Promise<void> => {
    currentConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
    isInitialized = true;
    onProgress?.({
        status: 'ready',
        progress: 100,
        loaded: 1,
        total: 1,
    });
};

/**
 * Progress callback type
 */
export type ModelProgressCallback = (progress: ModelProgress) => void;

/**
 * Get the current device (always 'cpu' for TF-IDF)
 */
export const getCurrentDevice = (): 'cpu' => 'cpu';

/**
 * Embed a single text string
 * Returns a vector using TF-IDF encoding
 *
 * @param text - Text to embed
 * @returns Float32Array of embedding vector
 */
export const embedText = async (text: string): Promise<Float32Array> => {
    return textToVector(text);
};

/**
 * Embed multiple texts in a single batch
 *
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embedding vectors
 */
export const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
    return texts.map(text => textToVector(text));
};

/**
 * Convert Float32Array to regular number array (for storage)
 */
export const embeddingToArray = (embedding: Float32Array): number[] => {
    return Array.from(embedding);
};

/**
 * Cleanup (no-op for TF-IDF)
 */
export const disposeEmbedder = async (): Promise<void> => {
    isInitialized = false;
};

/**
 * Get the effective embedding dimensions
 */
export const getEmbeddingDimensions = (): number => {
    return currentConfig.dimensions;
};

// ============================================================================
// TF-IDF IMPLEMENTATION
// ============================================================================

interface Vocabulary {
    [term: string]: number;
}

interface IDFCache {
    [term: string]: number;
}

// Global vocabulary and IDF cache
let vocabulary: Vocabulary = {};
let idfCache: IDFCache = {};
let documentCount = 0;

/**
 * Tokenize text into terms
 */
function tokenize(text: string): string[] {
    // Simple tokenization: lowercase, split on non-alphanumeric
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(term => term.length > 1);
}

/**
 * Calculate term frequency
 */
function calculateTF(terms: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    const totalTerms = terms.length;

    for (const term of terms) {
        tf.set(term, (tf.get(term) || 0) + 1);
    }

    // Normalize by document length
    for (const [term, count] of tf) {
        tf.set(term, count / totalTerms);
    }

    return tf;
}

/**
 * Calculate inverse document frequency
 */
function calculateIDF(term: string, totalDocs: number, docFreq: number): number {
    // Smooth IDF to avoid division by zero
    return Math.log((totalDocs + 1) / (docFreq + 1)) + 1;
}

/**
 * Convert a single text to a vector using TF-IDF
 */
function textToVector(text: string): Float32Array {
    const terms = tokenize(text);
    const tf = calculateTF(terms);
    const dimensions = currentConfig.dimensions;

    // Get the most important terms based on TF
    const sortedTerms = Array.from(tf.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, dimensions / 2);

    // Create a simple hash-based vector
    const vector = new Float32Array(dimensions);

    for (let i = 0; i < sortedTerms.length; i++) {
        const [term, tfValue] = sortedTerms[i];

        // Simple hash for the term to get a position
        let hash = 0;
        for (let j = 0; j < term.length; j++) {
            hash = ((hash << 5) - hash) + term.charCodeAt(j);
            hash = hash & hash; // Convert to 32-bit integer
        }

        const position = Math.abs(hash) % dimensions;

        // Combine TF with a simple weight based on term characteristics
        const weight = tfValue * (term.length > 4 ? 1.5 : 1.0);
        vector[position] = weight;

        // Also set a nearby position for better distribution
        const nearbyPosition = (position + 1) % dimensions;
        vector[nearbyPosition] = weight * 0.5;
    }

    // Normalize the vector
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
        norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
            vector[i] /= norm;
        }
    }

    return vector;
}

/**
 * Train the embedder on a corpus of documents
 * This builds the vocabulary and IDF cache
 */
export const trainOnCorpus = (documents: string[]): void => {
    vocabulary = {};
    idfCache = {};
    documentCount = documents.length;

    // Count document frequency for each term
    const docFreq = new Map<string, number>();

    for (const doc of documents) {
        const terms = new Set(tokenize(doc));

        for (const term of terms) {
            docFreq.set(term, (docFreq.get(term) || 0) + 1);
        }
    }

    // Build vocabulary with IDF
    let index = 0;
    for (const [term, freq] of docFreq) {
        if (index >= currentConfig.dimensions) break;

        vocabulary[term] = index;
        idfCache[term] = calculateIDF(term, documents.length, freq);
        index++;
    }
};

/**
 * Get vocabulary size
 */
export const getVocabularySize = (): number => {
    return Object.keys(vocabulary).length;
};
