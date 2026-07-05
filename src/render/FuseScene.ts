/**
 * /render — Phaser 3 presentation layer (GDD §9).
 * Consumes the SimEvent stream produced by /sim and interpolates between
 * fixed ticks. Holds ZERO game logic: by the time playback starts, the whole
 * run has already been simulated. Everything here — slow motion, freeze
 * frames, fireworks — bends presentation time only; sim ticks are LAW.
 */
import Phaser from 'phaser';
import { TICK_MS, TUNING, boardDistance, toolsCost } from '../sim';
import type { Board, BoardEdge, BoardNode, RunResult, SimEvent, ToolPlacement } from '../sim';
import { NODE_INFO, RING_INFO, SHELL_EMOJI, TOOL_INFO } from './nodeInfo';

export type ToolMode = 'shell' | 'jumper' | 'keg';

export interface SceneBridge {
  onSocketToggled(socketId: number, placed: boolean): void;
  onToolsChanged(info: { cost: number; jumpers: number; kegs: number }): void;
  onHud(update: { multiplier?: number; score?: number; scoreDelta?: number }): void;
  onRunFinished(): void;
}

const SKY_TOP = 0x060812;
const SKY_BOTTOM = 0x141b33;
const ROPE_COLOR = 0x39415c;
const EMBER_COLOR = 0xffa726;
const SPARK_TINTS = [0xfff3b0, 0xffd166, 0xffb3c1, 0xa5f3fc];
const SEEN_KEY = 'supablast-seen-nodes-v1';

interface ActiveBurn {
  edge: BoardEdge;
  fromNodeId: number;
  targetNodeId: number;
  startTick: number;
  durationTicks: number;
  spark: Phaser.GameObjects.Arc;
  glow: Phaser.GameObjects.Arc;
  tint: number;
}

interface PendingJump {
  fromNodeId: number;
  targetNodeId: number;
  arriveTick: number;
}

export class FuseScene extends Phaser.Scene {
  static readonly KEY = 'fuse';

