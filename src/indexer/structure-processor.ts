/**
 * Phase 1: Structure Processor
 * Creates file nodes with CONTAINS edges to symbols
 * Note: We skip creating folder nodes for performance - the webview handles visualization
 */

import * as path from 'path';
import { GraphNode, GraphEdge } from './IndexerService';

export interface ProcessedStructure {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

export class StructureProcessor {
    process(
        files: string[],
        rootPath: string,
        getFileInfo: (path: string, root: string) => { path: string; relativePath: string; extension: string; language: string | null }
    ): ProcessedStructure {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];

        // Fast path: Pre-allocate arrays and use Maps for better performance
        const filesByTopDir = new Map<string, Set<string>>();

        // Single pass: group files and create file nodes immediately
        for (const file of files) {
            const relativePath = path.relative(rootPath, file);
            const parts = relativePath.split(path.sep);

            // Group by first directory level
            const topDir = parts.length > 1 ? parts[0] : '';
            if (!filesByTopDir.has(topDir)) {
                filesByTopDir.set(topDir, new Set());
            }
            filesByTopDir.get(topDir)!.add(relativePath);

            // Create file node immediately (avoiding second iteration)
            const info = getFileInfo(file, rootPath);
            nodes.push({
                id: `file:${relativePath}`,
                name: path.basename(relativePath),
                type: 'file',
                path: file,
                metadata: {
                    language: info.language,
                    extension: info.extension,
                    relativePath
                }
            });
        }

        // Create root folder node
        const rootFolderId = 'folder:';
        nodes.push({
            id: rootFolderId,
            name: 'root',
            type: 'folder',
            path: rootPath,
            metadata: { relativePath: '' }
        });

        // Create top-level folder nodes and edges
        for (const [topDir, dirFiles] of filesByTopDir.entries()) {
            if (!topDir) {
                // Handle files at root level
                for (const relativePath of dirFiles) {
                    edges.push({
                        source: rootFolderId,
                        target: `file:${relativePath}`,
                        type: 'contains',
                        weight: 1
                    });
                }
                continue;
            }

            const folderId = `folder:${topDir}`;
            nodes.push({
                id: folderId,
                name: topDir,
                type: 'folder',
                path: path.join(rootPath, topDir),
                metadata: { relativePath: topDir }
            });

            // Root contains this folder
            edges.push({
                source: rootFolderId,
                target: folderId,
                type: 'contains',
                weight: 1
            });

            // Folder contains files
            for (const relativePath of dirFiles) {
                edges.push({
                    source: folderId,
                    target: `file:${relativePath}`,
                    type: 'contains',
                    weight: 1
                });
            }
        }

        return { nodes, edges };
    }
}
