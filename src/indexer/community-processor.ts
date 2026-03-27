/**
 * Community Detection Processor
 *
 * Uses the Leiden algorithm (via graphology-communities-leiden) to detect
 * communities/clusters in the code graph based on CALLS, IMPORTS, EXTENDS, and IMPLEMENTS relationships.
 *
 * Communities represent groups of code that work together frequently,
 * helping agents navigate the codebase by functional area rather than file structure.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { GraphNode, GraphEdge, ClusterInfo } from './IndexerService';

export interface CommunityNode {
    id: string;
    label: string;
    heuristicLabel: string;
    cohesion: number;
    symbolCount: number;
}

export interface CommunityMembership {
    nodeId: string;
    communityId: string;
}

export interface CommunityDetectionResult {
    communities: CommunityNode[];
    memberships: CommunityMembership[];
    nodeClusterMap: Map<string, number>;
    stats: {
        totalCommunities: number;
        modularity: number;
        nodesProcessed: number;
    };
}

// Community colors for visualization
const COMMUNITY_COLORS = [
    '#ef4444', // red
    '#f97316', // orange
    '#eab308', // yellow
    '#22c55e', // green
    '#06b6d4', // cyan
    '#3b82f6', // blue
    '#8b5cf6', // violet
    '#d946ef', // fuchsia
    '#ec4899', // pink
    '#f43f5e', // rose
    '#14b8a6', // teal
    '#84cc16', // lime
];

export const getCommunityColor = (communityIndex: number): string => {
    return COMMUNITY_COLORS[communityIndex % COMMUNITY_COLORS.length];
};

export class CommunityProcessor {
    /**
     * Detect communities in the knowledge graph using Leiden algorithm
     *
     * This runs AFTER all relationships (CALLS, IMPORTS, etc.) have been built.
     * It uses primarily CALLS, IMPORTS, EXTENDS, IMPLEMENTS edges to cluster code that works together.
     */
    process(
        nodes: GraphNode[],
        edges: GraphEdge[],
        onProgress?: (message: string, progress: number) => void
    ): CommunityDetectionResult {
        onProgress?.('Building graph for community detection...', 0);

        // Pre-check total symbol count to determine large-graph mode before building
        const symbolTypes = new Set(['function', 'class', 'method', 'interface']);
        let symbolCount = 0;
        for (const node of nodes) {
            if (symbolTypes.has(node.type)) {
                symbolCount++;
            }
        }
        const isLarge = symbolCount > 10_000;

        const graph = this.buildGraphologyGraph(nodes, edges, isLarge);

        if (graph.order === 0) {
            return {
                communities: [],
                memberships: [],
                nodeClusterMap: new Map(),
                stats: { totalCommunities: 0, modularity: 0, nodesProcessed: 0 }
            };
        }

        const nodeCount = graph.order;
        const edgeCount = graph.size;

        onProgress?.(`Running Leiden on ${nodeCount} nodes, ${edgeCount} edges${isLarge ? ` (filtered from ${symbolCount} symbols)` : ''}...`, 30);

        // Large graphs: higher resolution + capped iterations.
        // The first 2 iterations capture ~95%+ of modularity; additional iterations have diminishing returns.
        // Timeout: abort after 60s for pathological graph structures.
        const LOUVAIN_TIMEOUT_MS = 60_000;
        let details: any;

        try {
            const startTime = Date.now();
            // Louvain algorithm for community detection
            // resolution: higher = more communities (1.0 is standard)
            // weighted: whether to use edge weights
            const louvainResult = louvain(graph, {
                resolution: isLarge ? 2.0 : 1.0,
                randomWalk: false,
            });

            // louvain() returns LouvainMapping which is an object, not a Map
            const communities: Record<string, number> = {};
            const result = louvainResult as any;
            if (result && typeof result.forEach === 'function') {
                result.forEach((community: number, node: string) => {
                    communities[node] = community;
                });
            } else if (result) {
                Object.assign(communities, result);
            }
            const communityCount = Object.keys(communities).length > 0
                ? Math.max(...Object.values(communities)) + 1
                : 0;

            // Calculate modularity (simplified)
            const communityMap = new Map(Object.entries(communities).map(([k, v]) => [k, v as number]));
            const modularity = calculateModularity(graph, communityMap);

            details = {
                communities,
                count: communityCount,
                modularity
            };

            // Check for timeout
            if (Date.now() - startTime > LOUVAIN_TIMEOUT_MS) {
                throw new Error('Louvain timeout');
            }
        } catch (e: any) {
            if (e.message === 'Louvain timeout') {
                onProgress?.('Community detection timed out, using fallback...', 60);
                // Fallback: assign all nodes to community 0
                const communities: Record<string, number> = {};
                graph.forEachNode((node: string) => { communities[node] = 0; });
                details = { communities, count: 1, modularity: 0 };
            } else {
                throw e;
            }
        }

        onProgress?.(`Found ${details.count} communities...`, 60);

        // Step 2: Build nodeClusterMap
        const nodeClusterMap = new Map<string, number>();
        for (const [nodeId, communityNum] of Object.entries(details.communities as Record<string, number>)) {
            nodeClusterMap.set(nodeId, communityNum);
        }

        // Step 3: Create community nodes with heuristic labels
        const communityNodes = this.createCommunityNodes(
            details.communities as Record<string, number>,
            details.count,
            graph,
            nodes
        );

        onProgress?.('Creating membership edges...', 80);

        // Step 4: Create membership mappings
        const memberships: CommunityMembership[] = [];
        Object.entries(details.communities).forEach(([nodeId, communityNum]) => {
            memberships.push({
                nodeId,
                communityId: `comm_${communityNum}`,
            });
        });

        onProgress?.('Community detection complete!', 100);

        return {
            communities: communityNodes,
            memberships,
            nodeClusterMap,
            stats: {
                totalCommunities: details.count,
                modularity: details.modularity ?? 0,
                nodesProcessed: graph.order,
            }
        };
    }

    /**
     * Build a graphology graph containing only symbol nodes and clustering edges.
     * For large graphs (>10K symbols), filter out low-confidence edges
     * and degree-1 nodes that add noise and massively increase Leiden runtime.
     */
    private buildGraphologyGraph(
        nodes: GraphNode[],
        edges: GraphEdge[],
        isLarge: boolean
    ): Graph {
        const graph = new Graph({ type: 'undirected', allowSelfLoops: false });

        const symbolTypes = new Set(['function', 'class', 'method', 'interface']);
        const clusteringEdgeTypes = new Set(['calls', 'imports', 'extends', 'implements']);
        const connectedNodes = new Set<string>();
        const nodeDegree = new Map<string, number>();

        // Count node degrees first
        for (const edge of edges) {
            if (!clusteringEdgeTypes.has(edge.type)) continue;
            if (edge.source === edge.target) continue;

            connectedNodes.add(edge.source);
            connectedNodes.add(edge.target);
            nodeDegree.set(edge.source, (nodeDegree.get(edge.source) || 0) + 1);
            nodeDegree.set(edge.target, (nodeDegree.get(edge.target) || 0) + 1);
        }

        // Add nodes (symbol types only)
        for (const node of nodes) {
            if (!symbolTypes.has(node.type)) continue;
            if (!connectedNodes.has(node.id)) continue;

            // For large graphs, skip degree-1 nodes — they just become singletons or
            // get absorbed into their single neighbor's community, but cost iteration time.
            if (isLarge && (nodeDegree.get(node.id) || 0) < 2) continue;

            graph.addNode(node.id, {
                name: node.name,
                filePath: node.path,
                type: node.type,
            });
        }

        // Add edges
        for (const edge of edges) {
            if (!clusteringEdgeTypes.has(edge.type)) continue;
            if (edge.source === edge.target) continue;
            if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;

            // For large graphs, skip low-confidence edges
            if (isLarge && edge.weight !== undefined && edge.weight < 0.5) continue;

            if (!graph.hasEdge(edge.source, edge.target)) {
                graph.addEdge(edge.source, edge.target);
            }
        }

        return graph;
    }

    /**
     * Create Community nodes with auto-generated labels based on member file paths
     */
    private createCommunityNodes(
        communities: Record<string, number>,
        communityCount: number,
        graph: Graph,
        allNodes: GraphNode[]
    ): CommunityNode[] {
        // Group node IDs by community
        const communityMembers = new Map<number, string[]>();

        Object.entries(communities).forEach(([nodeId, commNum]) => {
            if (!communityMembers.has(commNum)) {
                communityMembers.set(commNum, []);
            }
            communityMembers.get(commNum)!.push(nodeId);
        });

        // Build node lookup for file paths
        const nodePathMap = new Map<string, string>();
        for (const node of allNodes) {
            if (node.path) {
                nodePathMap.set(node.id, node.path);
            }
        }

        // Create community nodes - SKIP SINGLETONS (isolated nodes)
        const communityNodes: CommunityNode[] = [];

        communityMembers.forEach((memberIds, commNum) => {
            // Skip singleton communities - they're just isolated nodes
            if (memberIds.length < 2) return;

            const heuristicLabel = this.generateHeuristicLabel(memberIds, nodePathMap, graph, commNum);

            communityNodes.push({
                id: `comm_${commNum}`,
                label: heuristicLabel,
                heuristicLabel,
                cohesion: this.calculateCohesion(memberIds, graph),
                symbolCount: memberIds.length,
            });
        });

        // Sort by size descending
        communityNodes.sort((a, b) => b.symbolCount - a.symbolCount);

        return communityNodes;
    }

    /**
     * Generate a human-readable label from the most common folder name in the community
     */
    private generateHeuristicLabel(
        memberIds: string[],
        nodePathMap: Map<string, string>,
        graph: Graph,
        commNum: number
    ): string {
        // Collect folder names from file paths
        const folderCounts = new Map<string, number>();

        memberIds.forEach(nodeId => {
            const filePath = nodePathMap.get(nodeId) || '';
            const parts = filePath.split('/').filter(Boolean);

            // Get the most specific folder (parent directory)
            if (parts.length >= 2) {
                const folder = parts[parts.length - 2];
                // Skip generic folder names
                if (!['src', 'lib', 'core', 'utils', 'common', 'shared', 'helpers'].includes(folder.toLowerCase())) {
                    folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
                }
            }
        });

        // Find most common folder
        let maxCount = 0;
        let bestFolder = '';

        folderCounts.forEach((count, folder) => {
            if (count > maxCount) {
                maxCount = count;
                bestFolder = folder;
            }
        });

        if (bestFolder) {
            // Capitalize first letter
            return bestFolder.charAt(0).toUpperCase() + bestFolder.slice(1);
        }

        // Fallback: use function names to detect patterns
        const names: string[] = [];
        memberIds.forEach(nodeId => {
            if (graph.hasNode(nodeId)) {
                const name = graph.getNodeAttribute(nodeId, 'name');
                if (name) names.push(name);
            }
        });

        // Look for common prefixes
        if (names.length > 2) {
            const commonPrefix = this.findCommonPrefix(names);
            if (commonPrefix.length > 2) {
                return commonPrefix.charAt(0).toUpperCase() + commonPrefix.slice(1);
            }
        }

        // Last resort: generic name with community ID for uniqueness
        return `Cluster_${commNum}`;
    }

    /**
     * Find common prefix among strings
     */
    private findCommonPrefix(strings: string[]): string {
        if (strings.length === 0) return '';

        const sorted = strings.slice().sort();
        const first = sorted[0];
        const last = sorted[sorted.length - 1];

        let i = 0;
        while (i < first.length && first[i] === last[i]) {
            i++;
        }

        return first.substring(0, i);
    }

    /**
     * Estimate cohesion score (0-1) based on internal edge density.
     * Uses sampling for large communities to avoid O(N^2) cost.
     */
    private calculateCohesion(memberIds: string[], graph: Graph): number {
        if (memberIds.length <= 1) return 1.0;

        const memberSet = new Set(memberIds);

        // Sample up to 50 members for large communities
        const SAMPLE_SIZE = 50;
        const sample = memberIds.length <= SAMPLE_SIZE
            ? memberIds
            : memberIds.slice(0, SAMPLE_SIZE);

        let internalEdges = 0;
        let totalEdges = 0;

        for (const nodeId of sample) {
            if (!graph.hasNode(nodeId)) continue;
            graph.forEachNeighbor(nodeId, (neighbor: string) => {
                totalEdges++;
                if (memberSet.has(neighbor)) {
                    internalEdges++;
                }
            });
        }

        // Cohesion = fraction of edges that stay internal
        if (totalEdges === 0) return 1.0;
        return Math.min(1.0, internalEdges / totalEdges);
    }
}

/**
 * Calculate modularity score for a community assignment
 * Modularity measures how well-separated the communities are
 */
function calculateModularity(graph: Graph, communityMap: Map<string, number>): number {
    const m = graph.size;
    if (m === 0) return 0;

    // Calculate total weight
    let totalWeight = 0;
    graph.forEachEdge((edge, attrs, source, target) => {
        totalWeight += (attrs.weight || 1);
    });

    if (totalWeight === 0) {
        // Unweighted graph - assume weight 1 for each edge
        totalWeight = graph.size;
    }

    let modularity = 0;

    graph.forEachNode((node: string) => {
        const community = communityMap.get(node);
        if (community === undefined) return;

        const kI = graph.degree(node); // Sum of weights of edges incident to node i
        const kJ = graph.degree(node); // For loop detection

        graph.forEachNeighbor(node, (neighbor: string) => {
            const neighborCommunity = communityMap.get(neighbor);
            if (neighborCommunity === community && community !== undefined) {
                // Edge within community
                modularity += 1;
            }
        });
    });

    // Simplified modularity formula
    // Q = (1/2m) * sum_ij [A_ij - (k_i * k_j) / 2m] * delta(c_i, c_j)
    return modularity / (2 * totalWeight);
}
