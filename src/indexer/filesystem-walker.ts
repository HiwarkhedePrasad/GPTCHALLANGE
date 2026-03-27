/**
 * Phase 1: Filesystem Walker
 * Walks the directory tree and collects all supported files
 */

import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';

export interface WalkResult {
    files: string[];
    rootPath: string;
    languages: Set<string>;
}

export interface FileInfo {
    path: string;
    relativePath: string;
    extension: string;
    language: string | null;
}

const SUPPORTED_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.pyw',
    '.rs',
    '.go',
    '.java',
    '.c', '.cpp', '.h', '.hpp',
    '.json', '.yaml', '.yml'
];

const LANGUAGE_MAP: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.pyw': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp'
};

export class FilesystemWalker {
    private ignoreInstance = ignore();

    async walk(
        rootPath: string,
        excludePatterns: string[] = [],
        onProgress?: (message: string) => void
    ): Promise<WalkResult> {
        const files: string[] = [];
        const languages = new Set<string>();

        // Load .gitignore
        await this.loadGitignore(rootPath);

        // Add exclude patterns from config
        excludePatterns.forEach(pattern => this.ignoreInstance.add(pattern));

        // Walk the directory tree
        await this.walkDirectory(rootPath, rootPath, files);

        // Determine languages
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            const lang = LANGUAGE_MAP[ext];
            if (lang) languages.add(lang);
        }

        onProgress?.(`Found ${files.length} files`);

        return { files, rootPath, languages };
    }

    private async loadGitignore(rootPath: string): Promise<void> {
        const gitignorePath = path.join(rootPath, '.gitignore');
        try {
            if (fs.existsSync(gitignorePath)) {
                const content = fs.readFileSync(gitignorePath, 'utf-8');
                this.ignoreInstance.add(content);
            }
        } catch {
            // Ignore errors reading gitignore
        }
    }

    private async walkDirectory(
        dir: string,
        rootPath: string,
        files: string[]
    ): Promise<void> {
        let entries: fs.Dirent[];
        try {
            // Use recursive readdir for better performance on modern systems
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return; // Skip directories that can't be read
        }

        // Separate directories and files for better performance
        const dirs: string[] = [];
        const foundFiles: string[] = [];

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(rootPath, fullPath);

            if (this.ignoreInstance.ignores(relativePath)) {
                continue;
            }

            if (entry.isDirectory()) {
                dirs.push(fullPath);
            } else if (entry.isFile() && this.isSupportedFile(entry.name)) {
                foundFiles.push(fullPath);
            }
        }

        // Add all files from this directory
        files.push(...foundFiles);

        // CRITICAL: Yield to event loop to prevent freezing VS Code
        await new Promise(resolve => setImmediate(resolve));

        // Process subdirectories in parallel (limited concurrency)
        const PARALLEL_DIRS = 10; // Process up to 10 directories at a time
        for (let i = 0; i < dirs.length; i += PARALLEL_DIRS) {
            const batch = dirs.slice(i, i + PARALLEL_DIRS);
            await Promise.all(
                batch.map(subdir => this.walkDirectory(subdir, rootPath, files))
            );
            
            // Yield after each batch of directories
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    private isSupportedFile(filename: string): boolean {
        return SUPPORTED_EXTENSIONS.some(ext => filename.endsWith(ext));
    }

    getFileInfo(filePath: string, rootPath: string): FileInfo {
        const relativePath = path.relative(rootPath, filePath);
        const ext = path.extname(filePath).toLowerCase();
        const language = LANGUAGE_MAP[ext] || null;

        return {
            path: filePath,
            relativePath,
            extension: ext,
            language
        };
    }
}
