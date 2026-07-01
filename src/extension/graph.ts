import type { FlowDocument, FlowEdge, DiagramNodeVM, DiagramState } from "../shared/types";

/**
 * Pure functions over the flow graph. No I/O here so this is trivially testable.
 *
 * Story order rule:
 *   - Only "order" (solid) edges define sequence, and only between scenes.
 *   - Scene 1 is the single scene node with no incoming order edge.
 *   - Following order edges forward assigns 1..N.
 *
 * Validation rule:
 *   - If more than one scene has no incoming order edge, every such root is
 *     flagged invalid (rendered red), because there must be exactly one start.
 */

export function sceneNodes(doc: FlowDocument) {
  return doc.nodes.filter((n) => n.kind === "scene");
}

function orderEdges(doc: FlowDocument): FlowEdge[] {
  return doc.edges.filter((e) => e.kind === "order");
}

/** Return the set of scene node ids that have no incoming order edge. */
export function findRoots(doc: FlowDocument): string[] {
  const scenes = new Set(sceneNodes(doc).map((n) => n.id));
  const hasIncoming = new Set<string>();
  for (const e of orderEdges(doc)) {
    if (scenes.has(e.target)) hasIncoming.add(e.target);
  }
  return [...scenes].filter((id) => !hasIncoming.has(id));
}

/**
 * Walk the order-edge chain from the (single) root to assign 1-based numbers.
 * If there are 0 or 2+ roots, we still number best-effort by doing a stable
 * topological-ish walk so the UI has *something*, but the graph is flagged invalid.
 */
export function deriveSceneNumbers(doc: FlowDocument): Map<string, number> {
  const numbers = new Map<string, number>();
  const roots = findRoots(doc);
  const nextOf = new Map<string, string>(); // source -> target (first order edge)
  for (const e of orderEdges(doc)) {
    if (!nextOf.has(e.source)) nextOf.set(e.source, e.target);
  }

  const visited = new Set<string>();
  let counter = 1;

  const walk = (startId: string) => {
    let cur: string | undefined = startId;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      numbers.set(cur, counter++);
      cur = nextOf.get(cur);
    }
  };

  // Prefer a deterministic root ordering when multiple exist.
  const scenes = sceneNodes(doc);
  const orderedRoots = roots
    .slice()
    .sort((a, b) => (a < b ? -1 : 1));
  for (const r of orderedRoots) walk(r);

  // Catch any scenes not reachable from a root (orphans / cycles).
  for (const s of scenes) {
    if (!visited.has(s.id)) walk(s.id);
  }

  return numbers;
}

/** Build the enriched view-model the diagram webview consumes. */
export function buildDiagramState(
  doc: FlowDocument,
  meta: {
    frontmatterByFile: Map<string, { status?: string; pov?: string }>;
  }
): DiagramState {
  const roots = findRoots(doc);
  const rootCount = roots.length;
  const invalidRoots = rootCount > 1 ? new Set(roots) : new Set<string>();
  const numbers = deriveSceneNumbers(doc);

  const nodes: DiagramNodeVM[] = doc.nodes.map((n) => {
    const fm = meta.frontmatterByFile.get(n.file) ?? {};
    const vm: DiagramNodeVM = {
      ...n,
      status: fm.status as DiagramNodeVM["status"],
      pov: fm.pov,
    };
    if (n.kind === "scene") {
      vm.sceneNumber = numbers.get(n.id);
      vm.isRoot = roots.includes(n.id);
      vm.isInvalidRoot = invalidRoots.has(n.id);
    }
    return vm;
  });

  return { nodes, edges: doc.edges, rootCount };
}
