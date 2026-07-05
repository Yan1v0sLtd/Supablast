import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import { FuseScene, type SceneBridge } from '../render/FuseScene';

/** Mounts a single Phaser game instance and exposes the scene once booted. */
export function usePhaserGame(bridge: SceneBridge) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FuseScene | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;
    // Render the canvas buffer at device resolution: the game world uses
    // logical 540-wide coordinates scaled by k = width/540 (see FuseScene.k),
    // which is what keeps text and emoji sharp on 2x/3x mobile screens.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: Math.round(540 * dpr),
      height: Math.round(880 * dpr),
      backgroundColor: '#0b0e1a',
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: [FuseScene],
    });
    gameRef.current = game;
    game.events.once(Phaser.Core.Events.READY, () => {
      const scene = game.scene.getScene(FuseScene.KEY) as unknown as FuseScene;
      // Proxy so the scene always talks to the latest bridge callbacks.
      scene.setBridge({
        onSocketToggled: (id, placed) => bridgeRef.current.onSocketToggled(id, placed),
        onToolsChanged: (info) => bridgeRef.current.onToolsChanged(info),
        onHud: (u) => bridgeRef.current.onHud(u),
        onRunFinished: () => bridgeRef.current.onRunFinished(),
      });
      sceneRef.current = scene;
      if (import.meta.env.DEV) {
        // Test-harness hook (dev server only, stripped from prod builds).
        (window as unknown as Record<string, unknown>).__supablastScene = scene;
      }
    });
    return () => {
      game.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  return { containerRef, sceneRef };
}
