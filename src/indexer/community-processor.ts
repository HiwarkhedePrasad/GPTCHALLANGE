/**
 * Phase 4: Community Processor
 * Detects functional communities using Louvain-style modularity optimization
 */

import { GraphNode, GraphEdge, ClusterInfo } from './IndexerService';

export interface CommunityDetectionResult {
    clusters: ClusterInfo[];
    nodeClusterMap: Map<string, number>;
}

const COMMUNITY_COLORS = [
    '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
    '#3b82f6', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e',
    '#14b8a6', '#84cc16'
];

export class CommunityProcessor {
    process(nodes: GraphNode[], edges: GraphEdge[]): CommunityDetectionResult {
        // Only cluster symbol nodes (functions, classes, methods, interfaces)
        const symbolTypes = new Set(['function', 'class', 'method', 'interface']);
        const symbolNodes = nodes.filter(n => symbolTypes.has(n.type));

        // Build adjacency map using clustering edge types
        const clusteringEdgeTypes = new Set(['calls', 'imports', 'extends', 'implements']);
        const adjacency = this.buildAdjacency(symbolNodes, edges, clusteringEdgeTypes);

        // Filter to only nodes with at least one edge
        const connectedNodes = symbolNodes.filter(n => {
            const adj = adjacency.get(n.id);
            return adj && adj.size > 0;
        });

        if (connectedNodes.length === 0) {
            // Fallback: cluster by file/folder structure
            return this.clusterByStructure(nodes);
        }

        // Run Louvain-style community detection
        const nodeClusterMap = this.louvainCommunityDetection(connectedNodes, adjacency);

        // Also assign file nodes to clusters based on their symbols
        this.assignFileClusters(nodes, nodeClusterMap, symbolTypes);

        // Build cluster info
        const clusters = this.buildClusterInfo(nodes, nodeClusterMap);

        return { clusters, nodeClusterMap };
    }

    private buildAdjacency(
        nodes: GraphNode[],
        edges: GraphEdge[],
        edgeTypes: Set<string>
    ): Map<string, Map<string, number>> {
        const adjacency = new Map<string, Map<string, number>>();

        // Initialize adjacency for all symbol nodes
        for (const node of nodes) {
            adjacency.set(node.id, new Map());
        }

        // Add edges (undirected, weighted by frequency)
        for (const edge of edges) {
            if (!edgeTypes.has(edge.type)) continue;

            const sourceAdj = adjacency.get(edge.source);
            const targetAdj = adjacency.get(edge.target);

            if (sourceAdj && targetAdj) {
                // Undirected - add both directions
                sourceAdj.set(edge.target, (sourceAdj.get(edge.target) || 0) + 1);
                targetAdj.set(edge.source, (targetAdj.get(edge.source) || 0) + 1);
            }
        }

        return adjacency;
    }

    private louvainCommunityDetection(
        nodes: GraphNode[],
        adjacency: Map<string, Map<string, number>>
    ): Map<string, number> {
        const nodeClusterMap = new Map<string, number>();
        let communityCount = 0;

        // Initialize: each node in its own community
        for (const node of nodes) {
            nodeClusterMap.set(node.id, communityCount++);
        }

        // Calculate total edge weight
        let totalWeight = 0;
        for (const [_, neighbors] of adjacency) {
            for (const [__, weight] of neighbors) {
                totalWeight += weight;
            }
        }
        totalWeight /= 2; // Undirected, counted twice

        // Modularity optimization loop
        let improved = true;
        let iterations = 0;
        const maxIterations = 10;

        while (improved && iterations < maxIterations) {
            improved = false;
            iterations++;

            for (const node of nodes) {
                const currentComm = nodeClusterMap.get(node.id)!;
                const neighbors = adjacency.get(node.id) || new Map();

                // Calculate community weights
                const communityWeights = new Map<number, number>();

                for (const [neighborId, weight] of neighbors) {
                    const neighborComm = nodeClusterMap.get(neighborId);
                    if (neighborComm !== undefined) {
                        communityWeights.set(neighborComm, (communityWeights.get(neighborComm) || 0) + weight);
                    }
                }

                // Find best community to join
                let bestComm = currentComm;
                let bestGain = 0;

                for (const [comm, weight] of communityWeights) {
                    if (comm !== currentComm && weight > bestGain) {
                        bestGain = weight;
                        bestComm = comm;
                    }
                }

                // Move node if there's improvement
                if (bestComm !== currentComm && bestGain > 0) {
                    nodeClusterMap.set(node.id, bestComm);
                    improved = true;
                }
            }
        }

        // Renumber communities to be contiguous
        const usedCommunities = new Set(nodeClusterMap.values());
        const communityRemap = new Map<number, number>();
        let newId = 0;

        for (const comm of usedCommunities) {
            communityRemap.set(comm, newId++);
        }

        for (const [nodeId, comm] of nodeClusterMap) {
            nodeClusterMap.set(nodeId, communityRemap.get(comm)!);
        }

        return nodeClusterMap;
    }

