import { describe, expect, it } from 'vitest';
import { auditBoard } from '../audit';
import { generateBoard } from '../generator';

describe('auditBoard', () => {
  it('produces per-socket stats with sane bounds', () => {
    const board = generateBoard('audit-smoke');
    const audit = auditBoard(board, 100);
    expect(audit.sockets.length).toBe(board.socketIds.length);
    for (const s of audit.sockets) {
      expect(s.pReach).toBeGreaterThanOrEqual(0);
      expect(s.pReach).toBeLessThanOrEqual(1);
      expect(s.ev).toBeGreaterThanOrEqual(0);
      if (s.pReach > 0) expect(s.eMultGivenReach).toBeGreaterThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    const board = generateBoard('audit-repeat');
    expect(JSON.stringify(auditBoard(board, 50))).toBe(JSON.stringify(auditBoard(board, 50)));
  });

  it('near sockets reach more often than far sockets (pillar 1, aggregate)', () => {
    // Aggregated over several seeds so a single odd board doesn't flake the suite.
    let nearSum = 0;
    let nearCount = 0;
    let farSum = 0;
    let farCount = 0;
    for (let i = 0; i < 8; i++) {
      const audit = auditBoard(generateBoard(`stratification-${i}`), 120);
      for (const s of audit.sockets) {
        if (s.ring === 'near') {
          nearSum += s.pReach;
          nearCount++;
        }
        if (s.ring === 'far') {
          farSum += s.pReach;
          farCount++;
        }
      }
    }
    expect(nearSum / nearCount).toBeGreaterThan(farSum / farCount);
  });
});
