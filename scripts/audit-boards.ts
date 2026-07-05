/**
 * Headless board audit (GDD §3.5): P(reach) / E[mult|reach] / EV per socket.
 * v0: logging only — no seed rejection. Runs in CI to catch degenerate
 * generator drift early (GDD risk #3).
 *
 * Usage: npm run audit:boards [-- seed1 seed2 ...]
 */
import { auditBoard, canonicalOutcomes, generateBoard, simulate, TICK_MS } from '../src/sim';

const seeds = process.argv.slice(2);
const defaultSeeds = Array.from({ length: 10 }, (_, i) => `audit-seed-${i}`);
const targets = seeds.length > 0 ? seeds : defaultSeeds;

let rejectCount = 0;
const rideLengths: number[] = [];

for (const seed of targets) {
  const board = generateBoard(seed);
  const audit = auditBoard(board);
  const dryRun = simulate(board, canonicalOutcomes(board), []);
  rideLengths.push((dryRun.endTick * TICK_MS) / 1000);

  console.log(`\n=== seed "${seed}" — ${board.nodes.length} nodes, ${board.edges.length} edges, ride ${((dryRun.endTick * TICK_MS) / 1000).toFixed(1)}s ===`);
  console.table(
    audit.sockets
      .slice()
      .sort((a, b) => a.distFromIgnition - b.distFromIgnition)
      .map((s) => ({
        socket: s.socketId,
        ring: s.ring,
        dist: s.distFromIgnition,
        'P(reach)': s.pReach.toFixed(2),
        'E[mult|reach]': s.eMultGivenReach.toFixed(1),
        EV: s.ev.toFixed(2),
      })),
  );
  console.log(`mean EV ${audit.meanEv.toFixed(2)} | would reject: ${audit.wouldReject}`);
  for (const r of audit.reasons) console.log(`  - ${r}`);
  if (audit.wouldReject) rejectCount++;
}

const avgRide = rideLengths.reduce((a, b) => a + b, 0) / rideLengths.length;
console.log(`\n${targets.length} boards audited | ${rejectCount} would be rejected | avg canonical ride ${avgRide.toFixed(1)}s`);
