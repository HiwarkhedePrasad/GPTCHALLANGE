/**
 * Phase 4: Cluster Enricher
 * Enriches clusters with metadata, entry points, and cross-cluster relationships
 */

import { GraphNode, GraphEdge, ClusterInfo } from './IndexerService';

export interface EnrichedCluster extends ClusterInfo {
    entryPoints: string[];
    totalConnections: number;
    crossClusterConnections: number;
    languages: string[];
    description?: string;
}

export interface ClusterRelationships {
    clusterA: number;
    clusterB: number;
    strength: number;
    edgeCount: number;
}

export class ClusterEnricher {
    enrich(
        clusters: ClusterInfo[],
        nodes: GraphNode[],
        edges: GraphEdge[],
        nodeClusterMap: Map<string, number>
    ): EnrichedCluster[] {
        return clusters.map(cluster => this.enrichCluster(cluster, nodes, edges, nodeClusterMap));
    }

    private enrichCluster(
        cluster: ClusterInfo,
        nodes: GraphNode[],
        edges: GraphEdge[],
        nodeClusterMap: Map<string, number>
    ): EnrichedCluster {
        // Get nodes in this cluster
        const clusterNodes = nodes.filter(n => nodeClusterMap.get(n.id) === cluster.id);

        // Find entry points (symbols that are called from outside the cluster)
        const entryPoints = this.findEntryPoints(clusterNodes, nodes, edges, nodeClusterMap);

        // Calculate total connections
        const clusterNodeIds = new Set(clusterNodes.map(n => n.id));
        let totalConnections = 0;
        let crossClusterConnections = 0;

        for (const edge of edges) {
            if (clusterNodeIds.has(edge.source)) {
                totalConnections++;
                if (!clusterNodeIds.has(edge.target)) {
                    crossClusterConnections++;
                }
            }
            if (clusterNodeIds.has(edge.target)) {
                totalConnections++;
                if (!clusterNodeIds.has(edge.source)) {
                    crossClusterConnections++;
                }
            }
        }

        // Collect languages used
        const languages = new Set<string>();
        for (const node of clusterNodes) {
            if (node.type === 'file' && node.metadata?.['language']) {
                languages.add(node.metadata['language'] as string);
            }
        }

        // Generate description
        const description = this.generateDescription(cluster, clusterNodes);

        return {
            ...cluster,
            entryPoints,
            totalConnections,
            crossClusterConnections,
            languages: Array.from(languages),
            description
        };
    }

    private findEntryPoints(
        clusterNodes: GraphNode[],
        allNodes: GraphNode[],
        edges: GraphEdge[],
        nodeClusterMap: Map<string, number>
    ): string[] {
        const clusterNodeIds = new Set(clusterNodes.map(n => n.id));
        const entryPointIds = new Set<string>();

        // Find nodes that are called from outside the cluster
        for (const edge of edges) {
            if (edge.type !== 'calls') continue;

            const targetCluster = nodeClusterMap.get(edge.target);
            const sourceCluster = nodeClusterMap.get(edge.source);

            // If called from outside, it's an entry point
            if (targetCluster !== undefined && sourceCluster !== undefined) {
                if (targetCluster === sourceCluster) continue;
                entryPointIds.add(edge.target);
            }
        }

        // Also consider nodes with no internal callers as entry points
        for (const node of clusterNodes) {
            if (node.type !== 'function' && node.type !== 'method') continue;

            const hasInternalCaller = edges.some(e =>
                e.target === node.id &&
                clusterNodeIds.has(e.source) &&
                e.type === 'calls'
            );

            if (!hasInternalCaller && node.connections && node.connections > 0) {
                entryPointIds.add(node.id);
            }
        }

        return Array.from(entryPointIds).slice(0, 10);
    }

    private generateDescription(cluster: ClusterInfo, nodes: GraphNode[]): string {
        const symbolTypes = new Set(nodes.map(n => n.type));
        const hasClasses = symbolTypes.has('class');
        const hasFunctions = symbolTypes.has('function');
        const hasInterfaces = symbolTypes.has('interface');

        const parts: string[] = [];

        if (hasClasses) parts.push('defines classes');
        if (hasFunctions) parts.push('contains functions');
        if (hasInterfaces) parts.push('declares interfaces');

        if (cluster.nodeCount > 20) {
            parts.push('a complex module');
        } else if (cluster.nodeCount > 10) {
            parts.push('a moderately sized module');
        } else {
            parts.push('a small focused module');
        }

        return parts.join(' and ') || 'A code community';
    }

    /**
     * Analyze relationships between clusters
     */
    analyzeClusterRelationships(
        clusters: ClusterInfo[],
        edges: GraphEdge[],
        nodeClusterMap: Map<string, number>
    ): ClusterRelationships[] {
        const relationships = new Map<string, ClusterRelationships>();

        for (const edge of edges) {
            const clusterA = nodeClusterMap.get(edge.source);
            const clusterB = nodeClusterMap.get(edge.target);

            if (clusterA === undefined || clusterB === undefined || clusterA === clusterB) {
                continue;
            }

            // Create a canonical key (lower cluster ID first)
            const key = clusterA < clusterB ? `${clusterA}-${clusterB}` : `${clusterB}-${clusterA}`;

            const existing = relationships.get(key);
            if (existing) {
                existing.edgeCount++;
                existing.strength = Math.min(1, existing.edgeCount / 10);
            } else {
                relationships.set(key, {
                    clusterA,
                    clusterB,
                    edgeCount: 1,
                    strength: 0.1
                });
            }
        }

        return Array.from(relationships.values())
            .filter(r => r.edgeCount >= 3) // Only meaningful connections
            .sort((a, b) => b.edgeCount - a.edgeCount);
    }

    /**
     * Get cluster statistics
     */
    getClusterStats(enrichedClusters: EnrichedCluster[]): {
        totalClusters: number;
        avgClusterSize: number;
        largestCluster: number;
        mostConnected: number;
    } {
        if (enrichedClusters.length === 0) {
            return { totalClusters: 0, avgClusterSize: 0, largestCluster: 0, mostConnected: 0 };
        }

        const totalSize = enrichedClusters.reduce((sum, c) => sum + c.nodeCount, 0);
        const largest = enrichedClusters.reduce((max, c) =>
            c.nodeCount > max.nodeCount ? c : max
        );
        const mostConnected = enrichedClusters.reduce((max, c) =>
            c.totalConnections > max.totalConnections ? c : max
        );

        return {
            totalClusters: enrichedClusters.length,
            avgClusterSize: Math.round(totalSize / enrichedClusters.length),
            largestCluster: largest.id,
            mostConnected: mostConnected.id
        };
    }
}
