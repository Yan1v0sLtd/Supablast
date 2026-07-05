# GRAND FINALE — Game Design Document v1.0

**Genre:** Hybrid-casual / single-decision chain-reaction with stake mechanics
**Platform:** Mobile (portrait), iOS + Android
**Session length:** 45–90 seconds per run, 5–15 min per session
**Tech:** Phaser 3 inside React shell, deterministic simulation, Vite + Supabase + Vercel
**Status:** Pre-prototype. All numbers are tuning placeholders unless marked **LAW**.

---

## 1. Vision

You are the pyrotechnician of an ever-growing fireworks show. Each run, you place your prize shells onto a fuse network, light a single fuse, and watch fire crawl through the board — splitting, jumping, fizzling, resurging — while a multiplier climbs. When flame reaches one of your shells, it pays out at that instant's multiplier.

The emotional target is the slot-bonus loop without gambling: **stake → anticipation → volatile resolution → burst**, where the "bet" is expressed through a spatial placement decision that reads as skill and genuinely contains skill.

### Design Pillars (in priority order)

1. **The stake is spatial.** Placement = bet sizing. Near = safe/low, far = risky/high. Every design decision that weakens this link is wrong.
2. **Deterministic chaos.** The sim is 100% deterministic given (seed, placements, surge inputs). Chaos is perceived, never actual. This enables server verification, replays, and spreadsheet-tunable EV.
3. **Fake finales are the theme AND the mechanic.** The chain must die and resurge 1–3 times per run, by generator design.
4. **Earned stake only (LAW).** Hard currency never converts into shells that enter the multiplier machine. Sell content, cosmetics, entries, pity — never volatility exposure.

### Anti-Pillars (things this game is NOT)

- **Not a physics sandbox.** No rigid bodies. Graph simulation with juicy presentation.
- **Not hyper-casual.** The meta (compendium, tournaments, volatility progression) carries retention; the burst carries session pleasure.
- **Not solvable.** Fresh seeds every run; daily tournament = same seed for everyone.

## 2. Core Loop

| Phase | Description | Duration |
| --- | --- | --- |
| **STAKE** | Draw board (seeded). Player places N star shells onto sockets. | ~5–10s |
| **IGNITE** | Player lights exactly one of the available ignition points. | ~1s |
| **RIDE** | Fire propagates automatically. Multiplier climbs. Surge windows may pause time for one tap. Shells pay when flame reaches them. | 15–25s |
| **BURST** | Finale resolution, score tally, compendium/tournament credit. | ~5s |
| **META** | Shell upgrades, compendium sets, next run. | — |

One run = one micro-narrative: bet placed → will it reach? → it reached at x47 / it died two junctions short.

## 3. The Fuse Network (Simulation Spec)

The board is a directed-capable graph rendered as a hand-strung fireworks rig (rooftops, scaffolds, barges — biome skins are cosmetic only).

### 3.1 Nodes

| Node | Behavior on ignition | Multiplier effect | Notes |
| --- | --- | --- | --- |
| **Junction** | Spreads fire to all unburned connected edges | +1 | The bread-and-butter node |
| **Damp Junction** | Fizzle roll (seeded): 35% chain dies here, 65% passes after 0.6s delay | +2 on pass | The tension node. Roll is pre-determined by seed — perceived risk, deterministic outcome |
| **Booster** | Fire exits at 2× speed for next 3 edges | ×1.5 to current multiplier | Rare; visually a powder keg |
| **Spark Gap** | After 0.8–1.5s delay, spark jumps to a target node up to 3 cells away | +3 | The fake-finale engine. Delay makes the board look dead |
| **Splitter** | Emits 2–3 independent fire heads | +2 | Multiple simultaneous fronts = spectacle |
| **Decoy Shell** | Small fixed payout (5–15 pts), keeps chain alive | +1 | Pre-placed by generator; makes non-shell paths still feel rewarding |
| **Shell Socket** | Empty slot where the player may place a star shell | — | 6–10 per board; player fills 3 |
| **Finale Cluster** | If ≥2 fire heads reach it within 2s: screen-filling burst | ×2 final multiplier | At most 1 per board, always in a far region |

### 3.2 Edges

