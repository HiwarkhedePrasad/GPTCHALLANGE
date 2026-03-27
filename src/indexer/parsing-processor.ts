/**
 * Phase 2: Parsing Processor
 * Extracts symbols (functions, classes, interfaces, methods) from source files.
 *
 * CHANGE: Accepts a FileCache instead of reading from disk.
 * All file I/O is now done once in the pipeline (FileCache.load) — this
 * processor only does CPU work (regex matching) from that in-memory store.
 */

import { FileCache } from './FileCache';

export interface ParsedSymbol {
    name: string;
    type: 'function' | 'class' | 'interface' | 'method' | 'variable' | 'type';
    location: { line: number; column: number };
    metadata: Record<string, unknown>;
}

export class ParsingProcessor {
    /**
     * Parse all files in the cache.
     *
     * No disk I/O here — works entirely from RAM.
     * Batching + setImmediate keeps VS Code responsive.
     */
    async parseFiles(
        cache: FileCache,
        onProgress?: (message: string, current: number, total: number) => void
    ): Promise<Map<string, ParsedSymbol[]>> {
        const symbolsByFile = new Map<string, ParsedSymbol[]>();
        const entries = [...cache.entries()];          // snapshot once
        const total = entries.length;
        const BATCH = 100;                             // larger batch is fine — no I/O cost
        let processed = 0;

        for (let i = 0; i < entries.length; i += BATCH) {
            const batch = entries.slice(i, i + BATCH);

            // Pure CPU — synchronous is fine inside a batch this size
            for (const [absPath, { content, ext }] of batch) {
                const symbols = this.extractSymbols(content, ext);
                if (symbols.length > 0) {
                    symbolsByFile.set(absPath, symbols);
                }
                processed++;
            }

            onProgress?.(`Parsing ${processed}/${total} files`, processed, total);

            // Yield once per batch
            await new Promise<void>(resolve => setImmediate(resolve));
        }

        return symbolsByFile;
    }

    extractSymbols(content: string, ext: string): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const lines = content.split('\n');

        if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
            symbols.push(...this.extractJSSymbols(lines));
        }
        if (['.py', '.pyw'].includes(ext)) {
            symbols.push(...this.extractPySymbols(lines));
        }
        if (ext === '.rs') {
            symbols.push(...this.extractRustSymbols(lines));
        }
        if (ext === '.go') {
            symbols.push(...this.extractGoSymbols(lines));
        }
        if (ext === '.java') {
            symbols.push(...this.extractJavaSymbols(lines));
        }

        return symbols;
    }

    // ─── language extractors (unchanged logic, just private) ─────────────────

    private extractJSSymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,               type: 'function'  as const },
            { regex: /(?:export\s+)?class\s+(\w+)/g,                               type: 'class'     as const },
            { regex: /(?:export\s+)?interface\s+(\w+)/g,                           type: 'interface' as const },
            { regex: /(?:export\s+)?type\s+(\w+)/g,                                type: 'type'      as const },
            { regex: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g,               type: 'variable'  as const },
            { regex: /(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/g,                    type: 'method'    as const },
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const { regex, type } of patterns) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(line)) !== null) {
                    if (this.isLikelyDeclaration(match[0])) {
                        symbols.push({ name: match[1], type, location: { line: lineNum, column: match.index }, metadata: {} });
                    }
                }
            }
        }
        return symbols;
    }

    private extractPySymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /^def\s+(\w+)/g,                                              type: 'function' as const },
            { regex: /^class\s+(\w+)/g,                                            type: 'class'    as const },
            { regex: /^\s+def\s+(\w+)/g,                                           type: 'method'   as const },
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const { regex, type } of patterns) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(line)) !== null) {
                    symbols.push({ name: match[1], type, location: { line: lineNum, column: match.index }, metadata: {} });
                }
            }
        }
        return symbols;
    }

    private extractRustSymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g,                       type: 'function'  as const },
            { regex: /(?:pub\s+)?struct\s+(\w+)/g,                                 type: 'class'     as const },
            { regex: /(?:pub\s+)?enum\s+(\w+)/g,                                   type: 'class'     as const },
            { regex: /(?:pub\s+)?trait\s+(\w+)/g,                                  type: 'interface' as const },
            { regex: /(?:pub\s+)?type\s+(\w+)/g,                                   type: 'type'      as const },
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const { regex, type } of patterns) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(line)) !== null) {
                    symbols.push({ name: match[1], type, location: { line: lineNum, column: match.index }, metadata: {} });
                }
            }
        }
        return symbols;
    }

    private extractGoSymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /func\s+(\w+)\s*\(/g,                                         type: 'function'  as const },
            { regex: /func\s+\(\w+\s+\*?\w+\)\s+(\w+)\s*\(/g,                     type: 'method'    as const },
            { regex: /type\s+(\w+)\s+struct/g,                                     type: 'class'     as const },
            { regex: /type\s+(\w+)\s+interface/g,                                  type: 'interface' as const },
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const { regex, type } of patterns) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(line)) !== null) {
                    symbols.push({ name: match[1], type, location: { line: lineNum, column: match.index }, metadata: {} });
                }
            }
        }
        return symbols;
    }

    private extractJavaSymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /(?:public|private|protected)?\s*(?:static\s+)?(?:void|int|String|boolean|float|double)\s+(\w+)\s*\(/g, type: 'function'  as const },
            { regex: /class\s+(\w+)/g,                                              type: 'class'     as const },
            { regex: /interface\s+(\w+)/g,                                          type: 'interface' as const },
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const { regex, type } of patterns) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(line)) !== null) {
                    symbols.push({ name: match[1], type, location: { line: lineNum, column: match.index }, metadata: {} });
                }
            }
        }
        return symbols;
    }

    private isLikelyDeclaration(text: string): boolean {
        const falsePositives = ['if (', 'while (', 'for (', 'switch (', 'catch (', 'with ('];
        return !falsePositives.some(fp => text.includes(fp));
    }
}
