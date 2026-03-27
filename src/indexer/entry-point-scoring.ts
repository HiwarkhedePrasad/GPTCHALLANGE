/**
 * Phase 5: Entry Point Scoring
 * Identifies entry points and traces execution flows
 */

import { GraphNode, GraphEdge } from './IndexerService';

export interface EntryPointScore {
    nodeId: string;
    score: number;
    reasons: string[];
}

export interface ExecutionFlow {
    entryPoint: string;
    path: string[];
    depth: number;
}

const ENTRY_POINT_KEYWORDS = [
    'main', 'start', 'init', 'handle', 'process', 'execute', 'run',
    'create', 'setup', 'bootstrap', 'build', 'parse', 'validate'
];

const TEST_PATTERNS = ['.test.', '.spec.', '__tests__', 'test_', '_test.'];

export class EntryPointScoring {
    score(nodes: GraphNode[], edges: GraphEdge[]): EntryPointScore[] {
        // Build call graph
        const { incomingCalls, outgoingCalls } = this.buildCallGraph(nodes, edges);

        // Only consider executable nodes
        const executableTypes = new Set(['function', 'method', 'class']);
        const scores: EntryPointScore[] = [];

        for (const node of nodes) {
            if (!executableTypes.has(node.type)) continue;

            const score = this.calculateScore(
                node,
                incomingCalls.get(node.id)?.size || 0,
                outgoingCalls.get(node.id)?.size || 0,
                incomingCalls
            );

            if (score.total > 0) {
                scores.push({
                    nodeId: node.id,
                    score: score.total,
                    reasons: score.reasons
                });
            }
        }

        // Sort by score descending
        return scores.sort((a, b) => b.score - a.score);
    }

    private buildCallGraph(
        nodes: GraphNode[],
        edges: GraphEdge[]
    ): { incomingCalls: Map<string, Set<string>>; outgoingCalls: Map<string, Set<string>> } {
        const incomingCalls = new Map<string, Set<string>>();
        const outgoingCalls = new Map<string, Set<string>>();

        const executableTypes = new Set(['function', 'method', 'class']);
        const executableNodes = new Set(
            nodes.filter(n => executableTypes.has(n.type)).map(n => n.id)
        );

        for (const edge of edges) {
            if (edge.type !== 'calls') continue;
            if (!executableNodes.has(edge.source) || !executableNodes.has(edge.target)) {
                continue;
            }

            if (!incomingCalls.has(edge.target)) {
                incomingCalls.set(edge.target, new Set());
            }
            incomingCalls.get(edge.target)!.add(edge.source);

            if (!outgoingCalls.has(edge.source)) {
                outgoingCalls.set(edge.source, new Set());
            }
            outgoingCalls.get(edge.source)!.add(edge.target);
        }

        return { incomingCalls, outgoingCalls };
    }

    private calculateScore(
        node: GraphNode,
        callerCount: number,
        calleeCount: number,
        incomingCalls: Map<string, Set<string>>
    ): { total: number; reasons: string[] } {
        let total = 0;
        const reasons: string[] = [];

        // Criterion 1: No callers but has callees (likely entry point)
        if (callerCount === 0 && calleeCount > 0) {
            total += 10;
            reasons.push('No internal callers, calls others');
        } else if (callerCount <= 2 && calleeCount >= 3) {
            total += 5;
            reasons.push('Few callers but multiple callees');
        }

        // Criterion 2: Name suggests entry point
        const name = node.name.toLowerCase();
        for (const keyword of ENTRY_POINT_KEYWORDS) {
            if (name.includes(keyword)) {
                total += 8;
                reasons.push(`Name contains "${keyword}"`);
                break;
            }
        }

        // Criterion 3: Exported/Public (if we can detect)
        // For now, skip this as it requires more context

        // Criterion 4: Test files are usually entry points
        if (node.path && this.isTestFile(node.path)) {
            total += 6;
            reasons.push('Located in test file');
        }

        // Criterion 5: Connection count heuristic
        if (node.connections !== undefined) {
            if (node.connections === 0 && calleeCount > 0) {
                total += 4;
                reasons.push('No external connections but has calls');
            } else if (node.connections < 3 && calleeCount > 2) {
                total += 3;
                reasons.push('Few connections but calls multiple functions');
            }
        }

        return { total, reasons };
    }

    private isTestFile(path: string): boolean {
        return TEST_PATTERNS.some(pattern => path.includes(pattern));
    }

    /**
     * Get top N entry points
     */
    getTopEntryPoints(scores: EntryPointScore[], count: number = 20): EntryPointScore[] {
        return scores.slice(0, count);
    }

    /**
     * Check if a node is likely an entry point
     */
    isLikelyEntryPoint(node: GraphNode): boolean {
        const name = node.name.toLowerCase();

        // Check name patterns
        for (const keyword of ENTRY_POINT_KEYWORDS) {
            if (name.includes(keyword)) return true;
        }

        // Check test file
        if (node.path && this.isTestFile(node.path)) return true;

        return false;
    }
}
