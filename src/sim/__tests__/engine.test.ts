import { describe, expect, it } from 'vitest';
import { canonicalOutcomes, simulate } from '../engine';
import { TUNING } from '../tuning';
import type { Board, BoardEdge, BoardNode, Outcomes } from '../types';

/** Hand-built minimal boards so each node behavior is tested in isolation. */
function makeBoard(nodes: Partial<BoardNode>[], edges: Array<[number, number, number]>): Board {
  const fullNodes: BoardNode[] = nodes.map((n, i) => ({
    id: i,
    kind: 'junction',
    x: i,
    y: 0,
    distFromIgnition: i,
    ...n,
  }));
  const fullEdges: BoardEdge[] = edges.map(([a, b, burnTicks], id) => ({ id, a, b, burnTicks }));
  return {
    seed: 'test',
    nodes: fullNodes,
    edges: fullEdges,
    ignitionId: 0,
    socketIds: fullNodes.filter((n) => n.kind === 'socket').map((n) => n.id),
  };
}

const noOutcomes: Outcomes = { dampPass: {}, sparkDelayTicks: {}, splitterHeads: {} };

describe('engine', () => {
  it('fire crawls a line of junctions, multiplier +1 each', () => {
    // ignition -> junction -> junction -> socket
    const board = makeBoard(
      [{ kind: 'ignition' }, {}, {}, { kind: 'socket' }],
      [
        [0, 1, 10],
        [1, 2, 10],
        [2, 3, 10],
      ],
    );
    const result = simulate(board, noOutcomes, [{ socketId: 3, baseValue: 10 }]);
    // x1 start, +1 at node1, +1 at node2 => shell pays at x3
    expect(result.shellScore).toBe(30);
    expect(result.peakMultiplier).toBe(3);
    const paid = result.events.find((e) => e.type === 'SHELL_PAID');
    expect(paid && paid.type === 'SHELL_PAID' && paid.tick).toBe(30);
  });

  it('damp junction with failing roll kills the chain (FIZZLE, no spread)', () => {
    const board = makeBoard(
      [{ kind: 'ignition' }, { kind: 'damp' }, { kind: 'socket' }],
      [
        [0, 1, 5],
        [1, 2, 5],
      ],
    );
    const result = simulate(board, { ...noOutcomes, dampPass: { 1: false } }, [{ socketId: 2, baseValue: 10 }]);
    expect(result.events.some((e) => e.type === 'FIZZLE')).toBe(true);
    expect(result.shellScore).toBe(0);
    expect(result.reachedNodeIds).not.toContain(2);
  });

  it('damp junction pass adds +2 and delays spread by 0.6s (12 ticks)', () => {
    const board = makeBoard(
      [{ kind: 'ignition' }, { kind: 'damp' }, { kind: 'socket' }],
      [
        [0, 1, 5],
        [1, 2, 5],
      ],
    );
    const result = simulate(board, { ...noOutcomes, dampPass: { 1: true } }, [{ socketId: 2, baseValue: 10 }]);
    const paid = result.events.find((e) => e.type === 'SHELL_PAID');
    expect(paid && paid.type === 'SHELL_PAID' && paid.multiplier).toBe(3); // 1 + 2
    // arrival at damp t=5, spread starts t=17, socket at t=22
    expect(paid && paid.type === 'SHELL_PAID' && paid.tick).toBe(5 + TUNING.nodes.dampDelayTicks + 5);
  });

  it('booster multiplies x1.5 and burns the next edges at double speed', () => {
    const board = makeBoard(
      [{ kind: 'ignition' }, { kind: 'booster' }, { kind: 'socket' }],
      [
        [0, 1, 10],
        [1, 2, 10],
      ],
    );
    const result = simulate(board, noOutcomes, [{ socketId: 2, baseValue: 10 }]);
    const paid = result.events.find((e) => e.type === 'SHELL_PAID');
    expect(paid && paid.type === 'SHELL_PAID' && paid.multiplier).toBe(1.5);
    expect(paid && paid.type === 'SHELL_PAID' && paid.tick).toBe(10 + 5); // boosted edge: 10 -> 5 ticks
  });

  it('spark gap jumps to its target after the drawn delay (+3 multiplier)', () => {
    // Socket island is NOT edge-connected: only the jump reaches it.
    const board = makeBoard(
      [{ kind: 'ignition' }, { kind: 'sparkGap', sparkTargetId: 2 }, { kind: 'socket' }],
      [[0, 1, 5]],
    );
    const result = simulate(board, { ...noOutcomes, sparkDelayTicks: { 1: 20 } }, [{ socketId: 2, baseValue: 10 }]);
    const jump = result.events.find((e) => e.type === 'SPARK_JUMP');
    expect(jump && jump.type === 'SPARK_JUMP' && jump.arriveTick).toBe(25);
    const paid = result.events.find((e) => e.type === 'SHELL_PAID');
    expect(paid && paid.type === 'SHELL_PAID' && paid.tick).toBe(25);
    expect(paid && paid.type === 'SHELL_PAID' && paid.multiplier).toBe(4); // 1 + 3
  });

  it('splitter emits limited number of heads', () => {
    // splitter with 3 outgoing edges but only 2 heads drawn
    const board = makeBoard(
      [{ kind: 'ignition' }, { kind: 'splitter' }, {}, {}, {}],
      [
        [0, 1, 5],
        [1, 2, 5],
        [1, 3, 5],
        [1, 4, 5],
      ],
    );
    const result = simulate(board, { ...noOutcomes, splitterHeads: { 1: 2 } }, []);
    const burns = result.events.filter((e) => e.type === 'EDGE_BURN_START' && e.fromNodeId === 1);
    expect(burns.length).toBe(2);
  });

  it('decoy pays its fixed value and keeps the chain alive', () => {
    const board = makeBoard(
      [{ kind: 'ignition' }, { kind: 'decoy', decoyValue: 12 }, { kind: 'socket' }],
      [
        [0, 1, 5],
        [1, 2, 5],
      ],
    );
    const result = simulate(board, noOutcomes, [{ socketId: 2, baseValue: 10 }]);
    expect(result.decoyScore).toBe(12);
    expect(result.shellScore).toBe(20); // decoy adds +1 => x2
  });

  it('multiplier is capped', () => {
    const nodes: Partial<BoardNode>[] = [{ kind: 'ignition' }];
    const edges: Array<[number, number, number]> = [];
    for (let i = 1; i <= 120; i++) {
      nodes.push({});
      edges.push([i - 1, i, 1]);
    }
    const result = simulate(makeBoard(nodes, edges), noOutcomes, []);
    expect(result.peakMultiplier).toBe(TUNING.multiplier.cap);
  });

  it('empty sockets pay nothing but fire passes through', () => {
    const board = makeBoard(
      [{ kind: 'ignition' }, { kind: 'socket' }, { kind: 'socket' }],
      [
        [0, 1, 5],
        [1, 2, 5],
      ],
    );
    const result = simulate(board, noOutcomes, [{ socketId: 2, baseValue: 10 }]);
    expect(result.paidSocketIds).toEqual([2]);
    expect(result.reachedNodeIds).toContain(1);
  });

  it('is bit-identical across repeated runs (determinism LAW)', async () => {
    const { generateBoard } = await import('../generator');
    for (const seed of ['alpha', 'beta', 'tournament-2026-07-05']) {
      const b1 = generateBoard(seed);
      const b2 = generateBoard(seed);
      const placements = b1.socketIds.slice(0, 3).map((socketId) => ({ socketId, baseValue: 10 }));
      const r1 = simulate(b1, canonicalOutcomes(b1), placements);
      const r2 = simulate(b2, canonicalOutcomes(b2), placements);
      expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    }
  });
});
