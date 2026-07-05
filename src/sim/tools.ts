/**
 * The Rig Toolbox (thin slice): player-placed tools that reshape the fuse
 * network BEFORE ignition. Tools are plain deterministic inputs — the replay
 * payload becomes (seed, shellPlacements[], tools[]) and the determinism LAW
 * (GDD §3.4) is untouched: applyTools() is a pure board transform.
 *
 * Validation lives here, not in the UI, so the future server-side replay
 * verifier enforces the exact same rules as the client.
 */
import { TUNING } from './tuning';
import type { Board } from './types';

export type ToolPlacement =
  | { type: 'jumper'; a: number; b: number }
  | { type: 'keg'; nodeId: number };

export interface ToolValidation {
  ok: boolean;
  cost: number;
  errors: string[];
}

export function toolCost(tool: ToolPlacement): number {
  return tool.type === 'jumper' ? TUNING.tools.jumperCost : TUNING.tools.kegCost;
}

export function toolsCost(tools: ToolPlacement[]): number {
  return tools.reduce((sum, t) => sum + toolCost(t), 0);
}

export function boardDistance(board: Board, a: number, b: number): number {
  const na = board.nodes.find((n) => n.id === a);
  const nb = board.nodes.find((n) => n.id === b);
  if (!na || !nb) return Infinity;
  return Math.hypot(na.x - nb.x, na.y - nb.y);
}

export function validateTools(board: Board, tools: ToolPlacement[]): ToolValidation {
  const errors: string[] = [];
  const cost = toolsCost(tools);
  if (cost > TUNING.tools.budget) {
    errors.push(`rig budget exceeded: ${cost} > ${TUNING.tools.budget}`);
  }

  const nodeById = new Map(board.nodes.map((n) => [n.id, n]));
  const edgeKeys = new Set(board.edges.map((e) => `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`));
  const seenJumpers = new Set<string>();
  const seenKegs = new Set<number>();

  for (const tool of tools) {
    if (tool.type === 'jumper') {
      const key = `${Math.min(tool.a, tool.b)}-${Math.max(tool.a, tool.b)}`;
      if (tool.a === tool.b) errors.push(`jumper ${key}: endpoints must differ`);
      else if (!nodeById.has(tool.a) || !nodeById.has(tool.b)) errors.push(`jumper ${key}: unknown node`);
      else if (edgeKeys.has(key)) errors.push(`jumper ${key}: fuse already exists there`);
      else if (seenJumpers.has(key)) errors.push(`jumper ${key}: duplicate`);
      else if (boardDistance(board, tool.a, tool.b) > TUNING.tools.jumperMaxDistance)
        errors.push(`jumper ${key}: too far apart`);
      seenJumpers.add(key);
    } else {
      const node = nodeById.get(tool.nodeId);
      if (!node) errors.push(`keg @${tool.nodeId}: unknown node`);
      else if (node.kind !== 'junction') errors.push(`keg @${tool.nodeId}: must sit on a plain junction`);
      else if (seenKegs.has(tool.nodeId)) errors.push(`keg @${tool.nodeId}: duplicate`);
      seenKegs.add(tool.nodeId);
    }
  }

  return { ok: errors.length === 0, cost, errors };
}

/** Pure transform: base board + tools → the board the fire actually burns. */
export function applyTools(board: Board, tools: ToolPlacement[]): Board {
  const nodes = board.nodes.map((n) => ({ ...n }));
  const edges = board.edges.map((e) => ({ ...e }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  let nextEdgeId = edges.reduce((m, e) => Math.max(m, e.id), -1) + 1;

  // Deterministic application order regardless of UI click order.
  const sorted = [...tools].sort((x, y) => {
    const kx = x.type === 'jumper' ? `j-${Math.min(x.a, x.b)}-${Math.max(x.a, x.b)}` : `k-${x.nodeId}`;
    const ky = y.type === 'jumper' ? `j-${Math.min(y.a, y.b)}-${Math.max(y.a, y.b)}` : `k-${y.nodeId}`;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });

  for (const tool of sorted) {
    if (tool.type === 'jumper') {
      edges.push({
        id: nextEdgeId++,
        a: Math.min(tool.a, tool.b),
        b: Math.max(tool.a, tool.b),
        burnTicks: TUNING.tools.jumperBurnTicks,
      });
    } else {
      const node = nodeById.get(tool.nodeId);
      if (node) node.kind = 'booster';
    }
  }

  return { ...board, nodes, edges };
}
