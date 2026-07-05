/**
 * /render — Phaser 3 presentation layer (GDD §9).
 * Consumes the SimEvent stream produced by /sim and interpolates between
 * fixed ticks. Holds ZERO game logic: by the time playback starts, the whole
 * run has already been simulated.
 *
 * v0 art contract (GDD §10): rectangles and circles are fine; the crawling
 * spark is the one piece of juice that isn't optional.
 */
import Phaser from 'phaser';
import { TICK_MS } from '../sim';
import type { Board, BoardEdge, BoardNode, RunResult, SimEvent } from '../sim';

export interface SceneBridge {
  onSocketToggled(socketId: number, placed: boolean): void;
  onHud(update: { multiplier?: number; score?: number; scoreDelta?: number }): void;
  onRunFinished(): void;
}

const KIND_STYLE: Record<BoardNode['kind'], { color: number; radius: number; label?: string }> = {
  ignition: { color: 0xff4433, radius: 11 },
  junction: { color: 0x6b7280, radius: 5 },
  damp: { color: 0x3b82f6, radius: 8, label: 'D' },
  booster: { color: 0xf97316, radius: 9, label: 'B' },
  sparkGap: { color: 0xd946ef, radius: 8, label: 'G' },
  splitter: { color: 0xeab308, radius: 8, label: 'S' },
  decoy: { color: 0x22c55e, radius: 6 },
  socket: { color: 0xe5e7eb, radius: 12 },
};

const BURNED_EDGE_COLOR = 0xffa726;
const UNBURNED_EDGE_COLOR = 0x2f3650;

interface ActiveBurn {
  edge: BoardEdge;
  fromNodeId: number;
  startTick: number;
  durationTicks: number;
  spark: Phaser.GameObjects.Arc;
  glow: Phaser.GameObjects.Arc;
}

export class FuseScene extends Phaser.Scene {
  static readonly KEY = 'fuse';

  private bridge!: SceneBridge;
  private board?: Board;
  private nodeById = new Map<number, BoardNode>();
  private nodeDots = new Map<number, Phaser.GameObjects.Arc>();
  private nodeLabels = new Map<number, Phaser.GameObjects.Text>();
  private shellStars = new Map<number, Phaser.GameObjects.Star>();
  private edgeLines = new Map<number, Phaser.GameObjects.Line>();
  private placementEnabled = false;
  private placedSockets = new Set<number>();
  private maxShells = 3;

  // playback state
  private playing = false;
  private runEvents: SimEvent[] = [];
  private nextEventIndex = 0;
  private elapsedMs = 0;
  private speed = 1;
  private activeBurns: ActiveBurn[] = [];
  private finished = false;

  constructor() {
    super(FuseScene.KEY);
  }

  create() {
    this.cameras.main.setBackgroundColor('#0b0e1a');
  }

  setBridge(bridge: SceneBridge) {
    this.bridge = bridge;
  }

