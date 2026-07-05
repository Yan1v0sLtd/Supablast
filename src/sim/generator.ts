/**
 * Seeded board generator (GDD §3.5).
 * Pipeline: spatial graph → spark-gap pockets (structural fake finales) →
 * socket stratification by distance-from-ignition → special node assignment.
 * Fully deterministic per seed. EV auditing lives in audit.ts (v0: log only).
 */
import { rngFromString, randInt, shuffle } from './prng';
import { TUNING } from './tuning';
import type { Board, BoardEdge, BoardNode, NodeKind, SocketRing } from './types';

interface GenNode {
  id: number;
  x: number;
  y: number;
  kind: NodeKind;
  sparkTargetId?: number;
  decoyValue?: number;
  ring?: SocketRing;
  pocket: number; // -1 = main graph, >=0 = pocket index
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export function generateBoard(seed: string): Board {
  const rng = rngFromString(seed + ':board');
  const B = TUNING.board;

  // 1. Scatter nodes on a jittered grid (portrait: ignition at the bottom).
  const targetCount = randInt(rng, B.nodeCountMin, B.nodeCountMax);
  const allCells: Array<{ cx: number; cy: number }> = [];
  for (let cy = 0; cy < B.rows; cy++)
    for (let cx = 0; cx < B.cols; cx++) allCells.push({ cx, cy });
  const ignitionCell = { cx: Math.floor(B.cols / 2), cy: B.rows - 1 };
  const otherCells = allCells.filter((c) => !(c.cx === ignitionCell.cx && c.cy === ignitionCell.cy));
  const chosenCells = [ignitionCell, ...shuffle(rng, otherCells).slice(0, targetCount - 1)];

  const nodes: GenNode[] = chosenCells.map((cell, i) => ({
    id: i,
    x: cell.cx + (rng() * 2 - 1) * B.jitter,
    y: cell.cy + (rng() * 2 - 1) * B.jitter,
    kind: i === 0 ? 'ignition' : 'junction',
    pocket: -1,
  }));
  const ignitionId = 0;

  // 2. Edges: connect near neighbors, then stitch components together.
  let edgePairs: Array<[number, number]> = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (dist(nodes[i], nodes[j]) <= B.neighborRadius && rng() < B.edgeKeepChance) {
        edgePairs.push([i, j]);
      }
    }
  }
  edgePairs = connectComponents(nodes, edgePairs);

  // 3. Carve 1-2 pockets in the top region, reachable only via spark gaps
  //    (GDD §3.5 step 2: structural fake finales).
  const pocketCount = randInt(rng, B.pocketCountMin, B.pocketCountMax);
  let pocketsMade = 0;
  const pocketCenters = shuffle(
    rng,
    nodes.filter((n) => n.id !== ignitionId && n.y <= B.pocketRegionMaxRow && n.pocket === -1),
  );
  for (const center of pocketCenters) {
    if (pocketsMade >= pocketCount) break;
    if (center.pocket !== -1) continue;
    const members = nodes
      .filter((n) => n.pocket === -1 && n.id !== ignitionId && dist(n, center) <= B.neighborRadius)
      .sort((a, b) => dist(a, center) - dist(b, center))
      .slice(0, B.pocketMaxSize);
    if (members.length < 2) continue;

    const memberIds = new Set(members.map((m) => m.id));
    // A spark gap in the main graph must exist close enough to jump in.
    const gapCandidates = nodes
      .filter((n) => n.pocket === -1 && !memberIds.has(n.id) && n.id !== ignitionId && n.kind === 'junction')
      .filter((n) => dist(n, center) <= B.sparkGapMaxDistance)
      .sort((a, b) => dist(a, center) - dist(b, center));
    if (gapCandidates.length === 0) continue;

    // Cut all edges crossing the pocket boundary, then wire the gap.
    edgePairs = edgePairs.filter(([a, b]) => memberIds.has(a) === memberIds.has(b));
    // Keep the pocket internally connected.
    edgePairs = connectComponents(members, edgePairs, memberIds);
    const gap = gapCandidates[0];
    gap.kind = 'sparkGap';
    gap.sparkTargetId = members.sort((a, b) => dist(a, gap) - dist(b, gap))[0].id;
    for (const m of members) m.pocket = pocketsMade;
    pocketsMade++;
  }

  // Reconnect any main-graph node the pocket cuts stranded.
  edgePairs = reconnectMain(nodes, edgePairs, ignitionId);

  // Optional extra spark gap inside the main graph for one more fake finale.
  if (rng() < B.extraSparkGapChance) {
    const mains = nodes.filter((n) => n.pocket === -1 && n.kind === 'junction' && n.id !== ignitionId);
    const from = mains.length > 0 ? mains[randInt(rng, 0, mains.length - 1)] : undefined;
    if (from) {
      const targets = mains
        .filter((n) => n.id !== from.id && dist(n, from) <= B.sparkGapMaxDistance && dist(n, from) >= 1.5)
        .sort((a, b) => dist(a, from) - dist(b, from));
      if (targets.length > 0) {
        from.kind = 'sparkGap';
        from.sparkTargetId = targets[targets.length - 1].id;
      }
    }
  }

  // 4. Distances from ignition (spark jumps count as hops) → socket strata.
  const distances = bfsDistances(nodes, edgePairs, ignitionId);
  const reachable = nodes.filter((n) => distances.get(n.id) !== undefined);
  const maxDist = Math.max(...reachable.map((n) => distances.get(n.id)!));
  const ringOf = (d: number): SocketRing =>
    d <= maxDist / 3 ? 'near' : d <= (2 * maxDist) / 3 ? 'mid' : 'far';

  const S = TUNING.sockets;
  const eligible = (ring: SocketRing) =>
    shuffle(
      rng,
      nodes.filter(
        (n) =>
          n.kind === 'junction' &&
          distances.get(n.id) !== undefined &&
          distances.get(n.id)! > 0 &&
          ringOf(distances.get(n.id)!) === ring,
      ),
    );
  const makeSockets = (ring: SocketRing, count: number, preferPocket: boolean) => {
    let pool = eligible(ring);
    if (preferPocket) pool = [...pool.filter((n) => n.pocket >= 0), ...pool.filter((n) => n.pocket < 0)];
    for (const n of pool.slice(0, count)) {
      n.kind = 'socket';
      n.ring = ring;
    }
  };
  makeSockets('near', S.near, false);
  makeSockets('mid', randInt(rng, S.midMin, S.midMax), false);
  makeSockets('far', randInt(rng, S.farMin, S.farMax), true); // far sockets prefer pockets

  // 5. Remaining special nodes: boosters, splitters, decoys, damp junctions.
  const N = TUNING.nodes;
  const degree = new Map<number, number>();
  for (const [a, b] of edgePairs) {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  const plainJunctions = () =>
    shuffle(rng, nodes.filter((n) => n.kind === 'junction' && distances.get(n.id) !== undefined));

  for (const n of plainJunctions().slice(0, randInt(rng, N.boosterMin, N.boosterMax))) n.kind = 'booster';
  const splitterPool = plainJunctions().filter((n) => (degree.get(n.id) ?? 0) >= 3);
  for (const n of splitterPool.slice(0, randInt(rng, N.splitterMin, N.splitterMax))) n.kind = 'splitter';
  for (const n of plainJunctions().slice(0, randInt(rng, N.decoyMin, N.decoyMax))) {
    n.kind = 'decoy';
    n.decoyValue = randInt(rng, N.decoyValueMin, N.decoyValueMax);
  }
  for (const n of plainJunctions()) {
    const d = distances.get(n.id)!;
    if (d >= N.dampMinDistFromIgnition && rng() < N.dampChance) n.kind = 'damp';
  }

  // 6. Materialize.
  const edges: BoardEdge[] = edgePairs
    .sort(([a1, b1], [a2, b2]) => a1 - a2 || b1 - b2)
    .map(([a, b], id) => ({ id, a, b, burnTicks: randInt(rng, TUNING.edges.burnTicksMin, TUNING.edges.burnTicksMax) }));

  const boardNodes: BoardNode[] = nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    x: n.x,
    y: n.y,
    sparkTargetId: n.sparkTargetId,
    decoyValue: n.decoyValue,
    ring: n.ring,
    distFromIgnition: distances.get(n.id) ?? -1,
  }));

  return {
    seed,
    nodes: boardNodes,
    edges,
    ignitionId,
    socketIds: boardNodes.filter((n) => n.kind === 'socket').map((n) => n.id),
  };
}

