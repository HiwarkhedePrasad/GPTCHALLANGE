/**
 * FileCache — loads ALL source files into RAM in one parallel burst.
 *
 * Every processor (parsing, imports, calls) then works from this
 * Map<absolutePath, content> instead of hitting the disk independently.
 *
 * On a 500-file repo this cuts disk reads from ~1500 (3 processors × 500)
 * down to exactly 500 — a 3× reduction before any other optimisation.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FileCacheEntry {
    content: string;
    relativePath: string;
    ext: string;
}

export class FileCache {
    /** absolute path → { content, relativePath, ext } */
    private store = new Map<string, FileCacheEntry>();
    private rootPath = '';

    // ─── public API ──────────────────────────────────────────────────────────

    /**
     * Load every file in `files` into RAM in one parallel burst.
     * Files that can't be read (binary, too large, permission error) are skipped silently.
     *
     * @param files      Absolute paths collected by FilesystemWalker
     * @param rootPath   Workspace root (used to compute relative paths)
     * @param maxFileSizeBytes  Skip files larger than this (default 512 KB).
     *                          Prevents accidentally loading generated/minified giants.
     * @param onProgress Optional callback — called after each batch of 100 files
     */
    async load(
        files: string[],
        rootPath: string,
        maxFileSizeBytes = 512 * 1024,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<void> {
        this.store.clear();
        this.rootPath = rootPath;

        const BATCH = 100;          // parallel reads per tick
        let loaded = 0;

        for (let i = 0; i < files.length; i += BATCH) {
            const batch = files.slice(i, i + BATCH);

            // All reads in this batch are parallel — no sequential awaits
            const results = await Promise.all(
                batch.map(absPath => this.readOne(absPath, rootPath, maxFileSizeBytes))
            );

            for (const entry of results) {
                if (entry) {
                    this.store.set(entry[0], entry[1]);
                }
            }

            loaded += batch.length;
            onProgress?.(loaded, files.length);

            // Yield once per batch so VS Code's event loop isn't starved
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    }

    /** Get file content by absolute path. Returns null if file wasn't cached. */
    get(absPath: string): FileCacheEntry | null {
        return this.store.get(absPath) ?? null;
    }

    /** Get file content by relative path (relative to rootPath). */
    getByRelative(relativePath: string): FileCacheEntry | null {
        const abs = path.join(this.rootPath, relativePath);
        return this.store.get(abs) ?? null;
    }

    /** Iterate all cached files. */
    entries(): IterableIterator<[string, FileCacheEntry]> {
        return this.store.entries();
    }

    get size(): number {
        return this.store.size;
    }

    /** Approximate total RAM used in bytes */
    get bytesUsed(): number {
        let total = 0;
        for (const entry of this.store.values()) {
            total += entry.content.length * 2; // UTF-16 chars ≈ 2 bytes each
        }
        return total;
    }

    // ─── private ─────────────────────────────────────────────────────────────

    private async readOne(
        absPath: string,
        rootPath: string,
        maxBytes: number
    ): Promise<[string, FileCacheEntry] | null> {
        try {
            const stat = await fs.promises.stat(absPath);

            // Skip files that are too large
            if (stat.size > maxBytes) return null;

            const content = await fs.promises.readFile(absPath, 'utf-8');
            const relativePath = path.relative(rootPath, absPath);
            const ext = path.extname(absPath).toLowerCase();

            return [absPath, { content, relativePath, ext }];
        } catch {
            // Binary files, permission errors, etc. — skip silently
            return null;
        }
    }
}