Fuse segments with a burn duration (0.3–0.8s each). Total path timing is what creates the 15–25s ride. Edge burn is animated as a crawling spark (**the single most important piece of juice in the game**).

### 3.3 Multiplier Math (v0)

- Starts at x1. Node bonuses add as listed. Boosters and Finale Cluster multiply.
- Shell payout = `shellBaseValue × multiplierAtIgnitionInstant`.
- v0 cap: x100. Cap widens with account progression (this doubles as the "unlock higher volatility" fantasy — see §7).

### 3.4 Determinism (LAW)

Single seeded PRNG (e.g., mulberry32) drives: board generation, damp rolls, spark-gap targets, all timing jitter. Fixed-timestep simulation (50ms ticks), presentation interpolates. Given identical (seed, placements[], surgeInputs[]) the outcome is bit-identical on client and server. Damp junction outcomes are drawn at generation time, not at ignition time — the drama is staging, not dice.

### 3.5 Board Generator + EV Auditor

Generator pipeline:

1. Lay a spatial graph: 40–70 nodes, 1–3 ignition points, guaranteed connectivity classes.
2. Guarantee 1–3 isolated pockets reachable only via spark gaps → structural fake finales.
3. Place 6–10 shell sockets stratified by distance-from-ignition (2 near, 3–4 mid, 2–3 far).
4. Monte Carlo audit: run 500 headless sims over random placements. For each socket compute P(reach) and E[multiplier | reach]. Compute socket EV = product.
5. Reject the seed if any socket EV deviates >±20% from board mean, or if P(reach) of the farthest socket < 5% or > 60%.

This is the heart of pillar 1: near sockets ≈ 85% reach at x4–x8; far sockets ≈ 15–25% reach at x40–x70; EV roughly flat. Players choose variance, not value. The auditor is also your anti-degenerate-strategy defense — it runs in CI, not just at runtime.

## 4. Star Shells (The Stake System)

- Player owns a shell inventory (soft-earned only — **LAW**).
- Each run, player selects 3 shells from inventory and places them on sockets.
- Shell attributes: base value (payout scalar), rarity (Common → Mythic), trait (v1+, e.g., "Echo: pays 50% again if a second fire head arrives", "Magnet: extends adjacent spark-gap range by 1").
- Unignited shells are returned, not lost (v0). *Design note:* true loss-on-miss is emotionally closer to gambling stakes and much stronger — but it's also the regulatory/App Store gray zone and a churn risk for casuals. v0 ships returnable; a "Hardcore Show" mode with consumable shells and bigger payouts is the natural v2 test, gated behind progression.
- Traits are deliberately v1+: v0 must prove the placement/volatility loop with plain-value shells first. If the loop doesn't work naked, traits won't save it.

## 5. Surge Windows (Agency Layer)

- 1–2 junctions per board are flagged Surge Nodes. When fire reaches one: time dilates to 0.2× for 1.2 real seconds; player taps one of 2–3 highlighted branches; fire commits to that branch; the untapped branch stays unburned (a visible "what if").
- No input → seeded default branch (AFK-safe, determinism preserved).
- Surge inputs are part of the replay/verification payload.
- **v0: CUT.** Prototype ships pure watch-mode. Surge is the first post-prototype addition because it's the answer to "is there skill after placement?" — but it must not block validating the core.

## 6. Run Structure & Session Model

Decision (as argued previously): unlimited base runs + gated high-stakes.

| Mode | Access | Stake | Purpose |
| --- | --- | --- | --- |
| **Free Show** | Unlimited | Standard shells | Practice, compendium grind, session filler |
| **Daily Tournament** | 3 entries/day | Standard shells, identical seed for all players | The real anticipation engine + leaderboard. Pure placement skill comparison |
| **Big Show** | Ticketed (earned + purchasable tickets) | Boosted values, wider multiplier cap | The "bonus game" scarcity moment. Slots earn bonuses through drought; we earn them through gating |

Second-order effect to watch: if Free Show is too rewarding, Big Show scarcity collapses. Free Show payouts must feed compendium progress primarily, currency secondarily.

## 7. Meta & Progression

