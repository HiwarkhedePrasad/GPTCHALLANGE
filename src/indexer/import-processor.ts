/**
 * Phase 3: Import Processor
 * Resolves import statements and creates IMPORTS edges between files
 */

import * as fs from 'fs';
import * as path from 'path';
import { GraphEdge } from './IndexerService';

export interface ImportEdge {
    sourceFile: string;
    targetFile: string | null;
    importPath: string;
    isResolved: boolean;
}

export class ImportProcessor {
    private importPatterns: RegExp[] = [
        // ES6 imports: import x from 'path'
        /import\s+(?:(?:[\w*{}\s]+,?\s*)+)\s+from\s+['"]([^'"]+)['"]/g,
        // ES6 side-effect import: import 'path'
        /import\s+['"]([^'"]+)['"]/g,
        // CommonJS require: require('path')
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        // Python imports: from x import y
        /from\s+([\w.]+)\s+import/g,
        // Python direct import: import x
        /import\s+([\w.]+)/g,
    ];

    async process(
        files: string[],
        rootPath: string,
        onProgress?: (message: string, current: number, total: number) => void
    ): Promise<GraphEdge[]> {
        const edges: GraphEdge[] = [];

        // Process files in parallel batches
        const BATCH_SIZE = 50;
        let processedCount = 0;

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, Math.min(i + BATCH_SIZE, files.length));

            const batchResults = await Promise.all(
                batch.map(async (file) => {
                    const relativePath = path.relative(rootPath, file);
                    try {
                        const content = await fs.promises.readFile(file, 'utf-8');
                        return this.extractImports(content, relativePath);
                    } catch {
                        return [];
                    }
                })
            );

            // Collect edges from batch
            for (const importEdges of batchResults) {
                for (const imp of importEdges) {
                    if (imp.targetFile) {
                        edges.push({
                            source: `file:${imp.sourceFile}`,
                            target: `file:${imp.targetFile}`,
                            type: 'imports',
                            weight: 1
                        });
                    }
                }
            }

            processedCount += batch.length;
            onProgress?.(`Resolving imports ${processedCount}/${files.length}`, processedCount, files.length);
            
            // CRITICAL: Yield to event loop every batch
            await new Promise(resolve => setImmediate(resolve));
        }

        return edges;
    }

    private extractImports(content: string, sourceRelativePath: string): ImportEdge[] {
        const imports: ImportEdge[] = [];

        for (const pattern of this.importPatterns) {
            pattern.lastIndex = 0;
            let match;

            while ((match = pattern.exec(content)) !== null) {
                const importPath = match[1];
                const resolved = this.resolveImportPath(sourceRelativePath, importPath);

                imports.push({
                    sourceFile: sourceRelativePath,
                    targetFile: resolved,
                    importPath,
                    isResolved: resolved !== null
                });
            }
        }

        return imports;
    }

    private resolveImportPath(sourceFile: string, importPath: string): string | null {
        // Skip node_modules and absolute paths
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
            return null;
        }

        const sourceDir = path.dirname(sourceFile);
        let resolved = path.resolve(sourceDir, importPath);

        // Try with various extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', ''];

        for (const ext of extensions) {
            const withExt = resolved + ext;
            if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
                return path.relative(path.dirname(sourceFile), withExt);
            }
        }

        // Try index files
        for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
            const indexPath = path.join(resolved, `index${ext}`);
            if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
                return path.relative(path.dirname(sourceFile), indexPath);
            }
        }

        // Try as directory with package.json
        const pkgPath = path.join(resolved, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.main) {
                    const mainPath = path.join(resolved, pkg.main);
                    if (fs.existsSync(mainPath)) {
                        return path.relative(path.dirname(sourceFile), mainPath);
                    }
                }
            } catch {
                // Ignore package.json parse errors
            }
        }

        return null;
    }

    /**
     * Check if an import path is a relative import
     */
    isRelativeImport(importPath: string): boolean {
        return importPath.startsWith('.');
    }

    /**
     * Check if an import path is a node_modules import
     */
    isNodeModule(importPath: string): boolean {
        return !importPath.startsWith('.') && !importPath.startsWith('/');
    }
}
