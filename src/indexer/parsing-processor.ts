/**
 * Phase 2: Parsing Processor
 * Extracts symbols (functions, classes, interfaces, methods) from source files
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ParsedSymbol {
    name: string;
    type: 'function' | 'class' | 'interface' | 'method' | 'variable' | 'type';
    location: { line: number; column: number };
    metadata: Record<string, unknown>;
}

export interface FileSymbols {
    filePath: string;
    relativePath: string;
    symbols: ParsedSymbol[];
}

export class ParsingProcessor {
    async parseFiles(
        files: string[],
        rootPath: string,
        onProgress?: (message: string, current: number, total: number) => void
    ): Promise<Map<string, ParsedSymbol[]>> {
        const symbolsByFile = new Map<string, ParsedSymbol[]>();
        const total = files.length;

        // Process files in parallel batches for better performance
        const BATCH_SIZE = 50; // Process 50 files at a time
        const batches: string[][] = [];
        
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            batches.push(files.slice(i, i + BATCH_SIZE));
        }

        let processedCount = 0;

        for (const batch of batches) {
            // Parse all files in this batch in parallel
            const batchPromises = batch.map(async (file) => {
                try {
                    const content = await fs.promises.readFile(file, 'utf-8');
                    const ext = path.extname(file).toLowerCase();
                    const symbols = this.extractSymbols(content, ext);
                    return { file, symbols };
                } catch {
                    return null; // Skip files that can't be read
                }
            });

            const results = await Promise.all(batchPromises);
            
            for (const result of results) {
                if (result) {
                    symbolsByFile.set(result.file, result.symbols);
                }
            }

            processedCount += batch.length;
            onProgress?.(`Parsing ${processedCount}/${total} files`, processedCount, total);
            
            // CRITICAL: Yield to event loop every batch to prevent freezing VS Code
            await new Promise(resolve => setImmediate(resolve));
        }

        return symbolsByFile;
    }

    extractSymbols(content: string, ext: string): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const lines = content.split('\n');

        // TypeScript/JavaScript patterns
        if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
            symbols.push(...this.extractJSSymbols(lines));
        }

        // Python patterns
        if (['.py', '.pyw'].includes(ext)) {
            symbols.push(...this.extractPySymbols(lines));
        }

        // Rust patterns
        if (ext === '.rs') {
            symbols.push(...this.extractRustSymbols(lines));
        }

        // Go patterns
        if (ext === '.go') {
            symbols.push(...this.extractGoSymbols(lines));
        }

        // Java patterns
        if (ext === '.java') {
            symbols.push(...this.extractJavaSymbols(lines));
        }

        return symbols;
    }

    private extractJSSymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, type: 'function' as const },
            { regex: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?/g, type: 'class' as const },
            { regex: /(?:export\s+)?interface\s+(\w+)/g, type: 'interface' as const },
            { regex: /(?:export\s+)?type\s+(\w+)/g, type: 'type' as const },
            { regex: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g, type: 'variable' as const },
            { regex: /(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/g, type: 'method' as const }
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const pattern of patterns) {
                pattern.regex.lastIndex = 0;
                let match;
                while ((match = pattern.regex.exec(line)) !== null) {
                    // Skip matches that are clearly not declarations
                    if (this.isLikelyDeclaration(match[0])) {
                        symbols.push({
                            name: match[1],
                            type: pattern.type,
                            location: { line: lineNum, column: match.index },
                            metadata: {}
                        });
                    }
                }
            }
        }

        return symbols;
    }

    private extractPySymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /^def\s+(\w+)/gm, type: 'function' as const },
            { regex: /^class\s+(\w+)(?:\([^)]*\))?/gm, type: 'class' as const },
            { regex: /^\s+def\s+(\w+)/gm, type: 'method' as const },
            { regex: /^\s*(\w+)\s*=\s*(?:lambda|async\s+lambda)/gm, type: 'variable' as const }
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const pattern of patterns) {
                pattern.regex.lastIndex = 0;
                let match;
                while ((match = pattern.regex.exec(line)) !== null) {
                    symbols.push({
                        name: match[1],
                        type: pattern.type,
                        location: { line: lineNum, column: match.index },
                        metadata: {}
                    });
                }
            }
        }

        return symbols;
    }

    private extractRustSymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g, type: 'function' as const },
            { regex: /(?:pub\s+)?struct\s+(\w+)/g, type: 'class' as const },
            { regex: /(?:pub\s+)?enum\s+(\w+)/g, type: 'class' as const },
            { regex: /(?:pub\s+)?trait\s+(\w+)/g, type: 'interface' as const },
            { regex: /(?:pub\s+)?impl(?:\s+<[^>]+>)?\s+(\w+)/g, type: 'method' as const },
            { regex: /(?:pub\s+)?type\s+(\w+)/g, type: 'type' as const },
            { regex: /(?:pub\s+)?(?:const|let|static)\s+(\w+)/g, type: 'variable' as const }
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const pattern of patterns) {
                pattern.regex.lastIndex = 0;
                let match;
                while ((match = pattern.regex.exec(line)) !== null) {
                    symbols.push({
                        name: match[1],
                        type: pattern.type,
                        location: { line: lineNum, column: match.index },
                        metadata: {}
                    });
                }
            }
        }

        return symbols;
    }

    private extractGoSymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /func\s+(\w+)\s*\(/g, type: 'function' as const },
            { regex: /func\s+\((\w+)\s+\*?\w+\)\s+(\w+)\s*\(/g, type: 'method' as const },
            { regex: /type\s+(\w+)\s+struct/g, type: 'class' as const },
            { regex: /type\s+(\w+)\s+interface/g, type: 'interface' as const },
            { regex: /type\s+(\w+)\s+/g, type: 'type' as const }
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const pattern of patterns) {
                pattern.regex.lastIndex = 0;
                let match;
                while ((match = pattern.regex.exec(line)) !== null) {
                    const name = pattern.type === 'method' ? match[2] : match[1];
                    symbols.push({
                        name,
                        type: pattern.type,
                        location: { line: lineNum, column: match.index },
                        metadata: {}
                    });
                }
            }
        }

        return symbols;
    }

    private extractJavaSymbols(lines: string[]): ParsedSymbol[] {
        const symbols: ParsedSymbol[] = [];
        const patterns = [
            { regex: /(?:public|private|protected)?\s*(?:static)?\s*(?:final)?\s*(?:void|int|String|boolean|float|double|class|interface|enum)\s+(\w+)\s*\(/g, type: 'function' as const },
            { regex: /class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?/g, type: 'class' as const },
            { regex: /interface\s+(\w+)/g, type: 'interface' as const },
            { regex: /enum\s+(\w+)/g, type: 'class' as const },
            { regex: /(?:public|private|protected)?\s*(?:static)?\s*(\w+)\s+\w+\s*;/g, type: 'variable' as const }
        ];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            for (const pattern of patterns) {
                pattern.regex.lastIndex = 0;
                let match;
                while ((match = pattern.regex.exec(line)) !== null) {
                    symbols.push({
                        name: match[1],
                        type: pattern.type,
                        location: { line: lineNum, column: match.index },
                        metadata: {}
                    });
                }
            }
        }

        return symbols;
    }

    private isLikelyDeclaration(text: string): boolean {
        // Filter out false positives like "if (condition) {"
        const falsePositives = ['if (', 'while (', 'for (', 'switch (', 'catch (', 'with ('];
        return !falsePositives.some(fp => text.includes(fp));
    }
}
