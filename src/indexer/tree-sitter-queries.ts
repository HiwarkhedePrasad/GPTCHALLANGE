/**
 * Tree-sitter Queries
 *
 * Provides tree-sitter based AST queries for accurate symbol extraction.
 * Uses actual tree-sitter parsers when available.
 */

import { TreeSitterParser, TSParsedSymbol, getTreeSitterParser } from './tree-sitter-parser';
import { FileCache } from './FileCache';

export { TSParsedSymbol };

// Language-specific query definitions for tree-sitter
export const LANGUAGE_QUERIES: Record<string, {
    function: string[];
    class: string[];
    method: string[];
    interface: string[];
    variable: string[];
    type: string[];
}> = {
    typescript: {
        function: ['function_declaration', 'function_signature', 'arrow_function'],
        class: ['class_declaration', 'class_heritage'],
        method: ['method_definition', 'method_signature'],
        interface: ['interface_declaration'],
        variable: ['variable_declarator'],
        type: ['type_alias_declaration', 'enum_declaration']
    },
    javascript: {
        function: ['function_declaration', 'arrow_function'],
        class: ['class_declaration'],
        method: ['method_definition'],
        interface: [],
        variable: ['variable_declarator'],
        type: []
    },
    python: {
        function: ['function_definition'],
        class: ['class_definition'],
        method: ['method_definition'],
        interface: [],
        variable: ['assignment'],
        type: ['type_alias']
    },
    rust: {
        function: ['function_item'],
        class: ['struct_item', 'enum_item'],
        method: ['method_definition'],
        interface: ['trait_item'],
        variable: ['let_declaration'],
        type: ['type_alias_item']
    },
    go: {
        function: ['function_declaration'],
        class: ['type_declaration'],
        method: ['method_declaration'],
        interface: ['interface_type'],
        variable: [],
        type: ['type_alias']
    },
    java: {
        function: ['method_declaration'],
        class: ['class_declaration'],
        method: ['method_declaration'],
        interface: ['interface_declaration'],
        variable: ['variable_declarator'],
        type: ['type_declaration']
    }
};

export class TreeSitterQueries {
    private parser: TreeSitterParser;
    private available: boolean;

    constructor() {
        this.parser = getTreeSitterParser();
        this.available = this.parser.isAvailable();
    }

    /**
     * Check if tree-sitter is available and initialized
     */
    isAvailable(): boolean {
        return this.available;
    }

    /**
     * Get queries for a specific language
     */
    getQueries(language: string): typeof LANGUAGE_QUERIES['typescript'] {
        return LANGUAGE_QUERIES[language.toLowerCase()] || LANGUAGE_QUERIES['typescript'];
    }

    /**
     * Parse content using tree-sitter
     * Returns captured nodes matching the queries
     */
    async parse(
        content: string,
        ext: string,
        filePath?: string
    ): Promise<TSParsedSymbol[]> {
        if (!this.available) {
            return [];
        }

        return this.parser.parseFile(content, ext);
    }

    /**
     * Parse multiple files using tree-sitter
     */
    async parseFiles(
        cache: FileCache,
        onProgress?: (message: string, current: number, total: number) => void
    ): Promise<Map<string, TSParsedSymbol[]>> {
        if (!this.available) {
            return new Map();
        }

        return this.parser.parseFiles(cache, onProgress);
    }

    /**
     * Generate a tree-sitter query string for a language
     * Useful for debugging or external tree-sitter usage
     */
    generateQueryString(language: string): string {
        const queries = this.getQueries(language);
        const queryParts: string[] = [];

        for (const [type, nodeTypes] of Object.entries(queries)) {
            for (const nodeType of nodeTypes) {
                queryParts.push(`(${nodeType}) @${type}`);
            }
        }

        return queryParts.join('\n');
    }
}