  private toScreen(node: { x: number; y: number }): { x: number; y: number } {
    if (!this.board) return { x: 0, y: 0 };
    const xs = this.board.nodes.map((n) => n.x);
    const ys = this.board.nodes.map((n) => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const W = this.scale.width;
    const H = this.scale.height;
    const pad = 45;
    return {
      x: pad + ((node.x - minX) / Math.max(0.001, maxX - minX)) * (W - pad * 2),
      y: pad + ((node.y - minY) / Math.max(0.001, maxY - minY)) * (H - pad * 2),
    };
  }

  showBoard(board: Board) {
    this.clearAll();
    this.board = board;
    this.nodeById = new Map(board.nodes.map((n) => [n.id, n]));

    for (const edge of board.edges) {
      const a = this.toScreen(this.nodeById.get(edge.a)!);
      const b = this.toScreen(this.nodeById.get(edge.b)!);
      const line = this.add.line(0, 0, a.x, a.y, b.x, b.y, UNBURNED_EDGE_COLOR).setOrigin(0).setLineWidth(1.5);
      this.edgeLines.set(edge.id, line);
    }

    // Spark-gap jump hints: faint dashed trajectory.
    for (const node of board.nodes) {
      if (node.kind === 'sparkGap' && node.sparkTargetId !== undefined) {
        const from = this.toScreen(node);
        const to = this.toScreen(this.nodeById.get(node.sparkTargetId)!);
        const g = this.add.graphics({ lineStyle: { width: 1, color: 0xd946ef, alpha: 0.25 } });
        const steps = 14;
        for (let i = 0; i < steps; i += 2) {
          g.lineBetween(
            from.x + ((to.x - from.x) * i) / steps,
            from.y + ((to.y - from.y) * i) / steps,
            from.x + ((to.x - from.x) * (i + 1)) / steps,
            from.y + ((to.y - from.y) * (i + 1)) / steps,
          );
        }
      }
    }

    for (const node of board.nodes) {
      const style = KIND_STYLE[node.kind];
      const p = this.toScreen(node);
      const dot = this.add.circle(p.x, p.y, style.radius, style.color);
      if (node.kind === 'socket') {
        dot.setStrokeStyle(2, 0xffffff, 0.9);
        dot.setFillStyle(0x1f2937);
        dot.setInteractive({ useHandCursor: true });
        dot.on('pointerdown', () => this.handleSocketClick(node.id));
      }
      this.nodeDots.set(node.id, dot);
      if (style.label) {
        this.nodeLabels.set(
          node.id,
          this.add.text(p.x, p.y, style.label, { fontSize: '9px', color: '#0b0e1a', fontStyle: 'bold' }).setOrigin(0.5),
        );
      }
    }
  }

  setPlacementEnabled(enabled: boolean, maxShells: number) {
    this.placementEnabled = enabled;
    this.maxShells = maxShells;
  }

  getPlacedSockets(): number[] {
    return [...this.placedSockets].sort((a, b) => a - b);
  }

  private handleSocketClick(socketId: number) {
    if (!this.placementEnabled) return;
    if (this.placedSockets.has(socketId)) {
      this.placedSockets.delete(socketId);
      this.shellStars.get(socketId)?.destroy();
      this.shellStars.delete(socketId);
      this.bridge.onSocketToggled(socketId, false);
      return;
    }
    if (this.placedSockets.size >= this.maxShells) return;
    this.placedSockets.add(socketId);
    const p = this.toScreen(this.nodeById.get(socketId)!);
    const star = this.add.star(p.x, p.y, 5, 4, 9, 0xfbbf24);
    this.shellStars.set(socketId, star);
    this.tweens.add({ targets: star, scale: { from: 0, to: 1 }, duration: 180, ease: 'Back.Out' });
    this.bridge.onSocketToggled(socketId, true);
  }

  setSpeed(speed: number) {
    this.speed = speed;
  }

  playRun(result: RunResult) {
    this.placementEnabled = false;
    this.playing = true;
    this.finished = false;
    this.runEvents = result.events;
    this.nextEventIndex = 0;
    this.elapsedMs = 0;
    this.activeBurns = [];
  }

  update(_time: number, deltaMs: number) {
    if (!this.playing || !this.board) return;
    this.elapsedMs += deltaMs * this.speed;
    const nowTick = this.elapsedMs / TICK_MS;

    while (this.nextEventIndex < this.runEvents.length && this.runEvents[this.nextEventIndex].tick <= nowTick) {
      this.applyEvent(this.runEvents[this.nextEventIndex]);
      this.nextEventIndex++;
    }

    // Crawling spark interpolation — the one non-optional piece of juice.
    for (let i = this.activeBurns.length - 1; i >= 0; i--) {
      const burn = this.activeBurns[i];
      const progress = Math.min(1, (nowTick - burn.startTick) / burn.durationTicks);
      const fromNode = this.nodeById.get(burn.fromNodeId)!;
      const toNode = this.nodeById.get(burn.edge.a === burn.fromNodeId ? burn.edge.b : burn.edge.a)!;
      const a = this.toScreen(fromNode);
      const b = this.toScreen(toNode);
      const x = a.x + (b.x - a.x) * progress;
      const y = a.y + (b.y - a.y) * progress;
      burn.spark.setPosition(x, y);
      burn.glow.setPosition(x, y);
      burn.glow.setScale(0.8 + Math.sin(this.elapsedMs / 40) * 0.25);
      if (progress >= 1) {
        this.edgeLines.get(burn.edge.id)?.setStrokeStyle(2.5, BURNED_EDGE_COLOR, 1);
        burn.spark.destroy();
        burn.glow.destroy();
        this.activeBurns.splice(i, 1);
      }
    }

    if (this.finished && this.activeBurns.length === 0) {
      this.playing = false;
      this.bridge.onRunFinished();
    }
  }

  private applyEvent(e: SimEvent) {
    switch (e.type) {
      case 'IGNITED': {
        const p = this.toScreen(this.nodeById.get(e.nodeId)!);
        this.flashAt(p.x, p.y, 0xff4433, 26);
        break;
      }
      case 'EDGE_BURN_START': {
        const edge = this.board!.edges.find((x) => x.id === e.edgeId)!;
        const spark = this.add.circle(0, 0, 3.5, 0xfff3b0).setDepth(10);
        const glow = this.add.circle(0, 0, 8, 0xffa726, 0.35).setDepth(9);
        this.activeBurns.push({ edge, fromNodeId: e.fromNodeId, startTick: e.tick, durationTicks: e.durationTicks, spark, glow });
        break;
      }
      case 'NODE_ARRIVED': {
        const node = this.nodeById.get(e.nodeId)!;
        const p = this.toScreen(node);
        const dot = this.nodeDots.get(e.nodeId);
        dot?.setFillStyle(KIND_STYLE[node.kind].color);
        this.tweens.add({ targets: dot, scale: { from: 1.7, to: 1 }, duration: 200 });
        this.flashAt(p.x, p.y, 0xffd166, KIND_STYLE[node.kind].radius + 8);
        break;
      }
      case 'MULTIPLIER_CHANGED':
        this.bridge.onHud({ multiplier: e.value });
        break;
      case 'FIZZLE': {
        const p = this.toScreen(this.nodeById.get(e.nodeId)!);
        this.floatText(p.x, p.y, 'fzzz…', '#9ca3af', 13);
        this.flashAt(p.x, p.y, 0x64748b, 16);
        break;
      }
      case 'SPARK_JUMP': {
        const from = this.toScreen(this.nodeById.get(e.fromNodeId)!);
        const to = this.toScreen(this.nodeById.get(e.targetNodeId)!);
        const comet = this.add.circle(from.x, from.y, 4, 0xd946ef).setDepth(11);
        this.tweens.add({
          targets: comet,
          x: to.x,
          y: to.y,
          delay: Math.max(0, ((e.arriveTick - e.tick) * TICK_MS) / this.speed - 350),
          duration: 350 / this.speed,
          ease: 'Quad.In',
          onComplete: () => comet.destroy(),
        });
        break;
      }
      case 'SHELL_PAID': {
        const p = this.toScreen(this.nodeById.get(e.nodeId)!);
        this.burst(p.x, p.y, e.payout);
        this.floatText(p.x, p.y - 14, `+${e.payout}  (x${Math.round(e.multiplier * 10) / 10})`, '#fbbf24', 16);
        if (e.payout >= 150) this.cameras.main.shake(220, 0.012);
        else if (e.payout >= 50) this.cameras.main.shake(120, 0.006);
        this.bridge.onHud({ scoreDelta: e.payout });
        break;
      }
      case 'DECOY_PAID': {
        const p = this.toScreen(this.nodeById.get(e.nodeId)!);
        this.floatText(p.x, p.y - 10, `+${e.value}`, '#22c55e', 12);
        this.flashAt(p.x, p.y, 0x22c55e, 14);
        this.bridge.onHud({ scoreDelta: e.value });
        break;
      }
      case 'CHAIN_DIED':
        break;
      case 'RUN_END': {
        this.bridge.onHud({ score: e.totalScore, multiplier: e.peakMultiplier });
        this.finished = true;
        break;
      }
    }
  }

  private flashAt(x: number, y: number, color: number, radius: number) {
    const flash = this.add.circle(x, y, radius, color, 0.5).setDepth(8);
    this.tweens.add({
      targets: flash,
      scale: 1.8,
      alpha: 0,
      duration: 320,
      onComplete: () => flash.destroy(),
    });
  }

  private burst(x: number, y: number, payout: number) {
    const particleCount = Math.min(26, 8 + Math.floor(payout / 20));
    for (let i = 0; i < particleCount; i++) {
      const angle = (Math.PI * 2 * i) / particleCount;
      const dist = 24 + (payout % 37);
      const particle = this.add.circle(x, y, 2.5, [0xfbbf24, 0xf97316, 0xef4444, 0xd946ef][i % 4]).setDepth(12);
      this.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        alpha: 0,
        duration: 550,
        ease: 'Quad.Out',
        onComplete: () => particle.destroy(),
      });
    }
  }

  private floatText(x: number, y: number, text: string, color: string, size: number) {
    const label = this.add
      .text(x, y, text, { fontSize: `${size}px`, color, fontStyle: 'bold' })
      .setOrigin(0.5)
      .setDepth(13);
    this.tweens.add({ targets: label, y: y - 36, alpha: 0, duration: 1100, onComplete: () => label.destroy() });
  }

  private clearAll() {
    this.playing = false;
    this.finished = false;
    this.activeBurns = [];
    this.placedSockets.clear();
    this.tweens.killAll();
    this.children.removeAll(true);
    this.nodeDots.clear();
    this.nodeLabels.clear();
    this.shellStars.clear();
    this.edgeLines.clear();
  }
}
