/**
 * /app — React shell (GDD §9): menus, placement UI overlay, run HUD,
 * Rig Toolbox palette. The Supabase client (seed issuance, verification,
 * leaderboards) arrives post-prototype; v0 fakes the daily tournament via
 * the seed input field.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  applyTools,
  canonicalOutcomes,
  generateBoard,
  simulate,
  TUNING,
  validateTools,
  type Board,
  type NodeKind,
  type RunResult,
  type SocketRing,
} from '../sim';
import { NODE_INFO, RING_INFO, TOOL_INFO } from '../render/nodeInfo';
import type { ToolMode } from '../render/FuseScene';
import { usePhaserGame } from './usePhaserGame';

type Phase = 'setup' | 'placing' | 'riding' | 'summary';

function randomSeed(): string {
  // Non-gameplay randomness only: picking a fresh seed for the next run.
  return `show-${Math.random().toString(36).slice(2, 8)}`;
}

function multTier(value: number): number {
  if (value >= 50) return 3;
  if (value >= 25) return 2;
  if (value >= 10) return 1;
  return 0;
}

const LEGEND_KINDS: NodeKind[] = ['damp', 'booster', 'sparkGap', 'splitter', 'decoy', 'socket'];
const LEGEND_RINGS: SocketRing[] = ['near', 'mid', 'far'];

export function App() {
  const [seedInput, setSeedInput] = useState(randomSeed);
  const [board, setBoard] = useState<Board>();
  const [phase, setPhase] = useState<Phase>('setup');
  const [placed, setPlaced] = useState<number[]>([]);
  const [hud, setHud] = useState({ multiplier: 1, score: 0 });
  const [speed, setSpeed] = useState(1);
  const [result, setResult] = useState<RunResult>();
  const [showLegend, setShowLegend] = useState(false);
  const [toolMode, setToolMode] = useState<ToolMode>('shell');
  const [rig, setRig] = useState({ cost: 0, jumpers: 0, kegs: 0 });

  const bridge = useMemo(
    () => ({
      onSocketToggled: () => {
        setPlaced(sceneRef.current?.getPlacedSockets() ?? []);
      },
      onToolsChanged: (info: { cost: number; jumpers: number; kegs: number }) => {
        setRig(info);
      },
      onHud: (update: { multiplier?: number; score?: number; scoreDelta?: number }) => {
        setHud((h) => ({
          multiplier: update.multiplier ?? h.multiplier,
          score: update.score ?? h.score + (update.scoreDelta ?? 0),
        }));
      },
      onRunFinished: () => {
        setPhase((p) => (p === 'riding' ? 'summary' : p));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { containerRef, sceneRef } = usePhaserGame(bridge);

  const startBoard = useCallback(
    (seed: string) => {
      const newBoard = generateBoard(seed);
      setBoard(newBoard);
      setPlaced([]);
      setResult(undefined);
      setHud({ multiplier: 1, score: 0 });
      setRig({ cost: 0, jumpers: 0, kegs: 0 });
      setToolMode('shell');
      setPhase('placing');
      const scene = sceneRef.current;
      if (scene) {
        scene.showBoard(newBoard);
        scene.setPlacementEnabled(true, TUNING.run.shellsPerRun);
        scene.setToolMode('shell');
      }
    },
    [sceneRef],
  );

  const selectTool = useCallback(
    (mode: ToolMode) => {
      setToolMode(mode);
      sceneRef.current?.setToolMode(mode);
    },
    [sceneRef],
  );

  const ignite = useCallback(() => {
    const scene = sceneRef.current;
    if (!board || !scene) return;
    const placements = scene
      .getPlacedSockets()
      .map((socketId) => ({ socketId, baseValue: TUNING.run.shellBaseValue }));
    if (placements.length !== TUNING.run.shellsPerRun) return;
    const tools = scene.getTools();
    if (!validateTools(board, tools).ok) return; // UI enforces this; belt & braces
    const rigged = applyTools(board, tools);
    const runResult = simulate(rigged, canonicalOutcomes(rigged), placements);
    setResult(runResult);
    setHud({ multiplier: 1, score: 0 });
    setPhase('riding');
    scene.playRun(runResult, rigged);
  }, [board, sceneRef]);

  const toggleSpeed = useCallback(() => {
    setSpeed((s) => {
      const next = s === 1 ? 2 : 1;
      sceneRef.current?.setSpeed(next);
      return next;
    });
  }, [sceneRef]);

  const shellsLeft = TUNING.run.shellsPerRun - placed.length;
  const tier = multTier(hud.multiplier);
  const budgetLeft = TUNING.tools.budget - rig.cost;

  const bannerText =
    toolMode === 'jumper'
      ? 'Tap two points to string your own fuse — tap an endpoint to remove'
      : toolMode === 'keg'
        ? 'Tap a plain junction to plant a booster keg — tap again to remove'
        : shellsLeft > 0
          ? `Place ${shellsLeft} more shell${shellsLeft > 1 ? 's' : ''} — tap any icon to learn what it does`
          : 'Ready. Light it up!';

  return (
    <div className="shell">
      <header className="topbar">
        <h1>SUPABLAST</h1>
        <div className="hud">
          <span key={hud.multiplier} className={`hud-mult tier-${tier}`}>
            x{Math.round(hud.multiplier * 10) / 10}
          </span>
          <span className="hud-score">{hud.score} pts</span>
          <button className="icon-btn" onClick={() => setShowLegend(true)} aria-label="What do the icons mean?">
            ?
          </button>
        </div>
      </header>

      <div className="stage">
        <div ref={containerRef} className="phaser-host" />

        {phase === 'setup' && (
          <div className="overlay">
            <div className="panel">
              <h2>Grand Finale</h2>
              <p>Rig the show. Place your shells. Light the fuse.</p>
              <label className="seed-label">
                Seed
                <input value={seedInput} onChange={(e) => setSeedInput(e.target.value)} spellCheck={false} />
              </label>
              <button className="primary" onClick={() => startBoard(seedInput)}>
                Draw board
              </button>
              <p className="hint">Share a seed with friends to fake a daily tournament.</p>
            </div>
          </div>
        )}

        {phase === 'placing' && <div className="banner">{bannerText}</div>}

        {phase === 'placing' && (
          <div className="toolbar">
            <button
              className={`tool ${toolMode === 'shell' ? 'active' : ''}`}
              onClick={() => selectTool('shell')}
            >
              🌟 Shells <small>{placed.length}/{TUNING.run.shellsPerRun}</small>
            </button>
            <button
              className={`tool ${toolMode === 'jumper' ? 'active' : ''}`}
              onClick={() => selectTool('jumper')}
            >
              {TOOL_INFO.jumper.emoji} Jumper <small>{TUNING.tools.jumperCost}⚡</small>
            </button>
            <button className={`tool ${toolMode === 'keg' ? 'active' : ''}`} onClick={() => selectTool('keg')}>
              {TOOL_INFO.keg.emoji} Keg <small>{TUNING.tools.kegCost}⚡</small>
            </button>
            <span className={`budget ${budgetLeft === 0 ? 'spent' : ''}`}>
              ⚡ {budgetLeft}/{TUNING.tools.budget}
            </span>
          </div>
        )}

        {phase === 'summary' && result && (
          <div className="overlay">
            <div className="panel">
              <h2>{result.shellScore > 0 ? '🎆 FINALE!' : '💨 It died in the dark…'}</h2>
              <div className="summary-grid">
                <div>
                  <span className="stat">{result.totalScore}</span>
                  <span className="stat-label">total pts</span>
                </div>
                <div>
                  <span className="stat">x{Math.round(result.peakMultiplier * 10) / 10}</span>
                  <span className="stat-label">peak multiplier</span>
                </div>
                <div>
                  <span className="stat">
                    {result.paidSocketIds.length}/{TUNING.run.shellsPerRun}
                  </span>
                  <span className="stat-label">shells reached</span>
                </div>
              </div>
              <button className="primary" onClick={() => startBoard(randomSeed())}>
                Next show
              </button>
              <button onClick={() => startBoard(board!.seed)}>Replay this board</button>
            </div>
          </div>
        )}

        {showLegend && (
          <div className="overlay" onClick={() => setShowLegend(false)}>
            <div className="panel legend" onClick={(e) => e.stopPropagation()}>
              <h2>The Rig</h2>
              <ul className="legend-list">
                {LEGEND_KINDS.map((kind) => (
                  <li key={kind}>
                    <span className="legend-emoji">{NODE_INFO[kind].emoji}</span>
                    <span>
                      <strong>{NODE_INFO[kind].name}</strong>
                      <br />
                      {NODE_INFO[kind].blurb}
                    </span>
                  </li>
                ))}
              </ul>
              <h3>Your toolbox — {TUNING.tools.budget}⚡ per show</h3>
              <ul className="legend-list">
                {(['jumper', 'keg'] as const).map((tool) => (
                  <li key={tool}>
                    <span className="legend-emoji">{TOOL_INFO[tool].emoji}</span>
                    <span>
                      <strong style={{ color: TOOL_INFO[tool].cssColor }}>
                        {TOOL_INFO[tool].name} ({tool === 'jumper' ? TUNING.tools.jumperCost : TUNING.tools.kegCost}
                        ⚡)
                      </strong>
                      <br />
                      {TOOL_INFO[tool].blurb}
                    </span>
                  </li>
                ))}
              </ul>
              <h3>Where you place = how you bet</h3>
              <ul className="legend-list rings">
                {LEGEND_RINGS.map((ring) => (
                  <li key={ring}>
                    <span className="ring-chip" style={{ color: RING_INFO[ring].cssColor }}>
                      ⬤
                    </span>
                    <span>
                      <strong style={{ color: RING_INFO[ring].cssColor }}>{RING_INFO[ring].label}</strong> —{' '}
                      {RING_INFO[ring].odds} payout
                    </span>
                  </li>
                ))}
              </ul>
              <button className="primary" onClick={() => setShowLegend(false)}>
                Got it
              </button>
            </div>
          </div>
        )}
      </div>

      <footer className="controls">
        <button onClick={() => setPhase('setup')} disabled={phase === 'riding'}>
          Seed
        </button>
        <button className="primary ignite" onClick={ignite} disabled={phase !== 'placing' || shellsLeft > 0}>
          IGNITE
        </button>
        <button onClick={toggleSpeed}>{speed}x</button>
      </footer>
    </div>
  );
}
