/**
 * Phase 2: Tree-sitter Queries
 * Provides tree-sitter based AST queries for more accurate symbol extraction
 * Note: Tree-sitter parsing is more accurate than regex but requires language parsers
 * This file provides query definitions and utilities for when tree-sitter is available
 */

export interface TSQuery {
    language: string;
    captures: Map<string, unknown[]>;
}

export interface SymbolQuery {
    name: string;
    type: 'function' | 'class' | 'interface' | 'method' | 'variable' | 'type';
    nodeType: string;
    field?: string;
}

// Query definitions for different language ASTs
export const LANGUAGE_QUERIES: Record<string, SymbolQuery[]> = {
    typescript: [
        // Function declarations
        { name: 'identifier', type: 'function', nodeType: 'function_declaration' },
        { name: 'identifier', type: 'function', nodeType: 'function_signature' },
        // Method definitions in classes
        { name: 'property_identifier', type: 'method', nodeType: 'method_definition' },
        { name: 'property_identifier', type: 'method', nodeType: 'method_signature' },
        // Class declarations
        { name: 'identifier', type: 'class', nodeType: 'class_declaration' },
        { name: 'identifier', type: 'class', nodeType: 'class_heritage' },
        // Interface declarations
        { name: 'identifier', type: 'interface', nodeType: 'interface_declaration' },
        { name: 'type_identifier', type: 'type', nodeType: 'type_alias_declaration' },
        // Variable declarations
        { name: 'identifier', type: 'variable', nodeType: 'variable_declarator' },
    ],
    javascript: [
        { name: 'identifier', type: 'function', nodeType: 'function_declaration' },
        { name: 'property_identifier', type: 'method', nodeType: 'method_definition' },
        { name: 'identifier', type: 'class', nodeType: 'class_declaration' },
        { name: 'identifier', type: 'variable', nodeType: 'variable_declarator' },
    ],
    python: [
        { name: 'identifier', type: 'function', nodeType: 'function_definition' },
        { name: 'identifier', type: 'class', nodeType: 'class_definition' },
        { name: 'identifier', type: 'method', nodeType: 'method_definition' },
        { name: 'identifier', type: 'variable', nodeType: 'assignment' },
    ],
    rust: [
        { name: 'identifier', type: 'function', nodeType: 'function_item' },
        { name: 'identifier', type: 'class', nodeType: 'struct_item' },
        { name: 'identifier', type: 'class', nodeType: 'enum_item' },
        { name: 'identifier', type: 'interface', nodeType: 'trait_item' },
        { name: 'type_identifier', type: 'type', nodeType: 'type_alias_item' },
        { name: 'identifier', type: 'variable', nodeType: 'let_declaration' },
    ],
    go: [
        { name: 'identifier', type: 'function', nodeType: 'function_declaration' },
        { name: 'field_identifier', type: 'method', nodeType: 'method_declaration' },
        { name: 'type_identifier', type: 'class', nodeType: 'type_declaration' },
        { name: 'type_identifier', type: 'interface', nodeType: 'interface_type' },
    ],
    java: [
        { name: 'identifier', type: 'function', nodeType: 'method_declaration' },
        { name: 'identifier', type: 'class', nodeType: 'class_declaration' },
        { name: 'identifier', type: 'interface', nodeType: 'interface_declaration' },
        { name: 'identifier', type: 'type', nodeType: 'type_declaration' },
    ]
};

export class TreeSitterQueries {
    /**
     * Get queries for a specific language
     */
    getQueries(language: string): SymbolQuery[] {
        return LANGUAGE_QUERIES[language.toLowerCase()] || [];
    }

    /**
     * Check if tree-sitter is available and initialized
     */
    isAvailable(): boolean {
        // Tree-sitter requires native bindings that may not be available
        // This is a placeholder for when tree-sitter is integrated
        return false;
    }

    /**
     * Parse content using tree-sitter (when available)
     * Returns captured nodes matching the queries
     */
    async parse(content: string, language: string): Promise<TSQuery | null> {
        // Placeholder - tree-sitter integration would go here
        // For now, return null to fall back to regex parsing
        return null;
    }

    /**
     * Generate a tree-sitter query string for a language
     * Useful for debugging or external tree-sitter usage
     */
    generateQueryString(language: string): string {
        const queries = this.getQueries(language);
        const queryParts: string[] = [];

        for (const query of queries) {
            queryParts.push(`(${query.nodeType} (${query.name}) @${query.type})`);
        }

        return queryParts.join('\n');
    }
}
