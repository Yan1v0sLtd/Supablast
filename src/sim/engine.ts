/**
 * Fixed-timestep, event-driven fire propagation engine (GDD §3).
 * Pure and deterministic: identical (board, outcomes, placements) produce a
 * bit-identical event stream on any platform (GDD §3.4, LAW).
 */
import { rngFromString, randInt, type Rng } from './prng';
import { TUNING } from './tuning';
import type { Board, BoardEdge, Outcomes, Placement, RunResult, SimEvent } from './types';

/** Draw the per-run stochastic outcomes from an explicit rng (auditor use). */
export function drawOutcomes(board: Board, rng: Rng): Outcomes {
  const t = TUNING.nodes;
  const outcomes: Outcomes = { dampPass: {}, sparkDelayTicks: {}, splitterHeads: {} };
  // Node id order is stable, keeping draws deterministic.
  for (const node of board.nodes) {
    if (node.kind === 'damp') outcomes.dampPass[node.id] = rng() < t.dampPassChance;
    if (node.kind === 'sparkGap')
      outcomes.sparkDelayTicks[node.id] = randInt(rng, t.sparkDelayTicksMin, t.sparkDelayTicksMax);
    if (node.kind === 'splitter')
      outcomes.splitterHeads[node.id] = randInt(rng, t.splitterHeadsMin, t.splitterHeadsMax);
  }
  return outcomes;
}

/** Canonical outcomes for a real run: derived from the board seed itself. */
export function canonicalOutcomes(board: Board): Outcomes {
  return drawOutcomes(board, rngFromString(board.seed + ':outcomes'));
}

interface Arrival {
  tick: number;
  seq: number; // insertion order tiebreaker for total determinism
  nodeId: number;
  boostRemaining: number;
}

