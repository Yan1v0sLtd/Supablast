/**
 * Player-facing identity of every node type: placeholder emoji art (real art
 * later), display name, one-line teach text, and glow color. Single source
 * for board icons, placement tooltips, first-encounter callouts and the
 * legend sheet.
 */
import type { NodeKind, SocketRing } from '../sim';

export interface NodeInfo {
  emoji: string;
  name: string;
  blurb: string;
  color: number;
}

export const NODE_INFO: Record<NodeKind, NodeInfo> = {
  ignition: {
    emoji: '🔥',
    name: 'Ignition',
    blurb: 'The show starts here. One match, one chance.',
    color: 0xff4433,
  },
  junction: {
    emoji: '',
    name: 'Junction',
    blurb: 'Passes the flame along. Multiplier +1.',
    color: 0x8a93a8,
  },
  damp: {
    emoji: '💧',
    name: 'Damp Fuse',
    blurb: '35% the flame DIES here. Survive it: +2.',
    color: 0x3b82f6,
  },
  booster: {
    emoji: '🧨',
    name: 'Booster Keg',
    blurb: 'Multiplier ×1.5 and the flame doubles speed!',
    color: 0xf97316,
  },
  sparkGap: {
    emoji: '⚡',
    name: 'Spark Gap',
    blurb: 'The board looks dead… then the spark JUMPS.',
    color: 0xd946ef,
  },
  splitter: {
    emoji: '🔀',
    name: 'Splitter',
    blurb: 'Splits into extra flame fronts. +2.',
    color: 0xeab308,
  },
  decoy: {
    emoji: '🎁',
    name: 'Decoy Shell',
    blurb: 'Small instant payout. Keeps the show alive. +1.',
    color: 0x22c55e,
  },
  socket: {
    emoji: '◎',
    name: 'Shell Socket',
    blurb: 'Place your star shell here. Pays base × multiplier when the flame arrives.',
    color: 0xe5e7eb,
  },
};

export interface RingInfo {
  label: string;
  odds: string;
  color: number;
  cssColor: string;
}

/** Pillar 1 made legible: placement = bet sizing. */
export const RING_INFO: Record<SocketRing, RingInfo> = {
  near: { label: 'SAFE', odds: '~85% · small', color: 0x34d399, cssColor: '#34d399' },
  mid: { label: 'RISKY', odds: '~45% · medium', color: 0xfbbf24, cssColor: '#fbbf24' },
  far: { label: 'ALL-IN', odds: '~20% · HUGE', color: 0xf87171, cssColor: '#f87171' },
};

export const SHELL_EMOJI = '🌟';