    private assignFileClusters(
        nodes: GraphNode[],
        nodeClusterMap: Map<string, number>,
        symbolTypes: Set<string>
    ): void {
        // Assign file nodes to clusters based on their symbols
        for (const node of nodes) {
            if (node.type === 'file' && !nodeClusterMap.has(node.id) && node.path) {
                // Find most common cluster among symbols in this file
                const fileSymbols = nodes.filter(n =>
                    symbolTypes.has(n.type) &&
                    n.path === node.path &&
                    nodeClusterMap.has(n.id)
                );

                if (fileSymbols.length > 0) {
                    const clusterCounts = new Map<number, number>();
                    for (const sym of fileSymbols) {
                        const cluster = nodeClusterMap.get(sym.id)!;
                        clusterCounts.set(cluster, (clusterCounts.get(cluster) || 0) + 1);
                    }

                    let maxCount = 0;
                    let dominantCluster = 0;
                    for (const [cluster, count] of clusterCounts) {
                        if (count > maxCount) {
                            maxCount = count;
                            dominantCluster = cluster;
                        }
                    }
                    nodeClusterMap.set(node.id, dominantCluster);
                }
            }
        }
    }

    private buildClusterInfo(
        nodes: GraphNode[],
        nodeClusterMap: Map<string, number>
    ): ClusterInfo[] {
        // Group nodes by cluster
        const clusterMembers = new Map<number, string[]>();
        for (const [nodeId, cluster] of nodeClusterMap) {
            if (!clusterMembers.has(cluster)) {
                clusterMembers.set(cluster, []);
            }
            clusterMembers.get(cluster)!.push(nodeId);
        }

        // Build cluster info
        const clusters: ClusterInfo[] = [];

        for (const [clusterId, memberIds] of clusterMembers) {
            // Skip singleton clusters
            if (memberIds.length < 2) continue;

            const paths = memberIds
                .map(id => nodes.find(n => n.id === id)?.path)
                .filter(Boolean) as string[];

            const name = this.inferClusterName(paths, memberIds, nodes);

            clusters.push({
                id: clusterId,
                name,
                color: COMMUNITY_COLORS[clusterId % COMMUNITY_COLORS.length],
                nodeCount: memberIds.length
            });
        }

        // Sort by size descending
        clusters.sort((a, b) => b.nodeCount - a.nodeCount);

        return clusters;
    }

    private inferClusterName(
        paths: string[],
        memberIds: string[],
        nodes: GraphNode[]
    ): string {
        // Try to infer from common path prefix
        if (paths.length > 0) {
            const parts = paths.map(p => p.split(/[/\\]/));
            const minLength = Math.min(...parts.map(p => p.length));

            let commonPrefix: string[] = [];
            for (let i = 0; i < minLength; i++) {
                const part = parts[0][i];
                if (parts.every(p => p[i] === part)) {
                    commonPrefix.push(part);
                } else {
                    break;
                }
            }

            for (let i = commonPrefix.length - 1; i >= 0; i--) {
                const name = commonPrefix[i];
                if (name && !['src', 'lib', 'dist', 'build', 'node_modules'].includes(name.toLowerCase())) {
                    return name.charAt(0).toUpperCase() + name.slice(1);
                }
            }
        }

        // Try to infer from symbol names
        const symbolNames = memberIds
            .map(id => nodes.find(n => n.id === id)?.name)
            .filter(Boolean) as string[];

        if (symbolNames.length > 0) {
            const prefixCounts = new Map<string, number>();
            for (const name of symbolNames) {
                const match = name.match(/^([a-z]+)/i);
                if (match) {
                    const prefix = match[1].toLowerCase();
                    if (prefix.length >= 3) {
                        prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
                    }
                }
            }

            let maxCount = 0;
            let bestPrefix = '';
            for (const [prefix, count] of prefixCounts) {
                if (count > maxCount && count >= 2) {
                    maxCount = count;
                    bestPrefix = prefix;
                }
            }

            if (bestPrefix) {
                return bestPrefix.charAt(0).toUpperCase() + bestPrefix.slice(1);
            }
        }

        return `Community ${paths.length + 1}`;
    }

    private clusterByStructure(nodes: GraphNode[]): CommunityDetectionResult {
        const nodeClusterMap = new Map<string, number>();
        const directoryClusters = new Map<string, number>();
        let clusterId = 0;

        for (const node of nodes) {
            if (!node.path) continue;

            // Get parent directory (2 levels up for better grouping)
            const parts = node.path.split(/[/\\]/);
            const keyParts = parts.slice(0, Math.min(parts.length - 1, 3));
            const dirKey = keyParts.join('/');

            if (!directoryClusters.has(dirKey)) {
                directoryClusters.set(dirKey, clusterId++);
            }

            nodeClusterMap.set(node.id, directoryClusters.get(dirKey)!);
        }

        const clusterMembers = new Map<number, string[]>();
        for (const [nodeId, cluster] of nodeClusterMap) {
            if (!clusterMembers.has(cluster)) {
                clusterMembers.set(cluster, []);
            }
            clusterMembers.get(cluster)!.push(nodeId);
        }

        const clusters: ClusterInfo[] = [];
        for (const [id, memberIds] of clusterMembers) {
            if (memberIds.length < 2) continue;

            const paths = memberIds
                .map(nid => nodes.find(n => n.id === nid)?.path)
                .filter(Boolean) as string[];

            clusters.push({
                id,
                name: this.inferClusterName(paths, memberIds, nodes),
                color: COMMUNITY_COLORS[id % COMMUNITY_COLORS.length],
                nodeCount: memberIds.length
            });
        }

        return { clusters, nodeClusterMap };
    }
}
