import { describe, expect, it } from 'vitest';
import { simulate, drawOutcomes, canonicalOutcomes } from '../engine';
import { generateBoard } from '../generator';
import { applyTools, boardDistance, validateTools, type ToolPlacement } from '../tools';
import { TUNING } from '../tuning';
import type { Board, BoardEdge, BoardNode, Outcomes } from '../types';

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
    seed: 'tools-test',
    nodes: fullNodes,
    edges: fullEdges,
    ignitionId: 0,
    socketIds: fullNodes.filter((n) => n.kind === 'socket').map((n) => n.id),
  };
}

const noOutcomes: Outcomes = { dampPass: {}, sparkDelayTicks: {}, splitterHeads: {} };

describe('tools validation', () => {
  it('accepts a legal build within budget', () => {
    // nodes at x=0,1,2,3 — jumper 1-3 spans distance 2 <= 2.3
    const board = makeBoard([{ kind: 'ignition' }, {}, {}, { kind: 'socket' }], [[0, 1, 5]]);
    const tools: ToolPlacement[] = [
      { type: 'jumper', a: 1, b: 3 },
      { type: 'keg', nodeId: 2 },
    ];
    const v = validateTools(board, tools);
    expect(v.ok).toBe(true);
    expect(v.cost).toBe(TUNING.tools.jumperCost + TUNING.tools.kegCost);
  });

  it('rejects budget overruns', () => {
    const board = makeBoard([{ kind: 'ignition' }, {}, {}, {}, {}], [[0, 1, 5]]);
    const tools: ToolPlacement[] = [
      { type: 'keg', nodeId: 1 },
      { type: 'keg', nodeId: 2 },
      { type: 'keg', nodeId: 3 },
      { type: 'keg', nodeId: 4 },
    ];
    const v = validateTools(board, tools);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('budget'))).toBe(true);
  });

  it('rejects out-of-range jumpers, duplicate fuses and kegs on special nodes', () => {
    const board = makeBoard(
      [{ kind: 'ignition' }, {}, { kind: 'damp' }, {}, {}, {}],
      [
        [0, 1, 5],
        [1, 2, 5],
      ],
    );
    expect(validateTools(board, [{ type: 'jumper', a: 0, b: 5 }]).ok).toBe(false); // distance 5
    expect(validateTools(board, [{ type: 'jumper', a: 0, b: 1 }]).ok).toBe(false); // already an edge
    expect(validateTools(board, [{ type: 'jumper', a: 1, b: 1 }]).ok).toBe(false); // self-loop
    expect(validateTools(board, [{ type: 'keg', nodeId: 2 }]).ok).toBe(false); // damp, not junction
    const dup: ToolPlacement[] = [
      { type: 'jumper', a: 1, b: 3 },
      { type: 'jumper', a: 3, b: 1 },
    ];
    expect(validateTools(board, dup).ok).toBe(false);
  });

  it('boardDistance measures grid distance', () => {
    const board = makeBoard([{ kind: 'ignition' }, {}, {}], [[0, 1, 5]]);
    expect(boardDistance(board, 0, 2)).toBe(2);
  });
});

describe('applyTools', () => {
  it('adds jumper edges and converts keg junctions to boosters, immutably', () => {
    const board = makeBoard([{ kind: 'ignition' }, {}, {}, { kind: 'socket' }], [[0, 1, 5]]);
    const tools: ToolPlacement[] = [
      { type: 'jumper', a: 1, b: 3 },
      { type: 'keg', nodeId: 2 },
    ];
    const rigged = applyTools(board, tools);
    expect(rigged.edges.length).toBe(2);
    expect(rigged.edges[1]).toMatchObject({ a: 1, b: 3, burnTicks: TUNING.tools.jumperBurnTicks });
    expect(rigged.nodes[2].kind).toBe('booster');
    // base board untouched
    expect(board.edges.length).toBe(1);
    expect(board.nodes[2].kind).toBe('junction');
  });

  it('application order is deterministic regardless of input order', () => {
    const board = makeBoard([{ kind: 'ignition' }, {}, {}, {}, {}], [[0, 1, 5]]);
    const a: ToolPlacement[] = [
      { type: 'jumper', a: 1, b: 3 },
      { type: 'jumper', a: 2, b: 4 },
    ];
    const b = [...a].reverse();
    expect(JSON.stringify(applyTools(board, a))).toBe(JSON.stringify(applyTools(board, b)));
  });

  it('a jumper opens a route fire actually uses', () => {
    // socket 3 is unreachable without the jumper from 1
    const board = makeBoard([{ kind: 'ignition' }, {}, {}, { kind: 'socket', x: 2.5 }], [[0, 1, 5]]);
    const bare = simulate(board, noOutcomes, [{ socketId: 3, baseValue: 10 }]);
    expect(bare.shellScore).toBe(0);
    const rigged = applyTools(board, [{ type: 'jumper', a: 1, b: 3 }]);
    const run = simulate(rigged, noOutcomes, [{ socketId: 3, baseValue: 10 }]);
    expect(run.shellScore).toBeGreaterThan(0);
  });

  it('a keg boosts the multiplier like a natural booster', () => {
    const board = makeBoard(
      [{ kind: 'ignition' }, {}, { kind: 'socket' }],
      [
        [0, 1, 10],
        [1, 2, 10],
      ],
    );
    const rigged = applyTools(board, [{ type: 'keg', nodeId: 1 }]);
    const run = simulate(rigged, noOutcomes, [{ socketId: 2, baseValue: 10 }]);
    const paid = run.events.find((e) => e.type === 'SHELL_PAID');
    expect(paid && paid.type === 'SHELL_PAID' && paid.multiplier).toBe(1.5);
    expect(paid && paid.type === 'SHELL_PAID' && paid.tick).toBe(10 + 5); // boosted edge
  });

  it('full run stays bit-identical with tools in the replay payload', () => {
    const board = generateBoard('toolbox-determinism');
    // Find a legal jumper pair deterministically.
    const edgeKeys = new Set(board.edges.map((e) => `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`));
    let jumper: ToolPlacement | undefined;
    outer: for (const a of board.nodes) {
      for (const b of board.nodes) {
        if (a.id >= b.id) continue;
        const key = `${a.id}-${b.id}`;
        if (edgeKeys.has(key)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) <= TUNING.tools.jumperMaxDistance) {
          jumper = { type: 'jumper', a: a.id, b: b.id };
          break outer;
        }
      }
    }
    expect(jumper).toBeDefined();
    const keg = board.nodes.find((n) => n.kind === 'junction');
    const tools: ToolPlacement[] = [jumper!, { type: 'keg', nodeId: keg!.id }];
    expect(validateTools(board, tools).ok).toBe(true);
    const placements = board.socketIds.slice(0, 3).map((socketId) => ({ socketId, baseValue: 10 }));

    const run = () => {
      const rigged = applyTools(generateBoard('toolbox-determinism'), tools);
      return simulate(rigged, canonicalOutcomes(rigged), placements);
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('keg conversion does not disturb seeded outcome draws', () => {
    const board = generateBoard('outcome-stability');
    const keg = board.nodes.find((n) => n.kind === 'junction')!;
    const rigged = applyTools(board, [{ type: 'keg', nodeId: keg.id }]);
    const rngA = canonicalOutcomes(board);
    const rngB = canonicalOutcomes(rigged);
    expect(JSON.stringify(rngA)).toBe(JSON.stringify(rngB));
    void drawOutcomes; // (imported for symmetry with engine tests)
  });
});
