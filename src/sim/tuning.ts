/**
 * Every gameplay number in one place (GDD: "tuning a spreadsheet exercise").
 * All values are v0 placeholders unless the GDD marks them LAW.
 */
export const TICK_MS = 50; // fixed timestep (GDD §3.4, LAW)

export const TUNING = {
  /** Board generation (GDD §3.5) */
  board: {
    nodeCountMin: 40,
    nodeCountMax: 70,
    cols: 7,
    rows: 12,
    jitter: 0.25,
    neighborRadius: 1.45,
    edgeKeepChance: 0.6,
    pocketCountMin: 1,
    pocketCountMax: 2,
    pocketMaxSize: 4,
    pocketRegionMaxRow: 4, // pockets live in the top rows (far from ignition)
    sparkGapMaxDistance: 3.2,
    extraSparkGapChance: 0.5,
  },
  /** Sockets: 2 near, 3–4 mid, 2–3 far (GDD §3.5 step 3) */
  sockets: {
    near: 2,
    midMin: 3,
    midMax: 4,
    farMin: 2,
    farMax: 3,
  },
  nodes: {
    dampChance: 0.25, // fraction of plain junctions converted to damp
    dampMinDistFromIgnition: 3, // keep the fragile zone away from ignition

    dampPassChance: 0.65, // GDD §3.1: 35% dies / 65% passes
    dampDelayTicks: 12, // 0.6s
    boosterMin: 1,
    boosterMax: 2,
    boosterFactor: 1.5,
    boosterEdges: 3, // fire exits at 2x speed for next 3 edges
    splitterMin: 1,
    splitterMax: 2,
    splitterHeadsMin: 2,
    splitterHeadsMax: 3,
    decoyMin: 2,
    decoyMax: 4,
    decoyValueMin: 5,
    decoyValueMax: 15,
    sparkDelayTicksMin: 16, // 0.8s
    sparkDelayTicksMax: 30, // 1.5s
  },
  edges: {
    burnTicksMin: 8, // 0.4s
    burnTicksMax: 16, // 0.8s
  },
  multiplier: {
    start: 1,
    cap: 100, // v0 cap (GDD §3.3)
    junction: 1,
    damp: 2,
    sparkGap: 3,
    splitter: 2,
    decoy: 1,
  },
  run: {
    shellsPerRun: 3,
    shellBaseValue: 10,
    maxTicks: 3600, // 3min hard stop; a healthy ride is 15–25s
  },
  audit: {
    iterations: 500,
    evDeviationLimit: 0.2, // ±20% from board mean
    farthestReachMin: 0.05,
    farthestReachMax: 0.6,
  },
};
