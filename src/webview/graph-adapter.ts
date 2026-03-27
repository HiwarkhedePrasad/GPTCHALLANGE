/**
 * Graph Adapter - Converts KnowledgeGraph to Graphology format
 * Based on GitNexus implementation with golden angle positioning
 */

import Graph from 'graphology';
import { KnowledgeGraph, GraphNode, GraphEdge } from '../indexer/IndexerService';

export interface GraphologyNode {
    key: string;
    attributes: {
        label: string;
        x: number;
        y: number;
        size: number;
        color: string;
        type: string;
        mass?: number;
        path?: string;
        startLine?: number;
        endLine?: number;
        cluster?: string;
    };
}

export interface GraphologyEdge {
    source: string;
    target: string;
    attributes: {
        type: string;
        color: string;
        size: number;
        curvature?: number;
    };
}

// Node type configurations (mass affects ForceAtlas2 layout)
// Using warm colors - NO blue or violet
const NODE_CONFIG: Record<string, { mass: number; baseSize: number; color: string }> = {
    project: { mass: 50, baseSize: 20, color: '#f59e0b' },     // Amber
    folder: { mass: 15, baseSize: 12, color: '#10b981' },       // Emerald
    file: { mass: 3, baseSize: 6, color: '#22d3ee' },           // Cyan
    class: { mass: 2, baseSize: 5, color: '#f97316' },          // Orange
    function: { mass: 2, baseSize: 4, color: '#ef4444' },       // Red
    method: { mass: 2, baseSize: 4, color: '#ec4899' },         // Pink
    interface: { mass: 2, baseSize: 5, color: '#14b8a6' },      // Teal
    module: { mass: 10, baseSize: 10, color: '#f59e0b' },       // Amber
    package: { mass: 12, baseSize: 11, color: '#eab308' },      // Yellow
    community: { mass: 8, baseSize: 8, color: '#d946ef' },      // Fuchsia
    default: { mass: 2, baseSize: 4, color: '#6b7280' }         // Gray
};

// Edge type colors - NO blue or violet
const EDGE_COLORS: Record<string, string> = {
    contains: '#2d5a3d',      // Forest green
    imports: '#14b8a6',       // Teal
    calls: '#f97316',         // Orange
    extends: '#c2410c',       // Dark orange
    implements: '#be185d',    // Pink
    defines: '#059669',       // Emerald
    member_of: '#f59e0b',     // Amber
    step_in_process: '#10b981', // Green
    default: '#4b5563'        // Gray
};

/**
 * Converts KnowledgeGraph to Graphology graph with GitNexus-style layout
 */
export function knowledgeGraphToGraphology(knowledgeGraph: KnowledgeGraph): Graph {
    const graph = new Graph({ multi: true, type: 'directed' });
    
    // Calculate positions and sizes based on graph size
    const nodeCount = knowledgeGraph.nodes.length;
    const scaleFactor = calculateScaleFactor(nodeCount);
    
    // Separate structural nodes (folders, files) from symbol nodes (functions, classes)
    const structuralNodes: GraphNode[] = [];
    const symbolNodes: GraphNode[] = [];
    
    for (const node of knowledgeGraph.nodes) {
        const nodeType = node.type.toLowerCase();
        if (nodeType === 'folder' || nodeType === 'file' || nodeType === 'module' || nodeType === 'package' || nodeType === 'project') {
            structuralNodes.push(node);
        } else {
            symbolNodes.push(node);
        }
    }
    
    // Position structural nodes using golden angle spiral
    const structuralSpread = 1000 * Math.sqrt(nodeCount / 100);
    positionStructuralNodes(graph, structuralNodes, structuralSpread, scaleFactor);
    
    // Position symbol nodes near their parent or community center
    positionSymbolNodes(graph, symbolNodes, knowledgeGraph.edges, scaleFactor);
    
    // Add edges with curved lines and colors
    addEdges(graph, knowledgeGraph.edges);
    
    return graph;
}

/**
 * Calculate size scale factor based on total node count
 */
function calculateScaleFactor(nodeCount: number): number {
    if (nodeCount < 100) return 1.0;
    if (nodeCount < 500) return 0.8;
    if (nodeCount < 2000) return 0.6;
    if (nodeCount < 10000) return 0.4;
    return 0.3;
}

/**
 * Position structural nodes (folders, files) using golden angle spiral
 * This spreads clusters visually across the canvas
 */
function positionStructuralNodes(
    graph: Graph,
    nodes: GraphNode[],
    spread: number,
    scaleFactor: number
): void {
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const nodeCount = nodes.length;
    
    nodes.forEach((node, index) => {
        const nodeType = node.type.toLowerCase();
        const config = NODE_CONFIG[nodeType] || NODE_CONFIG.default;
        
        // Golden angle spiral positioning
        const angle = index * goldenAngle;
        const radius = spread * Math.sqrt((index + 1) / nodeCount);
        const x = radius * Math.cos(angle);
        const y = radius * Math.sin(angle);
        
        graph.addNode(node.id, {
            label: node.name,
            x,
            y,
            size: config.baseSize * scaleFactor,
            color: config.color,
            type: nodeType,
            mass: config.mass,
            path: node.path,
            startLine: node.startLine,
            endLine: node.endLine,
            cluster: node.cluster
        });
    });
}

/**
 * Position symbol nodes (functions, classes) near their parent or community center
 */
