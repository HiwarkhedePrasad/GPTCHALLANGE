/**
 * Phase 3b: Call Processor
 * Links function calls to definitions — creates CALLS edges.
 *
 * CHANGE: Accepts FileCache + pre-parsed symbol map instead of reading disk.
 * All content comes from RAM; the processor only does regex work.
 */

import * as path from 'path';
import { GraphEdge } from './IndexerService';
import { FileCache } from './FileCache';
import { ParsedSymbol } from './parsing-processor';

export interface SymbolReference {
    name: string;
    filePath: string;           // absolute path
    relativePath: string;
    type: 'function' | 'class' | 'interface' | 'method';
    location: { line: number; column: number };
}

export class CallProcessor {
    private readonly callPatterns: RegExp[] = [
        /\b(\w+)\s*\(/g,        // bare call: name()
        /\.(\w+)\s*\(/g,        // method call: obj.name()
    ];

    private readonly BUILTINS = new Set([
        'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof',
        'console', 'process', 'require', 'module', 'exports',
        'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
        'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
        'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
        'parseInt', 'parseFloat', 'isNaN', 'isFinite',
        'print', 'input', 'len', 'range', 'str', 'int', 'float',
        'this', 'super', 'new', 'delete', 'void',
    ]);

    /**
     * @param cache          Pre-loaded file cache
     * @param symbolsByFile  Output of ParsingProcessor.parseFiles (absolute path → symbols)
     * @param rootPath       Workspace root
     * @param onProgress     Optional progress callback
     */
    async process(
        cache: FileCache,
        symbolsByFile: Map<string, ParsedSymbol[]>,
        rootPath: string,
        onProgress?: (message: string, current: number, total: number) => void
    ): Promise<GraphEdge[]> {
        const edges: GraphEdge[] = [];

        // Build symbol index (name → list of definitions) once — pure RAM
        const symbolIndex = this.buildSymbolIndex(symbolsByFile, rootPath);

        const entries = [...cache.entries()];
        const total = entries.length;
        const BATCH = 100;
        let processed = 0;

        for (let i = 0; i < entries.length; i += BATCH) {
            const batch = entries.slice(i, i + BATCH);

            for (const [absPath, { content, relativePath, ext }] of batch) {
                const lang = this.langFromExt(ext);
                if (!lang) { processed++; continue; }

                const calls = this.extractCalls(content, relativePath);

                for (const call of calls) {
                    const def = this.findDefinition(call.callee, symbolIndex, relativePath);
                    if (def) {
                        const callerRelPath = relativePath.replace(/\\/g, '/');
                        edges.push({
                            source: `symbol:${callerRelPath}:${call.caller}`,
                            target: `symbol:${def.relativePath}:${def.name}`,
                            type: 'calls',
                            weight: 1,
                        });
                    }
                }

                processed++;
            }

            onProgress?.(`Analyzing calls ${processed}/${total}`, processed, total);
            await new Promise<void>(resolve => setImmediate(resolve));
        }

        return edges;
    }

    // ─── private ─────────────────────────────────────────────────────────────

    /**
     * Build a name → [definitions] index from the parsed symbol map.
     * Stores only functions and methods (the only things that can be "called").
     */
    private buildSymbolIndex(
        symbolsByFile: Map<string, ParsedSymbol[]>,
        rootPath: string
    ): Map<string, SymbolReference[]> {
        const index = new Map<string, SymbolReference[]>();

        for (const [absPath, symbols] of symbolsByFile.entries()) {
            const relativePath = path.relative(rootPath, absPath).replace(/\\/g, '/');
            for (const sym of symbols) {
                if (sym.type !== 'function' && sym.type !== 'method') continue;
                const ref: SymbolReference = { ...sym as any, filePath: absPath, relativePath };
                const list = index.get(sym.name) ?? [];
                list.push(ref);
                index.set(sym.name, list);
            }
        }

        return index;
    }

    private extractCalls(
        content: string,
        fileRelativePath: string
    ): Array<{ caller: string; callee: string; line: number }> {
        const calls: Array<{ caller: string; callee: string; line: number }> = [];
        const lines = content.split('\n');

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];

            for (const pattern of this.callPatterns) {
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(line)) !== null) {
                    const callee = match[1];
                    if (this.BUILTINS.has(callee)) continue;
                    if (callee.length <= 1) continue;           // single-char — almost always noise

                    const caller = this.findCurrentScope(lines, lineNum);
                    calls.push({ caller, callee, line: lineNum });
                }
            }
        }

        return calls;
    }

    /** Walk backwards from `currentLine` to find the enclosing function name. */
    private findCurrentScope(lines: string[], currentLine: number): string {
        for (let i = currentLine; i >= 0; i--) {
            const line = lines[i];
            const m =
                line.match(/(?:function|def|fn|async\s+function)\s+(\w+)/) ||
                line.match(/(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/);
            if (m) return m[1];
        }
        return '<top-level>';
    }

    private findDefinition(
        callee: string,
        index: Map<string, SymbolReference[]>,
        currentRelPath: string
    ): SymbolReference | null {
        const candidates = index.get(callee);
        if (!candidates || candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];
        // Prefer same-file definition
        return candidates.find(c => c.relativePath === currentRelPath) ?? candidates[0];
    }

    private langFromExt(ext: string): string | null {
        const map: Record<string, string> = {
            '.ts': 'typescript', '.tsx': 'typescript',
            '.js': 'javascript', '.jsx': 'javascript',
            '.mjs': 'javascript', '.cjs': 'javascript',
            '.py': 'python', '.pyw': 'python',
            '.rs': 'rust', '.go': 'go', '.java': 'java',
        };
        return map[ext] ?? null;
    }
}
