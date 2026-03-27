/**
 * Phase 3a: Import Processor
 * Resolves import statements and creates IMPORTS edges between files.
 *
 * CHANGE: Accepts FileCache instead of reading files from disk.
 * Also: resolveImportPath no longer calls fs.existsSync for every candidate
 * extension — it checks against the set of cached paths instead (pure RAM lookup).
 */

import * as path from 'path';
import { GraphEdge } from './IndexerService';
import { FileCache } from './FileCache';

export class ImportProcessor {
    private readonly importPatterns: RegExp[] = [
        /import\s+(?:[\w*{}\s,]+)\s+from\s+['"]([^'"]+)['"]/g,
        /import\s+['"]([^'"]+)['"]/g,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /from\s+([\w.]+)\s+import/g,
        /^import\s+([\w.]+)/gm,
    ];

    /**
     * @param cache       Pre-loaded file cache (no disk I/O here)
     * @param rootPath    Workspace root
     * @param onProgress  Optional progress callback
     */
    async process(
        cache: FileCache,
        rootPath: string,
        onProgress?: (message: string, current: number, total: number) => void
    ): Promise<GraphEdge[]> {
        const edges: GraphEdge[] = [];

        // Build a Set of all relative paths so resolveImportPath can do RAM lookups
        const cachedRelPaths = new Set<string>();
        for (const [, entry] of cache.entries()) {
            cachedRelPaths.add(entry.relativePath.replace(/\\/g, '/'));
        }

        const entries = [...cache.entries()];
        const total = entries.length;
        const BATCH = 100;
        let processed = 0;

        for (let i = 0; i < entries.length; i += BATCH) {
            const batch = entries.slice(i, i + BATCH);

            for (const [, { content, relativePath }] of batch) {
                const imports = this.extractImports(content, relativePath, cachedRelPaths);
                for (const imp of imports) {
                    if (imp.targetFile) {
                        edges.push({
                            source: `file:${imp.sourceFile}`,
                            target: `file:${imp.targetFile}`,
                            type: 'imports',
                            weight: 1,
                        });
                    }
                }
                processed++;
            }

            onProgress?.(`Resolving imports ${processed}/${total}`, processed, total);
            await new Promise<void>(resolve => setImmediate(resolve));
        }

        return edges;
    }

    // ─── private ─────────────────────────────────────────────────────────────

    private extractImports(
        content: string,
        sourceRelativePath: string,
        cachedRelPaths: Set<string>
    ): Array<{ sourceFile: string; targetFile: string | null; importPath: string }> {
        const imports: Array<{ sourceFile: string; targetFile: string | null; importPath: string }> = [];

        for (const pattern of this.importPatterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(content)) !== null) {
                const importPath = match[1];
                const resolved = this.resolveImportPath(
                    sourceRelativePath.replace(/\\/g, '/'),
                    importPath,
                    cachedRelPaths
                );
                imports.push({ sourceFile: sourceRelativePath, targetFile: resolved, importPath });
            }
        }

        return imports;
    }

    /**
     * Resolve a relative import path to a cached relative path.
     * Uses Set lookups (O(1) RAM) instead of fs.existsSync (O(1) but disk).
     */
    private resolveImportPath(
        sourceRelPath: string,
        importPath: string,
        cachedRelPaths: Set<string>
    ): string | null {
        // Skip node_modules and absolute paths
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;

        const sourceDir = path.posix.dirname(sourceRelPath);
        const base = path.posix.resolve('/', sourceDir, importPath).substring(1); // strip leading /

        // Candidate list: exact match first, then extensions, then /index.*
        const candidates = [
            base,
            ...[ '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java' ].map(e => base + e),
            ...[ '.ts', '.tsx', '.js', '.jsx' ].map(e => base + '/index' + e),
        ];

        for (const candidate of candidates) {
            if (cachedRelPaths.has(candidate)) {
                return candidate;
            }
        }

        return null;
    }
}
