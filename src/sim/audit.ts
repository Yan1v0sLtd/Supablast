/**
 * Monte Carlo EV auditor (GDD §3.5 steps 4-5).
 * Redraws stochastic outcomes N times and measures, per socket:
 *   P(reach), E[multiplier | reach], EV = P(reach) x E[mult | reach].
 * v0 scope contract: no seed rejection at runtime — log only. The flags are
 * computed so CI and tuning notebooks can watch for degenerate boards.
 */
import { drawOutcomes, simulate } from './engine';
import { mulberry32, hashSeed } from './prng';
import { TUNING } from './tuning';
import type { Board, SocketRing } from './types';

export interface SocketAudit {
  socketId: number;
  ring: SocketRing | undefined;
  distFromIgnition: number;
  pReach: number;
  eMultGivenReach: number;
  ev: number;
}

export interface BoardAudit {
  seed: string;
  iterations: number;
  sockets: SocketAudit[];
  meanEv: number;
  /** Would this seed be rejected under GDD §3.5 step 5? (v0: logged, not enforced) */
  wouldReject: boolean;
  reasons: string[];
}

export function auditBoard(board: Board, iterations = TUNING.audit.iterations): BoardAudit {
  const auditRng = mulberry32(hashSeed(board.seed + ':audit'));
  // Probe shells of baseValue 1 on every socket: payout === multiplier-at-arrival.
  const probes = board.socketIds.map((socketId) => ({ socketId, baseValue: 1 }));

  const reachCount = new Map<number, number>(board.socketIds.map((id) => [id, 0]));
  const multSum = new Map<number, number>(board.socketIds.map((id) => [id, 0]));

  for (let i = 0; i < iterations; i++) {
    const outcomes = drawOutcomes(board, auditRng);
    const result = simulate(board, outcomes, probes);
    for (const e of result.events) {
      if (e.type === 'SHELL_PAID') {
        reachCount.set(e.nodeId, reachCount.get(e.nodeId)! + 1);
        multSum.set(e.nodeId, multSum.get(e.nodeId)! + e.multiplier);
      }
    }
  }

  const nodeById = new Map(board.nodes.map((n) => [n.id, n]));
  const sockets: SocketAudit[] = board.socketIds.map((socketId) => {
    const reached = reachCount.get(socketId)!;
    const pReach = reached / iterations;
    const eMult = reached > 0 ? multSum.get(socketId)! / reached : 0;
    const node = nodeById.get(socketId)!;
    return {
      socketId,
      ring: node.ring,
      distFromIgnition: node.distFromIgnition,
      pReach,
      eMultGivenReach: eMult,
      ev: pReach * eMult,
    };
  });

  const meanEv = sockets.reduce((s, x) => s + x.ev, 0) / Math.max(1, sockets.length);
  const reasons: string[] = [];
  const A = TUNING.audit;
  for (const s of sockets) {
    if (meanEv > 0 && Math.abs(s.ev - meanEv) / meanEv > A.evDeviationLimit) {
      reasons.push(
        `socket ${s.socketId} (${s.ring}) EV ${s.ev.toFixed(2)} deviates >±${A.evDeviationLimit * 100}% from mean ${meanEv.toFixed(2)}`,
      );
    }
  }
  const farthest = sockets.reduce((a, b) => (b.distFromIgnition > a.distFromIgnition ? b : a), sockets[0]);
  if (farthest && (farthest.pReach < A.farthestReachMin || farthest.pReach > A.farthestReachMax)) {
    reasons.push(
      `farthest socket ${farthest.socketId} P(reach)=${farthest.pReach.toFixed(2)} outside [${A.farthestReachMin}, ${A.farthestReachMax}]`,
    );
  }

  return { seed: board.seed, iterations, sockets, meanEv, wouldReject: reasons.length > 0, reasons };
}
