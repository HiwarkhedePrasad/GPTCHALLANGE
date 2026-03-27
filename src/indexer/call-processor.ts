/**
 * Phase 3: Call Processor
 * Links function calls to definitions with CALLS edges
 */

import * as fs from 'fs';
import * as path from 'path';
import { GraphEdge, GraphNode } from './IndexerService';

export interface CallInfo {
    caller: string;
    callee: string;
    line: number;
    column: number;
}

export interface SymbolReference {
    name: string;
    filePath: string;
    type: 'function' | 'class' | 'interface' | 'method';
    location: { line: number; column: number };
}

export class CallProcessor {
    // Call patterns for different languages
    private callPatterns: Record<string, RegExp[]> = {
        typescript: [
            // function calls: name()
            /\b(\w+)\s*\(/g,
            // method calls: obj.name()
            /\.(\w+)\s*\(/g,
        ],
        javascript: [
            /\b(\w+)\s*\(/g,
            /\.(\w+)\s*\(/g,
        ],
        python: [
            // function calls: name()
            /\b(\w+)\s*\(/g,
            // method calls: obj.name()
            /\.(\w+)\(/g,
        ],
        rust: [
            // function calls
            /\b(\w+)\s*\(/g,
            // method calls
            /\.(\w+)\(/g,
        ],
        go: [
            /\b(\w+)\s*\(/g,
            /\.(\w+)\(/g,
        ],
        java: [
            /\b(\w+)\s*\(/g,
            /\.(\w+)\(/g,
        ]
    };

    async process(
        files: string[],
        rootPath: string,
        symbolsByFile: Map<string, SymbolReference[]>,
        onProgress?: (message: string, current: number, total: number) => void
    ): Promise<GraphEdge[]> {
        const edges: GraphEdge[] = [];

        // Build a symbol index for quick lookup (only once)
        const symbolIndex = this.buildSymbolIndex(symbolsByFile);

        // Process files in parallel batches
        const BATCH_SIZE = 50;
        let processedCount = 0;

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, Math.min(i + BATCH_SIZE, files.length));

            const batchResults = await Promise.all(
                batch.map(async (file) => {
                    const relativePath = path.relative(rootPath, file);
                    const ext = path.extname(file).toLowerCase();
                    const lang = this.getLanguage(ext);

                    if (!lang) return [];

                    try {
                        const content = await fs.promises.readFile(file, 'utf-8');
                        const calls = this.extractCalls(content, relativePath, lang);
                        
                        const fileEdges: GraphEdge[] = [];
                        // Link calls to definitions
                        for (const call of calls) {
                            const definition = this.findDefinition(call.callee, symbolIndex, relativePath);
                            if (definition) {
                                fileEdges.push({
                                    source: `symbol:${relativePath}:${call.caller}`,
                                    target: `symbol:${definition.relativePath}:${definition.name}`,
                                    type: 'calls',
                                    weight: 1
                                });
                            }
                        }
                        return fileEdges;
                    } catch {
                        return [];
                    }
                })
            );

            // Collect edges from batch
            for (const fileEdges of batchResults) {
                edges.push(...fileEdges);
            }

            processedCount += batch.length;
            onProgress?.(`Analyzing calls ${processedCount}/${files.length}`, processedCount, files.length);
            
            // CRITICAL: Yield to event loop every batch
            await new Promise(resolve => setImmediate(resolve));
        }

        return edges;
    }

    private buildSymbolIndex(
        symbolsByFile: Map<string, SymbolReference[]>
    ): Map<string, SymbolReference[]> {
        const index = new Map<string, SymbolReference[]>();

        for (const [filePath, symbols] of symbolsByFile.entries()) {
            for (const symbol of symbols) {
                if (symbol.type === 'function' || symbol.type === 'method') {
                    const existing = index.get(symbol.name) || [];
                    existing.push({ ...symbol, filePath });
                    index.set(symbol.name, existing);
                }
            }
        }

        return index;
    }

    private extractCalls(
        content: string,
        fileRelativePath: string,
        language: string
    ): { caller: string; callee: string; line: number; column: number }[] {
        const calls: { caller: string; callee: string; line: number; column: number }[] = [];
        const lines = content.split('\n');
        const patterns = this.callPatterns[language] || [];

        // Get defined symbols in this file for context
        const definedSymbols = new Set<string>();

        // First pass: collect defined symbols
        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            // Match function/class definitions
            const defMatch = line.match(/(?:function|class|const|let|var|def|fn)\s+(\w+)/);
            if (defMatch) {
                definedSymbols.add(defMatch[1]);
            }
        }

        // Second pass: find calls
        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];

            for (const pattern of patterns) {
                pattern.lastIndex = 0;
                let match;

                while ((match = pattern.exec(line)) !== null) {
                    const callee = match[1];

                    // Skip keywords, built-ins, and self-calls
                    if (this.isBuiltin(callee) || callee === 'this') continue;

                    // Find what function we're currently in
                    const caller = this.findCurrentScope(lines, lineNum);

                    calls.push({
                        caller,
                        callee,
                        line: lineNum,
                        column: match.index
                    });
                }
            }
        }

        return calls;
    }

    private findCurrentScope(lines: string[], currentLine: number): string {
        // Look backwards to find the current function/class definition
        for (let i = currentLine - 1; i >= 0; i--) {
            const line = lines[i];

            // Check for function definition
            const funcMatch = line.match(/(?:function|def|fn|async\s+(?:function|def))\s+(\w+)/);
            if (funcMatch) return funcMatch[1];

            // Check for method definition
            const methodMatch = line.match(/(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/);
            if (methodMatch) return methodMatch[1];

            // Check for class definition
            const classMatch = line.match(/class\s+(\w+)/);
            if (classMatch) return classMatch[1];
        }

        return '<top-level>';
    }

    private isBuiltin(name: string): boolean {
        const builtins = new Set([
            'console', 'process', 'require', 'module', 'exports', 'setTimeout',
            'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
            'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
            'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
            'parseInt', 'parseFloat', 'isNaN', 'isFinite',
            'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
            'print', 'input', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'tuple',
            'open', 'file', 'os', 'sys', 'path',
        ]);
        return builtins.has(name);
    }

    private findDefinition(
        callee: string,
        symbolIndex: Map<string, SymbolReference[]>,
        currentFile: string
    ): SymbolReference | null {
        const candidates = symbolIndex.get(callee);
        if (!candidates) return null;

        if (candidates.length === 1) {
            return candidates[0];
        }

        // If multiple definitions, prefer same-file definition
        const sameFile = candidates.find(c => c.filePath === currentFile);
        if (sameFile) return sameFile;

        // Fall back to first definition
        return candidates[0];
    }

    private getLanguage(ext: string): string | null {
        const langMap: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.py': 'python',
            '.rs': 'rust',
            '.go': 'go',
            '.java': 'java'
        };
        return langMap[ext] || null;
    }
}
