/**
 * Tree-sitter Parser
 *
 * Provides AST-based symbol extraction.
 * This module attempts to use tree-sitter when available,
 * but gracefully falls back to regex parsing when not.
 *
 * Note: Native tree-sitter bindings (.node files) require special handling
 * in VS Code extensions and may not always be available.
 */

import { FileCache } from './FileCache';

export interface TSParsedSymbol {
    name: string;
    type: 'function' | 'class' | 'interface' | 'method' | 'variable' | 'type';
    location: { line: number; column: number; endLine?: number };
    metadata: Record<string, unknown>;
}

// Track if tree-sitter is actually available
let treeSitterAvailable = false;
let Parser: any = null;

try {
    Parser = require('tree-sitter');
    treeSitterAvailable = true;
} catch {
    console.log('[TreeSitter] Native bindings not available - using regex parsing');
}

/**
 * Language configuration for tree-sitter
 */
interface LanguageConfig {
    extension: string;
    parserName: string;
}

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
    typescript: { extension: '.ts', parserName: 'tree-sitter-typescript' },
    javascript: { extension: '.js', parserName: 'tree-sitter-javascript' },
    python: { extension: '.py', parserName: 'tree-sitter-python' },
    rust: { extension: '.rs', parserName: 'tree-sitter-rust' },
    go: { extension: '.go', parserName: 'tree-sitter-go' },
    java: { extension: '.java', parserName: 'tree-sitter-java' }
};

// Cache for loaded parsers and languages
const parserCache: Map<string, any> = new Map();
const languageCache: Map<string, any> = new Map();

/**
 * Check if tree-sitter is available
 */
export function isTreeSitterAvailable(): boolean {
    return treeSitterAvailable;
}

/**
 * Get language config for a file extension
 */
function getLanguageConfig(ext: string): LanguageConfig | null {
    for (const config of Object.values(LANGUAGE_CONFIGS)) {
        if (config.extension === ext) {
            return config;
        }
    }
    return null;
}

/**
 * Load a tree-sitter parser for a specific language
 */
async function loadParser(language: string): Promise<any | null> {
    if (parserCache.has(language)) {
        return parserCache.get(language);
    }

    if (!treeSitterAvailable || !Parser) {
        return null;
    }

    try {
        const parser = new Parser();
        let languageModule: any;

        // Try to load language module
        switch (language) {
            case 'typescript':
            case 'javascript':
                languageModule = require('tree-sitter-javascript');
                break;
            case 'python':
                languageModule = require('tree-sitter-python');
                break;
            case 'rust':
                languageModule = require('tree-sitter-rust');
                break;
            case 'go':
                languageModule = require('tree-sitter-go');
                break;
            case 'java':
                languageModule = require('tree-sitter-java');
                break;
            default:
                return null;
        }

        parser.setLanguage(languageModule);
        parserCache.set(language, parser);
        languageCache.set(language, languageModule);
        return parser;
    } catch (error) {
        console.warn(`[TreeSitter] Failed to load ${language} parser:`, error);
        return null;
    }
}

/**
 * Extract symbol name and location from an AST node
 */
function extractSymbolFromNode(
    node: any,
    type: TSParsedSymbol['type']
): TSParsedSymbol | null {
    try {
        let name = '';

        // Navigate to find the identifier
        if (node.firstChild) {
            const identifier = node.firstChild;
            if (identifier && identifier.text) {
                name = identifier.text;
            }
        }

        if (!name && node.text) {
            name = node.text.split('(')[0].split('{')[0].trim();
        }

        if (!name || name.length > 100) {
            return null;
        }

        return {
            name,
            type,
            location: {
                line: node.startPosition?.row ?? 0,
                column: node.startPosition?.column ?? 0,
                endLine: node.endPosition?.row
            },
            metadata: { nodeType: node.type }
        };
    } catch {
        return null;
    }
}

/**
 * Parse a file using tree-sitter
 */
