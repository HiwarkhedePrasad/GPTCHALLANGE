import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface FileInfo {
    path: string;
    content: string;
    encoding: string;
    size: number;
}

export interface WriteResult {
    success: boolean;
    path: string;
    bytesWritten: number;
}

export class FileSystemProvider {
    async readFile(filePath: string): Promise<FileInfo> {
        const resolvedPath = this.resolvePath(filePath);
        this.validatePath(resolvedPath);

        const content = await fs.promises.readFile(resolvedPath, 'utf-8');
        const stats = await fs.promises.stat(resolvedPath);

        return {
            path: resolvedPath,
            content,
            encoding: 'utf-8',
            size: stats.size
        };
    }

    async writeFile(filePath: string, content: string): Promise<WriteResult> {
        const resolvedPath = this.resolvePath(filePath);
        this.validatePath(resolvedPath);

        const dir = path.dirname(resolvedPath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(resolvedPath, content, 'utf-8');
        
        const stats = await fs.promises.stat(resolvedPath);

        return {
            success: true,
            path: resolvedPath,
            bytesWritten: stats.size
        };
    }

    async patchFile(filePath: string, patches: FilePatch[]): Promise<WriteResult> {
        const resolvedPath = this.resolvePath(filePath);
        this.validatePath(resolvedPath);

        let content = await fs.promises.readFile(resolvedPath, 'utf-8');
        const sortedPatches = [...patches].sort((a, b) => b.startLine - a.startLine);
        const lines = content.split('\n');
        
        for (const patch of sortedPatches) {
            const beforeLines = lines.slice(0, patch.startLine);
            const afterLines = lines.slice(patch.endLine + 1);
            const newLines = patch.newContent.split('\n');
            
            lines.length = 0;
            lines.push(...beforeLines, ...newLines, ...afterLines);
        }

        content = lines.join('\n');
        return this.writeFile(filePath, content);
    }

    async createFile(filePath: string, content: string): Promise<WriteResult> {
        const resolvedPath = this.resolvePath(filePath);
        this.validatePath(resolvedPath);

        if (fs.existsSync(resolvedPath)) {
            throw new Error(`File already exists: ${resolvedPath}`);
        }

        return this.writeFile(filePath, content);
    }

    async deleteFile(filePath: string): Promise<{ success: boolean; path: string }> {
        const resolvedPath = this.resolvePath(filePath);
        this.validatePath(resolvedPath);

        await fs.promises.unlink(resolvedPath);

        return { success: true, path: resolvedPath };
    }

    async listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
        const resolvedPath = this.resolvePath(dirPath);
        this.validatePath(resolvedPath);

        const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
        
        return entries.map(entry => ({
            name: entry.name,
            path: path.join(resolvedPath, entry.name),
            type: entry.isDirectory() ? 'directory' : 'file'
        }));
    }

    async fileExists(filePath: string): Promise<boolean> {
        const resolvedPath = this.resolvePath(filePath);
        try {
            await fs.promises.access(resolvedPath);
            return true;
        } catch {
            return false;
        }
    }

    private resolvePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return path.normalize(filePath);
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        return path.normalize(path.join(workspaceFolder.uri.fsPath, filePath));
    }

    private validatePath(resolvedPath: string): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;
        const normalizedPath = path.normalize(resolvedPath);
        const normalizedRoot = path.normalize(workspaceRoot);

        if (!normalizedPath.startsWith(normalizedRoot)) {
            throw new Error(`Access denied: Path is outside workspace: ${resolvedPath}`);
        }

        const blockedPatterns = [
            /\.env$/i, /\.env\.\w+$/i, /secrets?\./i, /credentials?\./i,
            /\.pem$/i, /\.key$/i, /id_rsa/i, /id_ed25519/i
        ];

        const basename = path.basename(normalizedPath);
        for (const pattern of blockedPatterns) {
            if (pattern.test(basename)) {
                throw new Error(`Access denied: Sensitive file blocked: ${basename}`);
            }
        }
    }
}

export interface FilePatch {
    startLine: number;
    endLine: number;
    newContent: string;
}

export interface DirectoryEntry {
    name: string;
    path: string;
    type: 'file' | 'directory';
}