function positionSymbolNodes(
    graph: Graph,
    nodes: GraphNode[],
    edges: GraphEdge[],
    scaleFactor: number
): void {
    // Build parent map from edges
    const parentMap = new Map<string, string>();
    for (const edge of edges) {
        if (edge.type === 'contains' || edge.type === 'defines') {
            parentMap.set(edge.target, edge.source);
        }
    }
    
    // Build community centers if clustering is available
    const communityCenters = calculateCommunityCenters(graph, nodes);
    
    nodes.forEach(node => {
        const nodeType = node.type.toLowerCase();
        const config = NODE_CONFIG[nodeType] || NODE_CONFIG.default;
        
        let x = 0, y = 0;
        
        // Try to position near community center first
        if (node.cluster && communityCenters.has(node.cluster)) {
            const center = communityCenters.get(node.cluster)!;
            x = center.x + (Math.random() - 0.5) * 100;
            y = center.y + (Math.random() - 0.5) * 100;
        }
        // Otherwise position near parent node
        else if (parentMap.has(node.id)) {
            const parentId = parentMap.get(node.id)!;
            if (graph.hasNode(parentId)) {
                const parentAttrs = graph.getNodeAttributes(parentId);
                x = parentAttrs.x + (Math.random() - 0.5) * 50;
                y = parentAttrs.y + (Math.random() - 0.5) * 50;
            }
        }
        // Fallback: random position
        else {
            x = (Math.random() - 0.5) * 500;
            y = (Math.random() - 0.5) * 500;
        }
        
        graph.addNode(node.id, {
            label: node.name,
            x,
            y,
            size: config.baseSize * scaleFactor,
            color: config.color,
            type: nodeType,
            mass: config.mass,
            path: node.path,
            startLine: node.startLine,
            endLine: node.endLine,
            cluster: node.cluster
        });
    });
}

/**
 * Calculate visual center points for each community/cluster
 */
function calculateCommunityCenters(
    graph: Graph,
    symbolNodes: GraphNode[]
): Map<string, { x: number; y: number }> {
    const centers = new Map<string, { x: number; y: number; count: number }>();
    
    // Find all structural nodes and group by cluster
    graph.forEachNode((node, attrs) => {
        if (attrs.cluster && (attrs.type === 'folder' || attrs.type === 'file')) {
            if (!centers.has(attrs.cluster)) {
                centers.set(attrs.cluster, { x: 0, y: 0, count: 0 });
            }
            const center = centers.get(attrs.cluster)!;
            center.x += attrs.x;
            center.y += attrs.y;
            center.count++;
        }
    });
    
    // Calculate averages
    const result = new Map<string, { x: number; y: number }>();
    centers.forEach((value, key) => {
        result.set(key, {
            x: value.x / value.count,
            y: value.y / value.count
        });
    });
    
    return result;
}

/**
 * Add edges with GitNexus-style curved lines and colors
 */
function addEdges(graph: Graph, edges: GraphEdge[]): void {
    edges.forEach(edge => {
        // Skip if nodes don't exist
        if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
            return;
        }
        
        const edgeType = edge.type.toLowerCase();
        const color = EDGE_COLORS[edgeType] || EDGE_COLORS.default;
        
        // Random curvature between 0.12 and 0.20 (prevents overlapping parallel edges)
        const curvature = 0.12 + Math.random() * 0.08;
        
        graph.addDirectedEdge(edge.source, edge.target, {
            type: edgeType,
            color,
            size: 1,
            curvature
        });
    });
}

/**
 * Get ForceAtlas2 settings based on graph size (GitNexus approach)
 */
export function getFA2Settings(nodeCount: number): any {
    if (nodeCount < 500) {
        // Small graph
        return {
            barnesHutOptimize: nodeCount > 200,
            barnesHutTheta: 0.5,
            scalingRatio: 15,
            gravity: 0.8,
            slowDown: 3,
            linLogMode: false,
            strongGravityMode: false,
            edgeWeightInfluence: 1
        };
    } else if (nodeCount < 2000) {
        // Medium graph
        return {
            barnesHutOptimize: true,
            barnesHutTheta: 0.5,
            scalingRatio: 40,
            gravity: 0.5,
            slowDown: 5,
            linLogMode: false,
            strongGravityMode: false,
            edgeWeightInfluence: 1
        };
    } else if (nodeCount < 10000) {
        // Large graph
        return {
            barnesHutOptimize: true,
            barnesHutTheta: 0.5,
            scalingRatio: 100,
            gravity: 0.3,
            slowDown: 8,
            linLogMode: false,
            strongGravityMode: false,
            edgeWeightInfluence: 0.5
        };
    } else {
        // Huge graph
        return {
            barnesHutOptimize: true,
            barnesHutTheta: 0.8,
            scalingRatio: 200,
            gravity: 0.1,
            slowDown: 10,
            linLogMode: true,
            strongGravityMode: false,
            edgeWeightInfluence: 0.1
        };
    }
}

/**
 * Calculate layout duration based on graph size (in milliseconds)
 */
export function getLayoutDuration(nodeCount: number): number {
    if (nodeCount < 500) return 20000;       // 20 seconds
    if (nodeCount < 2000) return 30000;      // 30 seconds
    if (nodeCount < 10000) return 40000;     // 40 seconds
    return 45000;                            // 45 seconds
}
