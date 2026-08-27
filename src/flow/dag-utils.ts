/**
 * Directed-graph utilities for flow validation (SPEC §9, WI-292).
 *
 * Shared with the transition-matrix loader (WI-302) — keep this module
 * free of flow-specific types so it stays a pure graph library.
 */

/**
 * Identify all nodes that participate in at least one cycle in the given
 * directed dependency graph, using Kahn's topological-sort algorithm.
 *
 * Convention: `edges.get(node)` returns the set of nodes that `node` depends
 * on (i.e., must complete before `node` can start).  Equivalently, each entry
 * represents a directed edge `dependency → node` in the execution order.
 *
 * @param nodeIds - Complete list of node IDs in the graph.
 * @param edges   - Map from each node to its direct dependencies.
 *                  Nodes absent from the map are treated as having no
 *                  dependencies (in-degree 0).
 * @returns       The set of node IDs that are part of a cycle.
 *                Empty set means the graph is acyclic.
 */
export function findCycleNodes(
  nodeIds: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  // ── Build in-degree count and reverse-adjacency (outEdges) ──────────────
  // in-degree[node] = number of its dependencies that are known nodes.
  // outEdges[dep]   = nodes that depend on dep (so we can decrement when
  //                   dep is resolved).

  const inDegree = new Map<string, number>();
  const outEdges = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
  }

  for (const [node, deps] of edges) {
    let count = 0;
    for (const dep of deps) {
      // Only count dependencies that are known nodes — unknown references
      // are a separate validation concern, not a cycle.
      if (inDegree.has(dep)) {
        count++;
        const bucket = outEdges.get(dep);
        if (bucket) {
          bucket.push(node);
        } else {
          outEdges.set(dep, [node]);
        }
      }
    }
    inDegree.set(node, (inDegree.get(node) ?? 0) + count);
  }

  // ── Kahn's algorithm ─────────────────────────────────────────────────────
  // Enqueue all nodes with no dependencies; repeatedly drain the queue by
  // resolving a node and decrementing the in-degree of its dependants.
  // Nodes that never reach in-degree 0 are part of cycles.

  const queue: string[] = [];
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node);
  }

  const resolved = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    resolved.add(node);
    for (const dependant of (outEdges.get(node) ?? [])) {
      const newDeg = (inDegree.get(dependant) ?? 0) - 1;
      inDegree.set(dependant, newDeg);
      if (newDeg === 0) queue.push(dependant);
    }
  }

  // ── Collect cycle participants ────────────────────────────────────────────
  const cycleNodes = new Set<string>();
  for (const id of nodeIds) {
    if (!resolved.has(id)) {
      cycleNodes.add(id);
    }
  }
  return cycleNodes;
}
