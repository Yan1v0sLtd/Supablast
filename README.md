# Supablast — Grand Finale

Hybrid-casual chain-reaction game: place your star shells on a fuse network, light a single fuse, and ride the multiplier as fire crawls, splits, jumps and fizzles across the board.

**The design source of truth is [docs/GDD.md](docs/GDD.md).** Read it before touching gameplay code — especially the LAWs (determinism, earned-stake-only) and the v0 scope contract (§10).

## Status

**Prototype v0** (GDD §10): the full stake → ignite → ride → burst loop is playable with placeholder art. The one question this build exists to answer: *is watching a placed bet ride the chain compelling for 20 runs in a row?*

In: deterministic sim engine, seeded board generator, Monte Carlo EV auditor (logging only), 3-shell placement, all node types except Finale Cluster, crawling-spark juice, run summary, seed input (share a seed to fake a daily tournament).

**Toolbox thin slice** (design exploration beyond GDD v1.0, pending a v1.1 amendment): each run grants a rig budget (6⚡) spendable on player-placed tools — Jumper Fuses (2⚡, string your own fuse between nearby points) and Booster Kegs (2⚡, convert a junction to a booster). Tools are deterministic sim inputs: the replay payload is `(seed, shells[], tools[])`, validated by `src/sim/tools.ts` with the same rules client- and (future) server-side.

Out (deliberately): surge windows, shell traits, compendium, economy, tournaments backend, monetization, real art.

## Quick start

```bash
npm install
npm run dev          # play at http://localhost:5173
npm test             # sim test suite
npm run audit:boards # EV audit over sample seeds (add seeds as args after --)
npm run build        # typecheck + production build
```

## Architecture (GDD §9)

```
src/sim      Pure TypeScript, ZERO Phaser/DOM deps. PRNG, fixed-step engine,
             board generator, Monte Carlo EV auditor. Runs identically headless
             in Node (tests, CI, future server verification) and in-browser.
src/render   Phaser 3 scene. Consumes the SimEvent stream from /sim and
             interpolates presentation between fixed 50ms ticks. Zero game logic.
src/app      React shell: menus, placement overlay, HUD, run summary.
scripts/     Headless tooling (board audit).
server/      (post-prototype) Supabase edge functions: seed issuance, replay
             verification, leaderboards.
```

The sim/render split is non-negotiable (GDD §9): the entire run is simulated instantly before playback begins, which is what makes tournaments cheat-resistant, replays free (seed + inputs), and tuning a spreadsheet exercise.

### Determinism (LAW)

Given identical `(seed, placements[])` the outcome is bit-identical everywhere. All stochastic outcomes (damp rolls, spark-gap delays, splitter head counts) are pre-drawn from the seed before ignition. Never use `Math.random()` inside `src/sim` — everything flows from the seeded mulberry32 PRNG.

### Tuning

Every gameplay number lives in `src/sim/tuning.ts`. Current values are v0 placeholders; the EV auditor (`npm run audit:boards`) prints per-socket P(reach) / E[mult|reach] / EV so tuning stays an evidence exercise.

Current state of the pillar-1 gradient (sample boards): near ≈ 0.7–1.0 reach at low multipliers, mid ≈ 0.45, far ≈ 0.15–0.25 at x40–x75, EV near-flat (occasional ±20% flags — see GDD §12 for the open multiplier-curve question). Boards are serpentine rigs: rows chained side-to-side with zigzag risers, a looped bottom section so early fizzles kill a front rather than the run, and route-aware damp quotas that concentrate risk on the deeper half of each socket's path.
