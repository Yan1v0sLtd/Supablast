import { describe, expect, it } from 'vitest';
import { hashSeed, mulberry32, randInt, rngFromString, shuffle } from '../prng';

describe('prng', () => {
  it('same seed produces identical sequences', () => {
    const a = rngFromString('grand-finale');
    const b = rngFromString('grand-finale');
    for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
  });

  it('different seeds diverge', () => {
    const a = rngFromString('seed-1');
    const b = rngFromString('seed-2');
    const same = Array.from({ length: 20 }, () => a() === b()).filter(Boolean).length;
    expect(same).toBeLessThan(3);
  });

  it('outputs stay within [0, 1)', () => {
    const rng = mulberry32(hashSeed('range'));
    for (let i = 0; i < 10000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('randInt covers the inclusive range', () => {
    const rng = rngFromString('ints');
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(randInt(rng, 3, 6));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('shuffle is deterministic and preserves elements', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const s1 = shuffle(rngFromString('mix'), input);
    const s2 = shuffle(rngFromString('mix'), input);
    expect(s1).toEqual(s2);
    expect([...s1].sort()).toEqual(input);
  });
});
