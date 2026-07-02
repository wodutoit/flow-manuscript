import type {
  FlowDocument,
  FlowEdge,
  DiagramNodeVM,
  DiagramState,
  DiagramActVM,
  Act,
} from "../shared/types";

/**
 * Pure functions over the flow graph. No I/O here so this is trivially testable.
 *
 * Structure:
 *   - Acts are ordered by `Act.order` (1..N).
 *   - Within an act, only "order" (solid) edges among that act's scenes define
 *     sequence. The act's first scene is the one scene in the act with no
 *     incoming order edge from a fellow act member.
 *   - Overall story order = concatenation of acts in order, each act walked
 *     from its root along the scene chain.
 *
 * Validation:
 *   - Each act must have exactly one root scene. An act with 2+ roots has all
 *     its root scenes flagged invalid (rendered red).
 */

export function sceneNodes(doc: FlowDocument) {
  return doc.nodes.filter((n) => n.kind === "scene");
}

function orderEdges(doc: FlowDocument): FlowEdge[] {
  return doc.edges.filter((e) => e.kind === "order");
}

export function actsInOrder(doc: FlowDocument): Act[] {
  return [...(doc.acts ?? [])].sort((a, b) => a.order - b.order);
}

/** Map scene id -> act id (only for scenes that belong to an act). */
export function sceneActMap(doc: FlowDocument): Map<string, string> {
  const m = new Map<string, string>();
  for (const act of doc.acts ?? []) {
    for (const sid of act.sceneIds) m.set(sid, act.id);
  }
  return m;
}

/**
 * Roots within a single act: scenes in the act with no incoming order edge
 * whose source is also in the same act.
 */
export function actRoots(doc: FlowDocument, act: Act): string[] {
  const members = new Set(act.sceneIds);
  const hasIncoming = new Set<string>();
  for (const e of orderEdges(doc)) {
    if (members.has(e.target) && members.has(e.source)) {
      hasIncoming.add(e.target);
    }
  }
  return act.sceneIds.filter((id) => !hasIncoming.has(id));
}

/** Act ids that have more than one root scene (invalid). */
export function invalidActIds(doc: FlowDocument): string[] {
  return (doc.acts ?? [])
    .filter((act) => act.sceneIds.length > 0 && actRoots(doc, act).length > 1)
    .map((act) => act.id);
}

/**
 * Walk a single act's scene chain from its root, returning ordered scene ids.
 * Best-effort when the act has 0 or 2+ roots so the UI still shows something.
 */
export function orderedScenesInAct(doc: FlowDocument, act: Act): string[] {
  const members = new Set(act.sceneIds);
  const nextOf = new Map<string, string>();
  for (const e of orderEdges(doc)) {
    if (members.has(e.source) && members.has(e.target) && !nextOf.has(e.source)) {
      nextOf.set(e.source, e.target);
    }
  }
  const roots = actRoots(doc, act);
  const visited = new Set<string>();
  const result: string[] = [];

  const walk = (start: string) => {
    let cur: string | undefined = start;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      result.push(cur);
      cur = nextOf.get(cur);
    }
  };

  // Deterministic root ordering when several exist.
  for (const r of [...roots].sort((a, b) => (a < b ? -1 : 1))) walk(r);
  // Any members not reachable from a root (orphans/cycles) appended stably.
  for (const sid of act.sceneIds) if (!visited.has(sid)) walk(sid);
  return result;
}

/**
 * Global scene numbers (1-based) across the whole manuscript: acts in order,
 * each act's scenes in chain order. Also returns per-act numbering.
 */
export function deriveSceneNumbers(doc: FlowDocument): Map<string, number> {
  const numbers = new Map<string, number>();
  let counter = 1;
  for (const act of actsInOrder(doc)) {
    for (const sid of orderedScenesInAct(doc, act)) {
      numbers.set(sid, counter++);
    }
  }
  // Scenes not in any act (shouldn't happen, but be safe) get numbered last.
  const inAct = sceneActMap(doc);
  for (const s of sceneNodes(doc)) {
    if (!inAct.has(s.id) && !numbers.has(s.id)) numbers.set(s.id, counter++);
  }
  return numbers;
}

/** Per-act 1-based scene numbering. */
export function deriveActSceneNumbers(
  doc: FlowDocument
): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const act of actsInOrder(doc)) {
    let i = 1;
    for (const sid of orderedScenesInAct(doc, act)) numbers.set(sid, i++);
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
  const globalNums = deriveSceneNumbers(doc);
  const actNums = deriveActSceneNumbers(doc);
  const actOf = sceneActMap(doc);
  const badActs = new Set(invalidActIds(doc));

  // Precompute the root set per act for isRoot / isInvalidRoot flags.
  const rootsByAct = new Map<string, Set<string>>();
  for (const act of doc.acts ?? []) {
    rootsByAct.set(act.id, new Set(actRoots(doc, act)));
  }

  const nodes: DiagramNodeVM[] = doc.nodes.map((n) => {
    const fm = meta.frontmatterByFile.get(n.file) ?? {};
    const vm: DiagramNodeVM = {
      ...n,
      status: fm.status as DiagramNodeVM["status"],
      pov: fm.pov,
    };
    if (n.kind === "scene") {
      vm.sceneNumber = globalNums.get(n.id);
      vm.actSceneNumber = actNums.get(n.id);
      const aid = actOf.get(n.id);
      vm.actId = aid;
      const roots = aid ? rootsByAct.get(aid) : undefined;
      vm.isRoot = roots?.has(n.id) ?? false;
      vm.isInvalidRoot = !!aid && badActs.has(aid) && (roots?.has(n.id) ?? false);
    }
    return vm;
  });

  const acts: DiagramActVM[] = actsInOrder(doc).map((a) => ({
    id: a.id,
    name: a.name,
    order: a.order,
    sceneIds: a.sceneIds.slice(),
    collapsed: a.collapsed ?? false,
    position: a.position ?? { x: 0, y: 0 },
    size: a.size,
    sceneCount: a.sceneIds.length,
  }));

  return { nodes, edges: doc.edges, acts, invalidActIds: [...badActs] };
}