/** Union-find stitch: add shortest cross-component edges until connected. */
function connectComponents(
  nodes: GenNode[],
  edgePairs: Array<[number, number]>,
  restrictTo?: Set<number>,
): Array<[number, number]> {
  const ids = restrictTo ? nodes.filter((n) => restrictTo.has(n.id)).map((n) => n.id) : nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const parent = new Map<number, number>(ids.map((id) => [id, id]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: number, b: number) => parent.set(find(a), find(b));
  for (const [a, b] of edgePairs) if (idSet.has(a) && idSet.has(b)) union(a, b);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = edgePairs.slice();
  for (;;) {
    const roots = new Set(ids.map(find));
    if (roots.size <= 1) break;
    const [firstRoot] = roots;
    const inFirst = ids.filter((id) => find(id) === firstRoot);
    const outFirst = ids.filter((id) => find(id) !== firstRoot);
    let best: [number, number] | undefined;
    let bestD = Infinity;
    for (const a of inFirst)
      for (const b of outFirst) {
        const d = dist(byId.get(a)!, byId.get(b)!);
        if (d < bestD) {
          bestD = d;
          best = [Math.min(a, b), Math.max(a, b)];
        }
      }
    if (!best) break;
    result.push(best);
    union(best[0], best[1]);
  }
  return result;
}

/** Ensure every main-graph node is edge-reachable from ignition (pockets excluded: they use spark gaps). */
function reconnectMain(
  nodes: GenNode[],
  edgePairs: Array<[number, number]>,
  ignitionId: number,
): Array<[number, number]> {
  const result = edgePairs.slice();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (;;) {
    const adj = new Map<number, number[]>(nodes.map((n) => [n.id, []]));
    for (const [a, b] of result) {
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    }
    const seen = new Set<number>([ignitionId]);
    const stack = [ignitionId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of adj.get(cur)!)
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
    }
    const stranded = nodes.filter((n) => n.pocket === -1 && !seen.has(n.id));
    if (stranded.length === 0) return result;
    const reachableMain = nodes.filter((n) => n.pocket === -1 && seen.has(n.id));
    let best: [number, number] | undefined;
    let bestD = Infinity;
    for (const s of stranded)
      for (const r of reachableMain) {
        const d = dist(byId.get(s.id)!, byId.get(r.id)!);
        if (d < bestD) {
          bestD = d;
          best = [Math.min(s.id, r.id), Math.max(s.id, r.id)];
        }
      }
    if (!best) return result;
    result.push(best);
  }
}

/** BFS hop distance from ignition; spark gap → target counts as one directed hop. */
function bfsDistances(
  nodes: GenNode[],
  edgePairs: Array<[number, number]>,
  ignitionId: number,
): Map<number, number> {
  const adj = new Map<number, number[]>(nodes.map((n) => [n.id, []]));
  for (const [a, b] of edgePairs) {
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  for (const n of nodes)
    if (n.kind === 'sparkGap' && n.sparkTargetId !== undefined) adj.get(n.id)!.push(n.sparkTargetId);

  const distMap = new Map<number, number>([[ignitionId, 0]]);
  const queue = [ignitionId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur)!.sort((a, b) => a - b)) {
      if (!distMap.has(nb)) {
        distMap.set(nb, distMap.get(cur)! + 1);
        queue.push(nb);
      }
    }
  }
  return distMap;
}