  private bridge!: SceneBridge;
  private board?: Board;
  private nodeById = new Map<number, BoardNode>();
  private edgeById = new Map<number, BoardEdge>();
  private edgeCurves = new Map<number, Phaser.Curves.QuadraticBezier>();
  private nodeGlows = new Map<number, Phaser.GameObjects.Arc>();
  private nodeIcons = new Map<number, Phaser.GameObjects.Text>();
  private socketRings = new Map<number, Phaser.GameObjects.Graphics>();
  private shellStars = new Map<number, Phaser.GameObjects.Text>();
  private bounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };

  private fuseBaseG!: Phaser.GameObjects.Graphics; // unburned ropes, drawn once
  private burnedG!: Phaser.GameObjects.Graphics; // completed embers, persistent
  private activeG!: Phaser.GameObjects.Graphics; // partial burns, redrawn per frame
  private dimRect?: Phaser.GameObjects.Rectangle;
  private ember!: Phaser.GameObjects.Particles.ParticleEmitter;
  private boom!: Phaser.GameObjects.Particles.ParticleEmitter;
  private smoke!: Phaser.GameObjects.Particles.ParticleEmitter;

  private placementEnabled = false;
  private placedSockets = new Set<number>();
  private maxShells = 3;
  private tooltip?: Phaser.GameObjects.Container;

  // Rig Toolbox state (thin slice: jumper fuses + booster kegs)
  private toolMode: ToolMode = 'shell';
  private placedKegs = new Map<number, Phaser.GameObjects.Text>();
  private placedJumpers: Array<{ a: number; b: number; g: Phaser.GameObjects.Graphics }> = [];
  private jumperFirst?: number;
  private rangeHintG?: Phaser.GameObjects.Graphics;

  // playback state
  private playing = false;
  private runEvents: SimEvent[] = [];
  private nextEventIndex = 0;
  private elapsedMs = 0;
  private speed = 1;
  private activeBurns: ActiveBurn[] = [];
  private pendingJumps: PendingJump[] = [];
  private finished = false;
  private finaleUntil = 0;
  private lastMultiplier = 1;
  private tintCycle = 0;

  // presentation-time dilation (sim ticks are untouched)
  private freezeUntil = 0;
  private freezeCallout?: Phaser.GameObjects.Container;
  private dimmed = false;
  private seenKinds = new Set<string>();
  private reducedMotion = false;

  // scrollable world + camera
  private worldH = 0;
  private dragging = false;
  private dragStartY = 0;
  private dragStartScroll = 0;
  private manualScrollUntil = 0;

  /**
   * UI scale factor: the canvas buffer is created at 540*devicePixelRatio,
   * so every logical pixel value is multiplied by k. This is what keeps
   * text/emoji/strokes sharp on 2x/3x screens.
   */
  private get k(): number {
    return this.scale.width / 540;
  }

  constructor() {
    super(FuseScene.KEY);
  }

  create() {
    this.cameras.main.setBackgroundColor(SKY_TOP);
    this.reducedMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    try {
      this.seenKinds = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'));
    } catch {
      this.seenKinds = new Set();
    }
    // Soft dot texture for every particle in the game (scaled for DPR).
    const dot = Math.max(4, Math.round(4 * this.k));
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1).fillCircle(dot, dot, dot * 0.75);
    g.generateTexture('dot', dot * 2, dot * 2);
    g.destroy();

    // The rig is taller than the screen: swipe to scout it, wheel on desktop.
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.dragging = false;
      this.dragStartY = p.y;
      this.dragStartScroll = this.cameras.main.scrollY;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown || this.worldH === 0) return;
      if (Math.abs(p.y - this.dragStartY) > 10 * this.k) this.dragging = true;
      if (this.dragging) {
        this.setScroll(this.dragStartScroll - (p.y - this.dragStartY));
        this.manualScrollUntil = this.time.now + 2000;
      }
    });
    this.input.on(
      'wheel',
      (_p: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => {
        if (this.worldH === 0) return;
        this.setScroll(this.cameras.main.scrollY + dy * 0.7);
        this.manualScrollUntil = this.time.now + 2000;
      },
    );
  }

  private setScroll(y: number) {
    this.cameras.main.scrollY = Phaser.Math.Clamp(y, 0, Math.max(0, this.worldH - this.scale.height));
  }

  setBridge(bridge: SceneBridge) {
    this.bridge = bridge;
  }

  /** Board grid → world coordinates. The world is ~1.7 screens tall. */
  private toScreen(node: { x: number; y: number }): { x: number; y: number } {
    const { minX, maxX, minY, maxY } = this.bounds;
    const W = this.scale.width;
    const H = this.worldH || this.scale.height;
    const pad = 45 * this.k;
    const padBottom = 115 * this.k; // keep the ignition row clear of the toolbar overlay
    return {
      x: pad + ((node.x - minX) / Math.max(0.001, maxX - minX)) * (W - pad * 2),
      y: pad + ((node.y - minY) / Math.max(0.001, maxY - minY)) * (H - pad - padBottom),
    };
  }

  // ---------------------------------------------------------------- board

  showBoard(board: Board) {
    this.clearAll();
    this.board = board;
    this.nodeById = new Map(board.nodes.map((n) => [n.id, n]));
    this.edgeById = new Map(board.edges.map((e) => [e.id, e]));
    const xs = board.nodes.map((n) => n.x);
    const ys = board.nodes.map((n) => n.y);
    this.bounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
    this.worldH = Math.round(1500 * this.k);
    this.cameras.main.setBounds(0, 0, this.scale.width, this.worldH);
    // Start at the bottom: ignition and the safe sockets; swipe up to scout.
    this.setScroll(this.worldH);

    this.paintSky();

    // Fuses as sagging ropes (hand-strung rig).
    this.fuseBaseG = this.add.graphics().setDepth(2);
    this.burnedG = this.add.graphics().setDepth(3);
    this.activeG = this.add.graphics().setDepth(4);
    this.fuseBaseG.lineStyle(2 * this.k, ROPE_COLOR, 0.85);
    for (const edge of board.edges) {
      const a = this.toScreen(this.nodeById.get(edge.a)!);
      const b = this.toScreen(this.nodeById.get(edge.b)!);
      const len = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
      const mid = new Phaser.Math.Vector2((a.x + b.x) / 2, (a.y + b.y) / 2 + len * 0.12 + 5 * this.k);
      const curve = new Phaser.Curves.QuadraticBezier(
        new Phaser.Math.Vector2(a.x, a.y),
        mid,
        new Phaser.Math.Vector2(b.x, b.y),
      );
      this.edgeCurves.set(edge.id, curve);
      curve.draw(this.fuseBaseG, 20);
    }

    // Spark-gap jump hints: faint dotted arcs.
    const hintG = this.add
      .graphics({ lineStyle: { width: 1 * this.k, color: 0xd946ef, alpha: 0.28 } })
      .setDepth(2);
    for (const node of board.nodes) {
      if (node.kind === 'sparkGap' && node.sparkTargetId !== undefined) {
        const from = this.toScreen(node);
        const to = this.toScreen(this.nodeById.get(node.sparkTargetId)!);
        for (let i = 0; i < 16; i += 2) {
          const t0 = i / 16;
          const t1 = (i + 1) / 16;
          const arc = (t: number) => ({
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 26 * this.k,
          });
          const p0 = arc(t0);
          const p1 = arc(t1);
          hintG.lineBetween(p0.x, p0.y, p1.x, p1.y);
        }
      }
    }

    for (const node of board.nodes) this.buildNode(node);
  }

  private paintSky() {
    const W = this.scale.width;
    const H = this.worldH;
    const k = this.k;
    const sky = this.add.graphics().setDepth(0);
    sky.fillGradientStyle(SKY_TOP, SKY_TOP, SKY_BOTTOM, SKY_BOTTOM, 1);
    sky.fillRect(0, 0, W, H);
    // Stars (render-only randomness — the sim never sees this).
    for (let i = 0; i < 60; i++) {
      const star = this.add
        .circle(Math.random() * W, Math.random() * H * 0.85, (Math.random() * 1.2 + 0.4) * k, 0xdde5ff, 0.7)
        .setDepth(0);
      if (!this.reducedMotion) {
        this.tweens.add({
          targets: star,
          alpha: 0.15,
          duration: 1200 + Math.random() * 2600,
          yoyo: true,
          repeat: -1,
          delay: Math.random() * 2000,
        });
      }
    }
    // Rooftop silhouette along the bottom.
    const roof = this.add.graphics().setDepth(1);
    roof.fillStyle(0x03040a, 1);
    roof.beginPath();
    roof.moveTo(0, H);
    let x = 0;
    let step = 0;
    while (x < W) {
      const w = (40 + Math.random() * 70) * k;
      const h = (12 + Math.random() * 26) * k;
      roof.lineTo(x, H - h - (step % 2) * 8 * k);
      roof.lineTo(Math.min(W, x + w), H - h - (step % 2) * 8 * k);
      x += w;
      step++;
    }
    roof.lineTo(W, H);
    roof.closePath();
    roof.fillPath();
  }

  private buildNode(node: BoardNode) {
    const info = NODE_INFO[node.kind];
    const p = this.toScreen(node);
    const k = this.k;

    if (node.kind === 'socket') {
      const ring = RING_INFO[node.ring ?? 'mid'];
      const rg = this.add.graphics().setDepth(5);
      this.drawSocketRing(rg, p.x, p.y, ring.color, false);
      this.socketRings.set(node.id, rg);
      const label = this.add
        .text(p.x, p.y + 22 * k, ring.odds, { fontSize: `${9 * k}px`, color: ring.cssColor, fontStyle: 'bold' })
        .setOrigin(0.5)
        .setDepth(5);
      this.nodeIcons.set(node.id, label);
    } else {
      const glowRadius = (node.kind === 'junction' ? 4 : node.kind === 'ignition' ? 14 : 11) * k;
      const glow = this.add
        .circle(p.x, p.y, glowRadius, info.color, node.kind === 'junction' ? 0.7 : 0.22)
        .setDepth(5);
      this.nodeGlows.set(node.id, glow);
      if (info.emoji) {
        const icon = this.add
          .text(p.x, p.y, info.emoji, { fontSize: `${(node.kind === 'ignition' ? 22 : 16) * k}px` })
          .setOrigin(0.5)
          .setDepth(6);
        this.nodeIcons.set(node.id, icon);
        if (node.kind === 'ignition' && !this.reducedMotion) {
          this.tweens.add({ targets: icon, scale: 1.18, duration: 700, yoyo: true, repeat: -1 });
        }
      }
    }

    // Every node is tappable; what a tap means depends on the active tool.
    // Taps resolve on pointerUP so swipe-scrolling never triggers them.
    const hit = this.add
      .circle(p.x, p.y, (node.kind === 'socket' ? 22 : 16) * k, 0xffffff, 0.001)
      .setDepth(6);
    hit.setInteractive({ useHandCursor: true });
    hit.on('pointerup', () => {
      if (!this.dragging) this.handleNodeTap(node.id);
    });
  }

  private handleNodeTap(nodeId: number) {
    if (!this.placementEnabled) return;
    const node = this.nodeById.get(nodeId)!;
    switch (this.toolMode) {
      case 'shell':
        if (node.kind === 'socket') this.handleSocketClick(nodeId);
        else if (NODE_INFO[node.kind].emoji) this.showTooltip(node);
        break;
      case 'keg':
        this.handleKegTap(node);
        break;
      case 'jumper':
        this.handleJumperTap(node);
        break;
    }
  }

  private drawSocketRing(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number, filled: boolean) {
    const k = this.k;
    g.clear();
    g.lineStyle(2 * k, color, 0.95);
    const r = 13 * k;
    for (let i = 0; i < 12; i += 2) {
      g.beginPath();
      g.arc(x, y, r, (i / 12) * Math.PI * 2, ((i + 1.3) / 12) * Math.PI * 2);
      g.strokePath();
    }
    if (filled) {
      g.fillStyle(color, 0.14);
      g.fillCircle(x, y, r - 2 * k);
    }
  }

  // ------------------------------------------------------------- placement

  setPlacementEnabled(enabled: boolean, maxShells: number) {
    this.placementEnabled = enabled;
    this.maxShells = maxShells;
  }

  getPlacedSockets(): number[] {
    return [...this.placedSockets].sort((a, b) => a - b);
  }

  private handleSocketClick(socketId: number) {
    if (!this.placementEnabled) return;
    const node = this.nodeById.get(socketId)!;
    const p = this.toScreen(node);
    const ring = RING_INFO[node.ring ?? 'mid'];
    if (this.placedSockets.has(socketId)) {
      this.placedSockets.delete(socketId);
      this.shellStars.get(socketId)?.destroy();
      this.shellStars.delete(socketId);
      this.drawSocketRing(this.socketRings.get(socketId)!, p.x, p.y, ring.color, false);
      this.bridge.onSocketToggled(socketId, false);
      return;
    }
    if (this.placedSockets.size >= this.maxShells) {
      this.showTooltip(node);
      return;
    }
    this.placedSockets.add(socketId);
    const star = this.add
      .text(p.x, p.y, SHELL_EMOJI, { fontSize: `${18 * this.k}px` })
      .setOrigin(0.5)
      .setDepth(7);
    this.shellStars.set(socketId, star);
    this.drawSocketRing(this.socketRings.get(socketId)!, p.x, p.y, ring.color, true);
    this.tweens.add({ targets: star, scale: { from: 0, to: 1 }, duration: 220, ease: 'Back.Out' });
    this.sparkleAt(p.x, p.y, ring.color, 8);
    this.bridge.onSocketToggled(socketId, true);
  }

  // ------------------------------------------------------------- toolbox

  setToolMode(mode: ToolMode) {
    this.toolMode = mode;
    this.jumperFirst = undefined;
    this.rangeHintG?.destroy();
    this.rangeHintG = undefined;
    this.tooltip?.destroy();
    this.tooltip = undefined;
  }

  getTools(): ToolPlacement[] {
    const jumpers: ToolPlacement[] = this.placedJumpers
      .map((j) => ({ type: 'jumper' as const, a: Math.min(j.a, j.b), b: Math.max(j.a, j.b) }))
      .sort((x, y) => x.a - y.a || x.b - y.b);
    const kegs: ToolPlacement[] = [...this.placedKegs.keys()]
      .sort((a, b) => a - b)
      .map((nodeId) => ({ type: 'keg' as const, nodeId }));
    return [...jumpers, ...kegs];
  }

  private remainingBudget(): number {
    return TUNING.tools.budget - toolsCost(this.getTools());
  }

  private notifyTools() {
    this.bridge.onToolsChanged({
      cost: toolsCost(this.getTools()),
      jumpers: this.placedJumpers.length,
      kegs: this.placedKegs.size,
    });
  }

  private handleKegTap(node: BoardNode) {
    const p = this.toScreen(node);
    const existing = this.placedKegs.get(node.id);
    if (existing) {
      existing.destroy();
      this.placedKegs.delete(node.id);
      this.notifyTools();
      return;
    }
    if (node.kind !== 'junction') {
      this.showTooltip(node);
      return;
    }
    if (this.remainingBudget() < TUNING.tools.kegCost) {
      this.floatText(p.x, p.y - 14 * this.k, 'No rig points left!', '#f87171', 12);
      return;
    }
    const keg = this.add
      .text(p.x, p.y, TOOL_INFO.keg.emoji, { fontSize: `${16 * this.k}px` })
      .setOrigin(0.5)
      .setDepth(7);
    this.placedKegs.set(node.id, keg);
    this.tweens.add({ targets: keg, scale: { from: 0, to: 1 }, duration: 200, ease: 'Back.Out' });
    this.sparkleAt(p.x, p.y, TOOL_INFO.keg.color, 8);
    this.notifyTools();
  }

  private handleJumperTap(node: BoardNode) {
    const p = this.toScreen(node);
    // Tapping an endpoint of an existing jumper removes it.
    const hitIndex = this.placedJumpers.findIndex((j) => j.a === node.id || j.b === node.id);
    if (this.jumperFirst === undefined && hitIndex >= 0) {
      this.placedJumpers[hitIndex].g.destroy();
      this.placedJumpers.splice(hitIndex, 1);
      this.notifyTools();
      return;
    }
    if (this.jumperFirst === undefined) {
      if (this.remainingBudget() < TUNING.tools.jumperCost) {
        this.floatText(p.x, p.y - 14 * this.k, 'No rig points left!', '#f87171', 12);
        return;
      }
      this.jumperFirst = node.id;
      this.drawJumperRangeHints(node);
      return;
    }
    if (this.jumperFirst === node.id) {
      this.jumperFirst = undefined;
      this.rangeHintG?.destroy();
      this.rangeHintG = undefined;
      return;
    }
    const a = this.jumperFirst;
    const b = node.id;
    this.jumperFirst = undefined;
    this.rangeHintG?.destroy();
    this.rangeHintG = undefined;
    if (!this.isLegalJumper(a, b)) {
      this.floatText(p.x, p.y - 14 * this.k, 'Too far / already strung', '#f87171', 12);
      return;
    }
    const g = this.add.graphics().setDepth(3);
    this.drawRope(g, a, b, TOOL_INFO.jumper.color, 0.95);
    this.placedJumpers.push({ a, b, g });
    this.sparkleAt(p.x, p.y, TOOL_INFO.jumper.color, 8);
    this.notifyTools();
  }

  private isLegalJumper(a: number, b: number): boolean {
    if (!this.board) return false;
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    const taken =
      this.board.edges.some((e) => `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}` === key) ||
      this.placedJumpers.some((j) => `${Math.min(j.a, j.b)}-${Math.max(j.a, j.b)}` === key);
    return !taken && boardDistance(this.board, a, b) <= TUNING.tools.jumperMaxDistance;
  }

  /** While choosing a jumper's far end: show reach + highlight legal partners. */
  private drawJumperRangeHints(from: BoardNode) {
    this.rangeHintG?.destroy();
    const g = this.add.graphics().setDepth(7);
    this.rangeHintG = g;
    const p = this.toScreen(from);
    const pxPerUnit = (this.scale.width - 90 * this.k) / Math.max(0.001, this.bounds.maxX - this.bounds.minX);
    g.lineStyle(1.5 * this.k, TOOL_INFO.jumper.color, 0.45);
    g.strokeCircle(p.x, p.y, TUNING.tools.jumperMaxDistance * pxPerUnit);
    g.fillStyle(TOOL_INFO.jumper.color, 0.9);
    for (const other of this.board!.nodes) {
      if (other.id !== from.id && this.isLegalJumper(from.id, other.id)) {
        const q = this.toScreen(other);
        g.fillCircle(q.x, q.y, 3.5 * this.k);
      }
    }
  }

  /** Sagging rope between two nodes — same silhouette as generated fuses. */
  private drawRope(g: Phaser.GameObjects.Graphics, a: number, b: number, color: number, alpha: number) {
    const pa = this.toScreen(this.nodeById.get(a)!);
    const pb = this.toScreen(this.nodeById.get(b)!);
    const len = Phaser.Math.Distance.Between(pa.x, pa.y, pb.x, pb.y);
    const mid = new Phaser.Math.Vector2((pa.x + pb.x) / 2, (pa.y + pb.y) / 2 + len * 0.12 + 5 * this.k);
    const curve = new Phaser.Curves.QuadraticBezier(
      new Phaser.Math.Vector2(pa.x, pa.y),
      mid,
      new Phaser.Math.Vector2(pb.x, pb.y),
    );
    g.lineStyle(2 * this.k, color, alpha);
    curve.draw(g, 20);
  }

  private showTooltip(node: BoardNode) {
    if (!this.placementEnabled) return;
    this.tooltip?.destroy();
    const info = NODE_INFO[node.kind];
    const p = this.toScreen(node);
    const title =
      node.kind === 'socket' && node.ring
        ? `${info.emoji} ${info.name} — ${RING_INFO[node.ring].label}`
        : `${info.emoji} ${info.name}`;
    const blurb =
      node.kind === 'socket' && node.ring ? `${RING_INFO[node.ring].odds} payout\n${info.blurb}` : info.blurb;
    this.tooltip = this.buildCallout(p.x, p.y - 34 * this.k, title, blurb);
    const tip = this.tooltip;
    this.time.delayedCall(2600, () => {
      if (this.tooltip === tip) {
        tip.destroy();
        this.tooltip = undefined;
      }
    });
  }

  private buildCallout(x: number, y: number, title: string, blurb: string): Phaser.GameObjects.Container {
    const k = this.k;
    const titleText = this.add.text(0, 0, title, { fontSize: `${13 * k}px`, color: '#ffe9a8', fontStyle: 'bold' });
    const blurbText = this.add.text(0, 18 * k, blurb, {
      fontSize: `${11 * k}px`,
      color: '#d7dcea',
      wordWrap: { width: 190 * k },
      lineSpacing: 3 * k,
    });
    const w = Math.max(titleText.width, blurbText.width) + 20 * k;
    const h = blurbText.y + blurbText.height + 12 * k;
    const bg = this.add.graphics();
    bg.fillStyle(0x10162a, 0.96);
    bg.lineStyle(1 * k, 0x3d4a73, 1);
    bg.fillRoundedRect(-10 * k, -8 * k, w, h, 7 * k);
    bg.strokeRoundedRect(-10 * k, -8 * k, w, h, 7 * k);
    const container = this.add.container(0, 0, [bg, titleText, blurbText]).setDepth(30);
    // Clamp within the camera's current view, not the (taller) world.
    const view = this.cameras.main.worldView;
    const cx = Phaser.Math.Clamp(x - w / 2, view.x + 8 * k, view.right - w - 8 * k);
    const cy = Phaser.Math.Clamp(y - h, view.y + 8 * k, view.bottom - h - 8 * k);
    container.setPosition(cx + 10 * k, cy + 8 * k);
    container.setAlpha(0);
    this.tweens.add({ targets: container, alpha: 1, duration: 140 });
    return container;
  }

  // -------------------------------------------------------------- playback

  setSpeed(speed: number) {
    this.speed = speed;
  }

  /**
   * Start playback. `riggedBoard` is the board the sim actually burned —
   * base board + applied tools — so jumper edges and keg conversions get
   * curves, FX and correct node identities during the ride.
   */
  playRun(result: RunResult, riggedBoard?: Board) {
    this.placementEnabled = false;
    this.tooltip?.destroy();
    this.tooltip = undefined;
    this.jumperFirst = undefined;
    this.rangeHintG?.destroy();
    this.rangeHintG = undefined;
    if (riggedBoard) {
      this.board = riggedBoard;
      this.nodeById = new Map(riggedBoard.nodes.map((n) => [n.id, n]));
      this.edgeById = new Map(riggedBoard.edges.map((e) => [e.id, e]));
      for (const edge of riggedBoard.edges) {
        if (this.edgeCurves.has(edge.id)) continue;
        const a = this.toScreen(this.nodeById.get(edge.a)!);
        const b = this.toScreen(this.nodeById.get(edge.b)!);
        const len = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
        const mid = new Phaser.Math.Vector2((a.x + b.x) / 2, (a.y + b.y) / 2 + len * 0.12 + 5 * this.k);
        this.edgeCurves.set(
          edge.id,
          new Phaser.Curves.QuadraticBezier(
            new Phaser.Math.Vector2(a.x, a.y),
            mid,
            new Phaser.Math.Vector2(b.x, b.y),
          ),
        );
      }
    }
    this.playing = true;
    this.finished = false;
    this.runEvents = result.events;
    this.nextEventIndex = 0;
    this.elapsedMs = 0;
    this.activeBurns = [];
    this.pendingJumps = [];
    this.finaleUntil = 0;
    this.lastMultiplier = 1;
    this.ensureEmitters();
  }

  private ensureEmitters() {
    const k = this.k;
    this.ember?.destroy();
    this.boom?.destroy();
    this.smoke?.destroy();
    this.ember = this.add
      .particles(0, 0, 'dot', {
        speed: { min: 6 * k, max: 30 * k },
        angle: { min: 60, max: 120 },
        scale: { start: 0.7, end: 0 },
        lifespan: { min: 260, max: 520 },
        quantity: 1,
        tint: [0xffa726, 0xffd166, 0xff7043],
        emitting: false,
        blendMode: Phaser.BlendModes.ADD,
      })
      .setDepth(8);
    this.boom = this.add
      .particles(0, 0, 'dot', {
        speed: { min: 60 * k, max: 260 * k },
        scale: { start: 1.1, end: 0 },
        lifespan: { min: 450, max: 950 },
        gravityY: 130 * k,
        tint: [0xfbbf24, 0xf97316, 0xef4444, 0xd946ef, 0xa5f3fc],
        emitting: false,
        blendMode: Phaser.BlendModes.ADD,
      })
      .setDepth(12);
    this.smoke = this.add
      .particles(0, 0, 'dot', {
        speed: { min: 4 * k, max: 18 * k },
        angle: { min: 250, max: 290 },
        scale: { start: 1.3, end: 2.2 },
        alpha: { start: 0.35, end: 0 },
        lifespan: { min: 700, max: 1300 },
        tint: [0x64748b, 0x475569],
        emitting: false,
      })
      .setDepth(8);
  }

  /** Presentation-time dilation: freeze-frames and damp-approach slow-mo. */
  private currentDilation(nowReal: number): number {
    if (this.reducedMotion) return 1;
    let d = 1;
    if (nowReal < this.freezeUntil) d = Math.min(d, 0.1);
    // Only the last stretch before a damp gate slows time — long enough to
    // sweat, short enough that a 12-damp board doesn't drag the whole ride.
    for (const burn of this.activeBurns) {
      const target = this.nodeById.get(burn.targetNodeId);
      if (target?.kind === 'damp') {
        const progress = (this.elapsedMs / TICK_MS - burn.startTick) / burn.durationTicks;
        if (progress > 0.75) d = Math.min(d, 0.35);
      }
    }
    return d;
  }

  update(_time: number, deltaMs: number) {
    if (!this.playing || !this.board) return;
    const nowReal = this.time.now;
    const dilation = this.currentDilation(nowReal);
    this.elapsedMs += deltaMs * this.speed * dilation;
    const nowTick = this.elapsedMs / TICK_MS;

    while (this.nextEventIndex < this.runEvents.length && this.runEvents[this.nextEventIndex].tick <= nowTick) {
      this.applyEvent(this.runEvents[this.nextEventIndex]);
      this.nextEventIndex++;
    }

    // Crawling sparks along sagging fuses — the one non-optional juice.
    this.activeG.clear();
    for (let i = this.activeBurns.length - 1; i >= 0; i--) {
      const burn = this.activeBurns[i];
      const progress = Math.min(1, (nowTick - burn.startTick) / burn.durationTicks);
      const curve = this.edgeCurves.get(burn.edge.id)!;
      const reversed = burn.edge.b === burn.fromNodeId;
      const t = reversed ? 1 - progress : progress;
      const pos = curve.getPoint(t);
      burn.spark.setPosition(pos.x, pos.y);
      burn.glow.setPosition(pos.x, pos.y);
      burn.glow.setScale(0.85 + Math.sin(nowReal / 38) * 0.3);
      if (Math.random() < 0.55) this.ember.emitParticleAt(pos.x, pos.y);

      // Ember trail: burned portion of the rope.
      this.activeG.lineStyle(2.5 * this.k, EMBER_COLOR, 0.95);
      const from = reversed ? t : 0;
      const to = reversed ? 1 : t;
      const pts = curve.getPoints(20).filter((_, idx) => idx / 20 >= from && idx / 20 <= to);
      for (let k = 0; k + 1 < pts.length; k++) {
        this.activeG.lineBetween(pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y);
      }

      if (progress >= 1) {
        this.burnedG.lineStyle(2.5 * this.k, EMBER_COLOR, 0.8);
        curve.draw(this.burnedG, 20);
        burn.spark.destroy();
        burn.glow.destroy();
        this.activeBurns.splice(i, 1);
      }
    }

    // Camera rides with the flame front (manual swipes win for 2s).
    if (nowReal > this.manualScrollUntil && !this.reducedMotion) {
      let targetY: number | undefined;
      if (this.activeBurns.length > 0) {
        let sum = 0;
        for (const burn of this.activeBurns) sum += burn.spark.y;
        targetY = sum / this.activeBurns.length;
      } else if (this.pendingJumps.length > 0) {
        const gap = this.nodeById.get(this.pendingJumps[0].fromNodeId);
        if (gap) targetY = this.toScreen(gap).y;
      }
      if (targetY !== undefined) {
        const desired = Phaser.Math.Clamp(
          targetY - this.scale.height * 0.55,
          0,
          Math.max(0, this.worldH - this.scale.height),
        );
        this.cameras.main.scrollY += (desired - this.cameras.main.scrollY) * 0.06;
      }
    }

    // Fake-finale staging: nothing burning, but a jump is pending → dim the
    // world and let the spark gap pulse alone in the dark.
    this.pendingJumps = this.pendingJumps.filter((j) => j.arriveTick > nowTick - 2);
    const shouldDim = this.activeBurns.length === 0 && this.pendingJumps.length > 0 && !this.finished;
    if (shouldDim && !this.dimmed) this.setDim(true);
    if (!shouldDim && this.dimmed) this.setDim(false);

    if (this.finished && this.activeBurns.length === 0 && nowReal >= this.finaleUntil) {
      this.playing = false;
      this.setDim(false);
      this.bridge.onRunFinished();
    }
  }

  private setDim(on: boolean) {
    this.dimmed = on;
    if (!this.dimRect) {
      // Screen-space overlay: covers the viewport wherever the camera is.
      this.dimRect = this.add
        .rectangle(this.scale.width / 2, this.scale.height / 2, this.scale.width, this.scale.height, 0x02030a, 0)
        .setScrollFactor(0)
        .setDepth(9);
    }
    this.tweens.add({ targets: this.dimRect, fillAlpha: on ? 0.5 : 0, duration: on ? 600 : 250 });
    if (on) {
      for (const j of this.pendingJumps) {
        const gapIcon = this.nodeIcons.get(j.fromNodeId);
        if (gapIcon && !this.reducedMotion) {
          this.tweens.add({ targets: gapIcon, scale: 1.6, duration: 300, yoyo: true, repeat: 3 });
        }
      }
    }
  }

  // ------------------------------------------------------------ event FX

  private applyEvent(e: SimEvent) {
    switch (e.type) {
      case 'IGNITED': {
        const p = this.toScreen(this.nodeById.get(e.nodeId)!);
        this.flashAt(p.x, p.y, 0xff4433, 30);
        this.boom.emitParticleAt(p.x, p.y, 10);
        this.shake(150, 0.004);
        break;
      }
      case 'EDGE_BURN_START': {
        const edge = this.edgeById.get(e.edgeId)!;
        const target = edge.a === e.fromNodeId ? edge.b : edge.a;
        const tint = SPARK_TINTS[this.tintCycle++ % SPARK_TINTS.length];
        const spark = this.add.circle(0, 0, 3.5 * this.k, tint).setDepth(10);
        const glow = this.add.circle(0, 0, 9 * this.k, EMBER_COLOR, 0.35).setDepth(9);
        this.activeBurns.push({
          edge,
          fromNodeId: e.fromNodeId,
          targetNodeId: target,
          startTick: e.tick,
          durationTicks: e.durationTicks,
          spark,
          glow,
          tint,
        });
        break;
      }
      case 'NODE_ARRIVED': {
        const node = this.nodeById.get(e.nodeId)!;
        const p = this.toScreen(node);
        const glow = this.nodeGlows.get(e.nodeId);
        if (glow) {
          glow.setAlpha(0.85);
          this.tweens.add({ targets: glow, scale: { from: 1.8, to: 1 }, duration: 240 });
        }
        this.flashAt(p.x, p.y, 0xffd166, 16);
        this.maybeTeach(node, p);
        switch (node.kind) {
          case 'damp': {
            const next = this.runEvents[this.nextEventIndex + 1];
            const dies = next?.type === 'FIZZLE' && next.nodeId === e.nodeId;
            if (!dies) {
              this.flashAt(p.x, p.y, 0xffffff, 34);
              this.floatText(p.x, p.y - 16 * this.k, 'SURVIVED! +2', '#7dd3fc', 15);
              this.shake(140, 0.006);
            }
            break;
          }
          case 'booster':
            this.floatText(p.x, p.y - 16 * this.k, '×1.5 FASTER!', '#fdba74', 15);
            this.boom.emitParticleAt(p.x, p.y, 14);
            this.shake(160, 0.007);
            break;
          case 'splitter':
            this.floatText(p.x, p.y - 16 * this.k, 'SPLIT! +2', '#fde047', 14);
            this.sparkleAt(p.x, p.y, 0xeab308, 12);
            break;
          case 'sparkGap':
            this.floatText(p.x, p.y - 16 * this.k, '+3', '#f0abfc', 13);
            break;
          default:
            break;
        }
        break;
      }
      case 'MULTIPLIER_CHANGED': {
        this.bridge.onHud({ multiplier: e.value });
        for (const threshold of [10, 25, 50, 100]) {
          if (this.lastMultiplier < threshold && e.value >= threshold) this.celebrateThreshold(threshold);
        }
        this.lastMultiplier = e.value;
        break;
      }
      case 'FIZZLE': {
        const p = this.toScreen(this.nodeById.get(e.nodeId)!);
        this.smoke.emitParticleAt(p.x, p.y, 9);
        this.floatText(p.x, p.y - 14 * this.k, 'fzzz…', '#94a3b8', 14);
        const icon = this.nodeIcons.get(e.nodeId);
        if (icon) this.tweens.add({ targets: icon, alpha: 0.35, duration: 500 });
        break;
      }
      case 'SPARK_JUMP': {
        this.pendingJumps.push({ fromNodeId: e.fromNodeId, targetNodeId: e.targetNodeId, arriveTick: e.arriveTick });
        const from = this.toScreen(this.nodeById.get(e.fromNodeId)!);
        const to = this.toScreen(this.nodeById.get(e.targetNodeId)!);
        const comet = this.add.circle(from.x, from.y, 4.5 * this.k, 0xf0abfc).setDepth(14);
        comet.setVisible(false);
        const flightMs = 420 / this.speed;
        const waitMs = Math.max(0, ((e.arriveTick - e.tick) * TICK_MS) / this.speed - flightMs);
        this.time.delayedCall(waitMs, () => {
          comet.setVisible(true);
          const curve = new Phaser.Curves.QuadraticBezier(
            new Phaser.Math.Vector2(from.x, from.y),
            new Phaser.Math.Vector2((from.x + to.x) / 2, Math.min(from.y, to.y) - 60 * this.k),
            new Phaser.Math.Vector2(to.x, to.y),
          );
          const holder = { t: 0 };
          this.tweens.add({
            targets: holder,
            t: 1,
            duration: flightMs,
            ease: 'Sine.InOut',
            onUpdate: () => {
              const pos = curve.getPoint(holder.t);
              comet.setPosition(pos.x, pos.y);
              this.ember.emitParticleAt(pos.x, pos.y, 2);
            },
            onComplete: () => {
              this.boom.emitParticleAt(to.x, to.y, 18);
              this.flashAt(to.x, to.y, 0xf0abfc, 30);
              this.shake(200, 0.008);
              comet.destroy();
            },
          });
        });
        break;
      }
      case 'SHELL_PAID': {
        const p = this.toScreen(this.nodeById.get(e.nodeId)!);
        this.shellStars.get(e.nodeId)?.destroy();
        this.launchFirework(p.x, p.y, e.payout, e.multiplier);
        this.bridge.onHud({ scoreDelta: e.payout });
        break;
      }
      case 'DECOY_PAID': {
        const p = this.toScreen(this.nodeById.get(e.nodeId)!);
        this.floatText(p.x, p.y - 12 * this.k, `+${e.value}`, '#4ade80', 13);
        this.sparkleAt(p.x, p.y, 0x22c55e, 7);
        this.bridge.onHud({ scoreDelta: e.value });
        break;
      }
      case 'CHAIN_DIED':
        break;
      case 'RUN_END': {
        this.bridge.onHud({ score: e.totalScore, multiplier: e.peakMultiplier });
        this.finished = true;
        if (e.totalScore > 0) this.finaleVolley(e.totalScore);
        break;
      }
    }
  }

  /** First-ever encounter of a node type: freeze the world and explain it. */
  private maybeTeach(node: BoardNode, p: { x: number; y: number }) {
    const teachable = ['damp', 'booster', 'sparkGap', 'splitter', 'decoy'];
    if (!teachable.includes(node.kind) || this.seenKinds.has(node.kind)) return;
    this.seenKinds.add(node.kind);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...this.seenKinds]));
    } catch {
      /* private mode */
    }
    if (this.reducedMotion) return;
    const info = NODE_INFO[node.kind];
    this.freezeUntil = this.time.now + 1400;
    this.freezeCallout?.destroy();
    this.freezeCallout = this.buildCallout(p.x, p.y - 40 * this.k, `${info.emoji} ${info.name.toUpperCase()}`, info.blurb);
    const icon = this.nodeIcons.get(node.id);
    if (icon) this.tweens.add({ targets: icon, scale: { from: 2.1, to: 1 }, duration: 1300, ease: 'Cubic.Out' });
    this.cameras.main.zoomTo(1.05, 250, 'Sine.easeOut', true);
    const callout = this.freezeCallout;
    this.time.delayedCall(1500, () => {
      this.cameras.main.zoomTo(1, 300, 'Sine.easeOut', true);
      callout?.destroy();
      if (this.freezeCallout === callout) this.freezeCallout = undefined;
    });
  }

  /** Shell payout = an actual firework: rocket up, burst, payout in lights. */
  private launchFirework(x: number, y: number, payout: number, multiplier: number) {
    const k = this.k;
    const viewTop = this.cameras.main.worldView.y;
    const apexY = Math.max(viewTop + 70 * k, y - (120 + Math.min(140, payout / 4)) * k);
    const rocket = this.add.circle(x, y, 3 * k, 0xfff3b0).setDepth(14);
    this.tweens.add({
      targets: rocket,
      y: apexY,
      duration: 430,
      ease: 'Cubic.Out',
      onUpdate: () => this.ember.emitParticleAt(rocket.x, rocket.y, 1),
      onComplete: () => {
        rocket.destroy();
        const count = Math.min(70, 22 + Math.floor(payout / 8));
        this.boom.emitParticleAt(x, apexY, count);
        const ringFx = this.add
          .circle(x, apexY, 6 * k, 0xffffff, 0)
          .setStrokeStyle(2 * k, 0xffe9a8, 1)
          .setDepth(13);
        this.tweens.add({
          targets: ringFx,
          radius: (44 + Math.min(50, payout / 8)) * k,
          alpha: 0,
          duration: 620,
          onComplete: () => ringFx.destroy(),
        });
        const size = payout >= 300 ? 26 : payout >= 100 ? 21 : 17;
        this.floatText(x, apexY, `+${payout}`, '#ffe9a8', size, 1400);
        this.floatText(x, apexY + 20 * k, `x${Math.round(multiplier * 10) / 10}`, '#fdba74', 12, 1400);
        this.shake(payout >= 300 ? 340 : 220, Math.min(0.022, 0.006 + payout / 30000));
        if (payout >= 300) {
          this.time.delayedCall(160, () => this.boom.emitParticleAt(x + 26 * k, apexY - 18 * k, 24));
          this.time.delayedCall(320, () => this.boom.emitParticleAt(x - 30 * k, apexY + 10 * k, 24));
        }
      },
    });
  }

  private celebrateThreshold(threshold: number) {
    const label = this.add
      .text(this.scale.width / 2, this.scale.height * 0.3, `x${threshold}!`, {
        fontSize: `${46 * this.k}px`,
        color: threshold >= 50 ? '#f87171' : threshold >= 25 ? '#fb923c' : '#fbbf24',
        fontStyle: 'bold',
        stroke: '#0b0e1a',
        strokeThickness: 6 * this.k,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(30)
      .setScale(0.2)
      .setAlpha(0);
    this.tweens.add({
      targets: label,
      scale: 1,
      alpha: 1,
      duration: 240,
      ease: 'Back.Out',
      onComplete: () => {
        this.tweens.add({
          targets: label,
          alpha: 0,
          y: label.y - 26 * this.k,
          delay: 420,
          duration: 380,
          onComplete: () => label.destroy(),
        });
      },
    });
    this.shake(190, 0.007);
  }

  private finaleVolley(totalScore: number) {
    const k = this.k;
    const bursts = Phaser.Math.Clamp(1 + Math.floor(totalScore / 140), 1, 6);
    for (let i = 0; i < bursts; i++) {
      this.time.delayedCall(i * 170, () => {
        // Burst inside the camera's current view, wherever it has scrolled.
        const view = this.cameras.main.worldView;
        const x = 60 * k + Math.random() * (this.scale.width - 120 * k);
        const y = view.y + 60 * k + Math.random() * 160 * k;
        this.boom.emitParticleAt(x, y, 30);
        this.flashAt(x, y, 0xffe9a8, 26);
      });
    }
    this.shake(320, Math.min(0.02, 0.006 + totalScore / 40000));
    this.finaleUntil = this.time.now + bursts * 170 + 700;
  }

  // ------------------------------------------------------------- helpers

  private shake(duration: number, intensity: number) {
    if (this.reducedMotion) return;
    this.cameras.main.shake(duration, intensity);
  }

  private flashAt(x: number, y: number, color: number, radius: number) {
    const flash = this.add.circle(x, y, radius * this.k, color, 0.5).setDepth(11);
    this.tweens.add({ targets: flash, scale: 1.9, alpha: 0, duration: 340, onComplete: () => flash.destroy() });
  }

  private sparkleAt(x: number, y: number, color: number, count: number) {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const distPx = (14 + Math.random() * 16) * this.k;
      const s = this.add.circle(x, y, 2 * this.k, color).setDepth(12);
      this.tweens.add({
        targets: s,
        x: x + Math.cos(angle) * distPx,
        y: y + Math.sin(angle) * distPx,
        alpha: 0,
        duration: 420,
        ease: 'Quad.Out',
        onComplete: () => s.destroy(),
      });
    }
  }

  private floatText(x: number, y: number, text: string, color: string, size: number, duration = 1100) {
    const k = this.k;
    const label = this.add
      .text(x, y, text, {
        fontSize: `${size * k}px`,
        color,
        fontStyle: 'bold',
        stroke: '#0b0e1a',
        strokeThickness: 4 * k,
      })
      .setOrigin(0.5)
      .setDepth(20);
    this.tweens.add({
      targets: label,
      y: y - 40 * k,
      alpha: 0,
      duration,
      ease: 'Quad.Out',
      onComplete: () => label.destroy(),
    });
  }

  private clearAll() {
    this.playing = false;
    this.finished = false;
    this.activeBurns = [];
    this.pendingJumps = [];
    this.placedSockets.clear();
    this.dimmed = false;
    this.freezeUntil = 0;
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.cameras.main.setZoom(1);
    this.children.removeAll(true);
    this.nodeGlows.clear();
    this.nodeIcons.clear();
    this.socketRings.clear();
    this.shellStars.clear();
    this.edgeCurves.clear();
    this.placedKegs.clear();
    this.placedJumpers = [];
    this.jumperFirst = undefined;
    this.rangeHintG = undefined;
    this.toolMode = 'shell';
    this.dimRect = undefined;
    this.tooltip = undefined;
    this.freezeCallout = undefined;
  }
}