- **Compendium:** collectible shell catalog with rarity tiers and set bonuses (sets grant account-level perks: +1 shell slot at set X, wider cap at set Y). This is the D30 carrier — it must be deep. Target 120+ shells at launch across 8–10 themed sets.
- **Volatility ladder:** account levels unlock higher multiplier caps and boards with more far-sockets. Progression fantasy = "I can handle bigger swings," which is mechanically real.
- **Pity system (LAW-adjacent):** guaranteed floor — every N consecutive runs below threshold payout grants a bonus shell pack. Chain variance = reward variance; without pity, cold streaks churn casuals.
- **Replays & sharing:** deterministic sim → tiny replay files (seed + inputs). One-tap share of finale clips. This is the organic UA channel; budget real effort here.

## 8. Economy & Monetization

Revenue lines: Battle pass (cosmetic + shell packs), cosmetics (firework skins/trails/finale styles — perfect cosmetic surface, zero gameplay impact), Big Show tickets, pity accelerators, compendium slot expansions.

**LAW restated:** purchased items never increase EV-per-run of the multiplier machine via stake injection. Tickets buy access frequency, not edge. This is the line between "exciting F2P" and loot-box-plus exposure.

Currencies (v1): **Sparks** (soft, from runs) · **Tickets** (Big Show access) · **Gems** (hard, cosmetics/pass/tickets only).

## 9. Technical Architecture

```
/sim        Pure TypeScript, zero Phaser deps. Graph, PRNG, fixed-step engine,
            generator, Monte Carlo auditor. Runs headless in Node (CI, server
            verification, tuning notebooks) and in-browser identically.

/render     Phaser 3 scene consuming an event stream from /sim
            (NODE_IGNITED, EDGE_BURN_START, SHELL_PAID, CHAIN_DIED, SPARK_JUMP...).

/app        React shell: menus, placement UI overlay, meta, Supabase client.

/server     Supabase edge functions: seed issuance, score verification
            (re-run sim server-side from replay payload), leaderboards.
```

The sim/render split is non-negotiable: it's what makes tournaments cheat-resistant, replays free, and tuning a spreadsheet exercise instead of a playtest exercise.

## 10. Prototype v0 — Scope Contract

**Goal:** answer one question — *"Is watching a placed bet ride the chain compelling for 20 runs in a row?"*

**IN:** sim engine · board generator (no auditor rejection yet, just logging) · 3-shell placement UI · one ignition point · propagation with all node types except Finale Cluster · multiplier + payout · minimal juice (crawling spark, ignition flashes, payout popups, screen shake on big hits) · run summary screen · seed input field (for testing + faking the daily tournament with friends)

**OUT:** surge windows · traits · compendium · economy · tournaments backend · monetization · art (rectangles and circles are fine; the spark crawl animation is the ONE piece of juice that isn't optional)

**Kill/pivot criteria after prototype:** if playtesters (target: you + 5–8 people, 20 runs each) don't spontaneously replay, don't develop placement opinions ("I always go far-left"), or report the ride feels like waiting — the ride phase is broken and needs redesign before any meta work.

## 11. Key Risks (ranked)

1. **The ride bores.** 15–25s of watching must feel like a story, not a loading bar. Mitigations: fake finales, multiple fire heads, decoy payouts, 2× speed button (non-negotiable by run 300). This is what v0 tests.
2. **Meta too thin.** Single-decision games die at D30 without collection depth. Mitigation: compendium is a launch requirement, not a fast-follow.
3. **EV auditor fails silently** → degenerate placement dominates → tournament meta collapses. Mitigation: auditor in CI + live telemetry on socket pick-rates.
4. **Regulatory drift.** Consumable stakes, purchased volatility, engineered near-misses — each is one "small" design decision away. The LAWs in this doc exist to be quoted in future arguments.

## 12. Open Tuning Questions (for the spreadsheet, post-prototype)

- Multiplier curve shape: linear +N per node vs. geometric — geometric feels better late-run but breaks EV flatness faster.
- Damp junction pass rate 65%: high enough that chains usually live, low enough that damp nodes scare. Needs telemetry.
- 3 shells vs. 2 vs. 5: fewer shells = purer bet, more shells = portfolio play. I'd defend 3.
- Run length 15–25s vs. 10–15s: shorter is safer for retention, longer is needed for fake finales to land. Prototype both via edge burn duration.
