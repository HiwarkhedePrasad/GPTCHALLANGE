/**
 * Phase 1: Structure Processor
 * Creates file and folder nodes with CONTAINS edges
 * Creates FULL folder chain (e.g., src/indexer not just src)
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
        
        // Track created folder IDs to avoid duplicates
        const createdFolders = new Set<string>();

        // Create root folder node
        const rootFolderId = 'folder:';
        nodes.push({
            id: rootFolderId,
            name: 'root',
            type: 'folder',
            path: rootPath,
            metadata: { relativePath: '' }
        });
        createdFolders.add(rootFolderId);

        // Process each file - create full folder chain
        for (const file of files) {
            const relativePath = path.relative(rootPath, file).replace(/\\/g, '/');
            const parts = relativePath.split('/').filter(Boolean);
            
            // Build full folder chain: src/indexer/graph
            let parentId = rootFolderId;
            let folderPath = '';
            
            for (let i = 0; i < parts.length - 1; i++) {
                folderPath = folderPath ? folderPath + '/' + parts[i] : parts[i];
                const folderId = `folder:${folderPath}`;
                
                // Create folder if not exists
                if (!createdFolders.has(folderId)) {
                    nodes.push({
                        id: folderId,
                        name: parts[i],
                        type: 'folder',
                        path: path.join(rootPath, folderPath),
                        metadata: { relativePath: folderPath }
                    });
                    edges.push({
                        source: parentId,
                        target: folderId,
                        type: 'contains',
                        weight: 1
                    });
                    createdFolders.add(folderId);
                }
                parentId = folderId;
            }
            
            // Create file node
            const fileId = `file:${relativePath}`;
            const info = getFileInfo(file, rootPath);
            nodes.push({
                id: fileId,
                name: path.basename(relativePath),
                type: 'file',
                path: file,
                metadata: {
                    language: info.language,
                    extension: info.extension,
                    relativePath
                }
            });
            
            // Connect file to its parent folder
            edges.push({
                source: parentId,
                target: fileId,
                type: 'contains',
                weight: 1
            });
        }

        return { nodes, edges };
    }
}
