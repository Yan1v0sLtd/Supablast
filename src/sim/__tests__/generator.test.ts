import { describe, expect, it } from 'vitest';
import { generateBoard } from '../generator';
import { TUNING } from '../tuning';

const SEEDS = Array.from({ length: 25 }, (_, i) => `gen-test-${i}`);

describe('generator', () => {
  it('is deterministic per seed', () => {
    for (const seed of SEEDS.slice(0, 5)) {
      expect(JSON.stringify(generateBoard(seed))).toBe(JSON.stringify(generateBoard(seed)));
    }
  });

  it('node count stays in the GDD range', () => {
    for (const seed of SEEDS) {
      const b = generateBoard(seed);
      expect(b.nodes.length).toBeGreaterThanOrEqual(TUNING.board.nodeCountMin);
      expect(b.nodes.length).toBeLessThanOrEqual(TUNING.board.nodeCountMax);
    }
  });

  it('has exactly one ignition point (v0 scope)', () => {
    for (const seed of SEEDS) {
      const b = generateBoard(seed);
      expect(b.nodes.filter((n) => n.kind === 'ignition').length).toBe(1);
      expect(b.nodes[b.ignitionId].kind).toBe('ignition');
    }
  });

  it('places 6-10 sockets stratified near/mid/far', () => {
    for (const seed of SEEDS) {
      const b = generateBoard(seed);
      const sockets = b.nodes.filter((n) => n.kind === 'socket');
      expect(sockets.length).toBeGreaterThanOrEqual(6);
      expect(sockets.length).toBeLessThanOrEqual(10);
      const rings = new Set(sockets.map((s) => s.ring));
      expect(rings.has('near')).toBe(true);
      expect(rings.has('mid')).toBe(true);
      expect(rings.has('far')).toBe(true);
    }
  });

  it('every socket is reachable from ignition (edges + spark jumps)', () => {
    for (const seed of SEEDS) {
      const b = generateBoard(seed);
      for (const id of b.socketIds) {
        const node = b.nodes.find((n) => n.id === id)!;
        expect(node.distFromIgnition).toBeGreaterThan(0);
      }
    }
  });

  it('spark gaps have valid targets', () => {
    for (const seed of SEEDS) {
      const b = generateBoard(seed);
      for (const gap of b.nodes.filter((n) => n.kind === 'sparkGap')) {
        expect(gap.sparkTargetId).toBeDefined();
        expect(b.nodes.some((n) => n.id === gap.sparkTargetId)).toBe(true);
      }
    }
  });

  it('edge burn durations are within tuning bounds', () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const b = generateBoard(seed);
      for (const e of b.edges) {
        expect(e.burnTicks).toBeGreaterThanOrEqual(TUNING.edges.burnTicksMin);
        expect(e.burnTicks).toBeLessThanOrEqual(TUNING.edges.burnTicksMax);
      }
    }
  });

  it('different seeds produce different boards (not solvable)', () => {
    const a = generateBoard('day-1');
    const b = generateBoard('day-2');
    expect(JSON.stringify(a.nodes)).not.toBe(JSON.stringify(b.nodes));
  });
});
