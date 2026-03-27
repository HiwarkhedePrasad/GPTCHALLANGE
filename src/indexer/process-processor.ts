/**
 * Phase 5: Process Processor
 * Traces execution flows through the codebase
 */

import { GraphNode, GraphEdge } from './IndexerService';
import { EntryPointScoring, EntryPointScore } from './entry-point-scoring';

export interface ExecutionTrace {
    entryPoint: string;
    nodes: string[];
    edges: GraphEdge[];
    depth: number;
}

export interface ProcessInfo {
    entryPoints: EntryPointScore[];
    traces: ExecutionTrace[];
    exitPoints: string[];
}

export class ProcessProcessor {
    private entryPointScorer = new EntryPointScoring();
    private maxDepth = 5;
    private maxBranching = 3;

    process(nodes: GraphNode[], edges: GraphEdge[]): ProcessInfo {
        // Score and rank entry points
        const entryPointScores = this.entryPointScorer.score(nodes, edges);
        const topEntryPoints = this.entryPointScorer.getTopEntryPoints(entryPointScores, 20);

        // Trace execution flows from top entry points
        const traces = this.traceExecutionFlows(topEntryPoints, nodes, edges);

        // Find exit points (functions that are leaves in call graph)
        const exitPoints = this.findExitPoints(nodes, edges);

        return {
            entryPoints: topEntryPoints,
            traces,
            exitPoints
        };
    }

    private traceExecutionFlows(
        entryPoints: EntryPointScore[],
        nodes: GraphNode[],
        edges: GraphEdge[]
    ): ExecutionTrace[] {
        const traces: ExecutionTrace[] = [];

        // Build call graph
        const outgoingCalls = this.buildOutgoingCalls(edges);

        for (const entry of entryPoints) {
            const trace = this.traceFromEntryPoint(entry.nodeId, outgoingCalls);
            if (trace.nodes.length > 0) {
                traces.push({
                    entryPoint: entry.nodeId,
                    nodes: trace.nodes,
                    edges: trace.edges,
                    depth: trace.depth
                });
            }
        }

        return traces;
    }

    private buildOutgoingCalls(edges: GraphEdge[]): Map<string, Set<string>> {
        const outgoing = new Map<string, Set<string>>();

        for (const edge of edges) {
            if (edge.type !== 'calls') continue;

            if (!outgoing.has(edge.source)) {
                outgoing.set(edge.source, new Set());
            }
            outgoing.get(edge.source)!.add(edge.target);
        }

        return outgoing;
    }

    private traceFromEntryPoint(
        entryPointId: string,
        outgoingCalls: Map<string, Set<string>>
    ): { nodes: string[]; edges: GraphEdge[]; depth: number } {
        const visited = new Set<string>();
        const nodes: string[] = [];
        const traceEdges: GraphEdge[] = [];
        const queue: Array<{ id: string; depth: number; parentId: string | null }> = [
            { id: entryPointId, depth: 0, parentId: null }
        ];
        let maxDepth = 0;

        while (queue.length > 0) {
            const { id, depth, parentId } = queue.shift()!;

            if (visited.has(id) || depth >= this.maxDepth) continue;
            visited.add(id);
            maxDepth = Math.max(maxDepth, depth);

            if (parentId !== null) {
                nodes.push(id);
                traceEdges.push({
                    source: parentId,
                    target: id,
                    type: 'calls',
                    weight: 1
                });
            }

            const callees = outgoingCalls.get(id);
            if (!callees) continue;

            // Take top N callees to limit branching
            const sortedCallees = Array.from(callees).slice(0, this.maxBranching);

            for (const callee of sortedCallees) {
                if (!visited.has(callee)) {
                    queue.push({ id: callee, depth: depth + 1, parentId: id });
                }
            }
        }

        return { nodes, edges: traceEdges, depth: maxDepth };
    }

    private findExitPoints(nodes: GraphNode[], edges: GraphEdge[]): string[] {
        const exitPoints: string[] = [];
        const executableTypes = new Set(['function', 'method', 'class']);
        const executableNodes = new Set(
            nodes.filter(n => executableTypes.has(n.type)).map(n => n.id)
        );

        // Build incoming call map
        const incomingCalls = new Map<string, Set<string>>();
        for (const edge of edges) {
            if (edge.type !== 'calls') continue;
            if (!incomingCalls.has(edge.target)) {
                incomingCalls.set(edge.target, new Set());
            }
            incomingCalls.get(edge.target)!.add(edge.source);
        }

        // Exit points are nodes that are never called (except entry points)
        for (const nodeId of executableNodes) {
            const callers = incomingCalls.get(nodeId);
            // If no callers, it might be an exit point or entry point
            // Exit points typically have no callers AND make no calls (leaf nodes)
            if (!callers || callers.size === 0) {
                exitPoints.push(nodeId);
            }
        }

        return exitPoints.slice(0, 20);
    }

    /**
     * Get call chain between two nodes
     */
    getCallChain(
        fromId: string,
        toId: string,
        edges: GraphEdge[],
        maxDepth: number = 5
    ): string[] | null {
        const outgoing = this.buildOutgoingCalls(edges);

        // BFS to find path
        const visited = new Set<string>();
        const queue: Array<{ id: string; path: string[] }> = [
            { id: fromId, path: [fromId] }
        ];

        while (queue.length > 0) {
            const { id, path } = queue.shift()!;

            if (id === toId) return path;
            if (path.length >= maxDepth) continue;
            if (visited.has(id)) continue;
            visited.add(id);

            const callees = outgoing.get(id);
            if (!callees) continue;

            for (const callee of callees) {
                if (!visited.has(callee)) {
                    queue.push({ id: callee, path: [...path, callee] });
                }
            }
        }

        return null; // No path found
    }

    /**
     * Find nodes affected by changes to a given node
     */
    findAffectedNodes(
        nodeId: string,
        nodes: GraphNode[],
        edges: GraphEdge[],
        maxDepth: number = 3
    ): GraphNode[] {
        const outgoing = this.buildOutgoingCalls(edges);

        const visited = new Set<string>();
        const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];
        const affected: string[] = [];

        while (queue.length > 0) {
            const { id, depth } = queue.shift()!;

            if (visited.has(id) || depth >= maxDepth) continue;
            visited.add(id);

            const callees = outgoing.get(id);
            if (!callees) continue;

            for (const callee of callees) {
                if (!visited.has(callee)) {
                    affected.push(callee);
                    queue.push({ id: callee, depth: depth + 1 });
                }
            }
        }

        return nodes.filter(n => affected.includes(n.id));
    }
}