async function parseWithTreeSitter(
    content: string,
    language: string,
    filePath: string
): Promise<TSParsedSymbol[]> {
    const parser = await loadParser(language);
    if (!parser) {
        return [];
    }

    const symbols: TSParsedSymbol[] = [];

    try {
        const tree = parser.parse(content);

        // Define node types to extract
        const nodeTypes: Array<{ pattern: string; type: TSParsedSymbol['type'] }> = [
            { pattern: 'function_declaration', type: 'function' },
            { pattern: 'function_item', type: 'function' },
            { pattern: 'method_definition', type: 'method' },
            { pattern: 'method_declaration', type: 'method' },
            { pattern: 'class_declaration', type: 'class' },
            { pattern: 'struct_item', type: 'class' },
            { pattern: 'enum_item', type: 'class' },
            { pattern: 'interface_declaration', type: 'interface' },
            { pattern: 'trait_item', type: 'interface' },
            { pattern: 'interface_type', type: 'interface' },
            { pattern: 'type_alias_declaration', type: 'type' },
            { pattern: 'type_alias_item', type: 'type' },
            { pattern: 'type_declaration', type: 'type' },
            { pattern: 'arrow_function', type: 'function' },
            { pattern: 'function_definition', type: 'function' },
            { pattern: 'class_definition', type: 'class' },
            { pattern: 'struct_type', type: 'class' },
        ];

        // Walk the tree and extract symbols
        const walkTree = (node: any) => {
            for (const { pattern, type } of nodeTypes) {
                if (node.type === pattern) {
                    const symbol = extractSymbolFromNode(node, type);
                    if (symbol) {
                        symbols.push(symbol);
                    }
                    break;
                }
            }

            if (node.children) {
                for (const child of node.children) {
                    walkTree(child);
                }
            }
        };

        walkTree(tree.rootNode);

        return symbols;
    } catch (error) {
        console.warn(`[TreeSitter] Failed to parse ${filePath}:`, error);
        return [];
    }
}

/**
 * Tree-sitter based parser service
 */
export class TreeSitterParser {
    private available: boolean = false;

    constructor() {
        this.available = isTreeSitterAvailable();
    }

    /**
     * Check if tree-sitter is available
     */
    isAvailable(): boolean {
        return this.available;
    }

    /**
     * Parse files using tree-sitter
     */
    async parseFiles(
        cache: FileCache,
        onProgress?: (message: string, current: number, total: number) => void
    ): Promise<Map<string, TSParsedSymbol[]>> {
        const symbolsByFile = new Map<string, TSParsedSymbol[]>();
        const entries = [...cache.entries()];
        const total = entries.length;
        let processed = 0;

        if (!this.available) {
            return symbolsByFile;
        }

        const BATCH = 50;
        const LANGUAGES_WITH_TS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java']);

        for (let i = 0; i < entries.length; i += BATCH) {
            const batch = entries.slice(i, i + BATCH);

            for (const [absPath, { content, ext }] of batch) {
                if (LANGUAGES_WITH_TS.has(ext)) {
                    const lang = this.getLanguageFromExt(ext);
                    if (lang) {
                        const symbols = await parseWithTreeSitter(content, lang, absPath);
                        if (symbols.length > 0) {
                            symbolsByFile.set(absPath, symbols);
                        }
                    }
                }
                processed++;
            }

            onProgress?.(`Tree-sitter parsing ${processed}/${total} files`, processed, total);

            // Yield to keep UI responsive
            await new Promise<void>(resolve => setImmediate(resolve));
        }

        return symbolsByFile;
    }

    /**
     * Get language key from extension
     */
    private getLanguageFromExt(ext: string): string | null {
        const mapping: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.py': 'python',
            '.rs': 'rust',
            '.go': 'go',
            '.java': 'java'
        };
        return mapping[ext] || null;
    }

    /**
     * Parse a single file (for testing)
     */
    async parseFile(content: string, ext: string): Promise<TSParsedSymbol[]> {
        if (!this.available) {
            return [];
        }

        const lang = this.getLanguageFromExt(ext);
        if (!lang) {
            return [];
        }
        return parseWithTreeSitter(content, lang, 'test' + ext);
    }
}

// Singleton instance
let treeSitterParser: TreeSitterParser | null = null;

export function getTreeSitterParser(): TreeSitterParser {
    if (!treeSitterParser) {
        treeSitterParser = new TreeSitterParser();
    }
    return treeSitterParser;
}
