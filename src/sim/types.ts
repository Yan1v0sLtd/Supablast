/** Core data model for the fuse-network simulation (GDD §3). Zero Phaser deps. */

export type NodeKind =
  | 'ignition'
  | 'junction'
  | 'damp'
  | 'booster'
  | 'sparkGap'
  | 'splitter'
  | 'decoy'
  | 'socket';

export type SocketRing = 'near' | 'mid' | 'far';

export interface BoardNode {
  id: number;
  kind: NodeKind;
  /** Board-space coordinates (grid units with jitter); render maps to screen. */
  x: number;
  y: number;
  /** sparkGap only: the node the spark jumps to (pre-drawn at generation, LAW §3.4). */
  sparkTargetId?: number;
  /** decoy only: fixed payout, pre-drawn at generation. */
  decoyValue?: number;
  /** socket only: distance stratum (GDD §3.5). */
  ring?: SocketRing;
  /** Graph hop distance from ignition (spark jumps count as one hop). */
  distFromIgnition: number;
}

export interface BoardEdge {
  id: number;
  a: number;
  b: number;
  burnTicks: number;
}

export interface Board {
  seed: string;
  nodes: BoardNode[];
  edges: BoardEdge[];
  ignitionId: number;
  socketIds: number[];
}

/**
 * Stochastic outcomes, pre-drawn before ignition (GDD §3.4: "drawn at
 * generation time, not at ignition time"). The canonical run draws them from
 * the board seed; the Monte Carlo auditor redraws them per iteration to
 * estimate P(reach) / E[mult | reach] per socket.
 */
export interface Outcomes {
  dampPass: Record<number, boolean>;
  sparkDelayTicks: Record<number, number>;
  splitterHeads: Record<number, number>;
}

export interface Placement {
  socketId: number;
  baseValue: number;
}

export type SimEvent =
  | { type: 'IGNITED'; tick: number; nodeId: number }
  | { type: 'NODE_ARRIVED'; tick: number; nodeId: number }
  | { type: 'EDGE_BURN_START'; tick: number; edgeId: number; fromNodeId: number; durationTicks: number }
  | { type: 'MULTIPLIER_CHANGED'; tick: number; value: number }
  | { type: 'FIZZLE'; tick: number; nodeId: number }
  | { type: 'SPARK_JUMP'; tick: number; fromNodeId: number; targetNodeId: number; arriveTick: number }
  | { type: 'SHELL_PAID'; tick: number; nodeId: number; baseValue: number; multiplier: number; payout: number }
  | { type: 'DECOY_PAID'; tick: number; nodeId: number; value: number }
  | { type: 'CHAIN_DIED'; tick: number }
  | { type: 'RUN_END'; tick: number; totalScore: number; peakMultiplier: number };

export interface RunResult {
  events: SimEvent[];
  totalScore: number;
  shellScore: number;
  decoyScore: number;
  peakMultiplier: number;
  endTick: number;
  /** Socket ids whose shells paid out. */
  paidSocketIds: number[];
  /** Node ids reached by fire (for post-run analysis). */
  reachedNodeIds: number[];
}