export function simulate(board: Board, outcomes: Outcomes, placements: Placement[]): RunResult {
  const m = TUNING.multiplier;
  const events: SimEvent[] = [];
  const edgesByNode = new Map<number, BoardEdge[]>();
  for (const node of board.nodes) edgesByNode.set(node.id, []);
  for (const edge of board.edges) {
    edgesByNode.get(edge.a)!.push(edge);
    edgesByNode.get(edge.b)!.push(edge);
  }
  const nodeById = new Map(board.nodes.map((n) => [n.id, n]));
  const shellBySocket = new Map(placements.map((p) => [p.socketId, p]));

  const burnedNodes = new Set<number>();
  const burnedEdges = new Set<number>();
  const queue: Arrival[] = [];
  let seqCounter = 0;
  let multiplier = m.start;
  let peakMultiplier = multiplier;
  let shellScore = 0;
  let decoyScore = 0;
  const paidSocketIds: number[] = [];

  const push = (tick: number, nodeId: number, boostRemaining: number) => {
    queue.push({ tick, seq: seqCounter++, nodeId, boostRemaining });
  };

  const popEarliest = (): Arrival | undefined => {
    if (queue.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      const q = queue[i];
      const b = queue[best];
      if (q.tick < b.tick || (q.tick === b.tick && q.seq < b.seq)) best = i;
    }
    return queue.splice(best, 1)[0];
  };

  const setMultiplier = (tick: number, value: number) => {
    multiplier = Math.min(m.cap, value);
    peakMultiplier = Math.max(peakMultiplier, multiplier);
    events.push({ type: 'MULTIPLIER_CHANGED', tick, value: multiplier });
  };

  /** Spread fire from a node along its unburned edges. */
  const spread = (tick: number, nodeId: number, boostRemaining: number, maxHeads?: number) => {
    const candidates = edgesByNode
      .get(nodeId)!
      .filter((e) => !burnedEdges.has(e.id))
      .filter((e) => !burnedNodes.has(e.a === nodeId ? e.b : e.a))
      .sort((x, y) => x.id - y.id);
    const chosen = maxHeads !== undefined ? candidates.slice(0, maxHeads) : candidates;
    for (const edge of chosen) {
      burnedEdges.add(edge.id);
      const target = edge.a === nodeId ? edge.b : edge.a;
      const duration = boostRemaining > 0 ? Math.max(1, Math.ceil(edge.burnTicks / 2)) : edge.burnTicks;
      events.push({ type: 'EDGE_BURN_START', tick, edgeId: edge.id, fromNodeId: nodeId, durationTicks: duration });
      push(tick + duration, target, Math.max(0, boostRemaining - 1));
    }
  };

  events.push({ type: 'IGNITED', tick: 0, nodeId: board.ignitionId });
  push(0, board.ignitionId, 0);

  let lastActivityTick = 0;
  for (;;) {
    const arrival = popEarliest();
    if (!arrival) break;
    if (arrival.tick > TUNING.run.maxTicks) break;
    if (burnedNodes.has(arrival.nodeId)) continue; // converging heads merge

    const { tick, nodeId, boostRemaining } = arrival;
    const node = nodeById.get(nodeId)!;
    burnedNodes.add(nodeId);
    lastActivityTick = Math.max(lastActivityTick, tick);
    events.push({ type: 'NODE_ARRIVED', tick, nodeId });

    switch (node.kind) {
      case 'ignition':
        spread(tick, nodeId, boostRemaining);
        break;
      case 'junction':
        setMultiplier(tick, multiplier + m.junction);
        spread(tick, nodeId, boostRemaining);
        break;
      case 'damp': {
        if (!outcomes.dampPass[nodeId]) {
          events.push({ type: 'FIZZLE', tick, nodeId });
        } else {
          setMultiplier(tick, multiplier + m.damp);
          spread(tick + TUNING.nodes.dampDelayTicks, nodeId, boostRemaining);
          lastActivityTick = Math.max(lastActivityTick, tick + TUNING.nodes.dampDelayTicks);
        }
        break;
      }
      case 'booster':
        setMultiplier(tick, multiplier * TUNING.nodes.boosterFactor);
        spread(tick, nodeId, TUNING.nodes.boosterEdges);
        break;
      case 'sparkGap': {
        setMultiplier(tick, multiplier + m.sparkGap);
        spread(tick, nodeId, boostRemaining);
        if (node.sparkTargetId !== undefined && !burnedNodes.has(node.sparkTargetId)) {
          const delay = outcomes.sparkDelayTicks[nodeId] ?? TUNING.nodes.sparkDelayTicksMin;
          const arriveTick = tick + delay;
          events.push({ type: 'SPARK_JUMP', tick, fromNodeId: nodeId, targetNodeId: node.sparkTargetId, arriveTick });
          push(arriveTick, node.sparkTargetId, 0);
          lastActivityTick = Math.max(lastActivityTick, arriveTick);
        }
        break;
      }
      case 'splitter':
        setMultiplier(tick, multiplier + m.splitter);
        spread(tick, nodeId, boostRemaining, outcomes.splitterHeads[nodeId] ?? TUNING.nodes.splitterHeadsMin);
        break;
      case 'decoy': {
        const value = node.decoyValue ?? TUNING.nodes.decoyValueMin;
        decoyScore += value;
        events.push({ type: 'DECOY_PAID', tick, nodeId, value });
        setMultiplier(tick, multiplier + m.decoy);
        spread(tick, nodeId, boostRemaining);
        break;
      }
      case 'socket': {
        const shell = shellBySocket.get(nodeId);
        if (shell) {
          const payout = Math.round(shell.baseValue * multiplier);
          shellScore += payout;
          paidSocketIds.push(nodeId);
          events.push({ type: 'SHELL_PAID', tick, nodeId, baseValue: shell.baseValue, multiplier, payout });
        }
        spread(tick, nodeId, boostRemaining);
        break;
      }
    }
  }

  const totalScore = shellScore + decoyScore;
  events.push({ type: 'CHAIN_DIED', tick: lastActivityTick });
  events.push({ type: 'RUN_END', tick: lastActivityTick, totalScore, peakMultiplier });

  return {
    events,
    totalScore,
    shellScore,
    decoyScore,
    peakMultiplier,
    endTick: lastActivityTick,
    paidSocketIds,
    reachedNodeIds: [...burnedNodes],
  };
}
