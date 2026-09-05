---
name: factorio-advisor
principal_stated_goal: "Do you think it is possible to make a factorio-advisor folder similar to this one where I can ask you advice for my Factorio game? vanilla Space Age is it. You can start /SoftwareDesign it and then /Implement tiers A and B in a new project folder."
phase: tiers A and B complete
progress: 13/13
frozen: false
---

# Factorio Advisor

## Goal

A read-only toolkit that lets SoushAI advise Soushi on a vanilla Factorio 2.0 Space Age playthrough, grounded in the game's own declared numbers rather than in recall or a wiki page.

## Vision

Soushi asks a ratio, technology or throughput question and gets an exact answer with the snapshot it came from named in the header. Where the game's own data cannot answer, the tool says so instead of inventing a plausible number. Blueprint strings get audited for where they actually bind rather than for what they contain.

## Out of Scope

- Live game state. `level.dat` is undocumented binary; reading it would need a helper mod or RCON, which is tier C and a separate decision.
- Playing the game, or sending any input to it.
- Modded runs. The snapshot is vanilla Space Age by construction.

## Claims

- [x] **C1 — The snapshot comes from the game and costs one command.** `bun run sync` runs Factorio headless and writes a resolved `data.raw` into `data/`.
  - *Evidence:* `bun run sync` reported `Factorio 2.0.77 (build 84539), 5 mods, 27.8 MB`, log lines showing `core 0.0.0`, `base 2.0.77`, `elevated-rails 2.0.77`, `quality 2.0.77`, `space-age 2.0.77` loaded.
- [x] **C2 — The snapshot is vanilla Space Age, not Soushi's mod set.** A fresh write-data regenerates `mod-list.json` with only the shipped base mods.
  - *Evidence:* `even-distribution 2.0.2`, which is installed in `~/.factorio/mods`, is absent from the manifest's five mods.
- [x] **C3 — A recipe is fully reported, including every machine that can run it.** `bun run recipe <name>` gives category, time, ingredients, results, productivity eligibility, unlocking technology, and each machine's output rate.
  - *Evidence:* `bun run recipe electronic-circuit` printed 0.5s, 1 iron-plate + 3 copper-cable, unlocked by `electronics`, and `assembling-machine-3` at 2.5/s. Hand-check: crafting_speed 1.25 / 0.5s = 2.5.
- [x] **C4 — The production chain solves exactly.** `bun run ratio <item> --rate=<n>` gives per-step rates, machine counts, raw inputs, power and pollution.
  - *Evidence:* `ratio electronic-circuit --rate=45` gave 45/s iron-plate, 135/s copper-cable, 67.5/s copper-plate, 72 steel furnaces and 108 steel furnaces. Hand-check against the raw prototypes: steel-furnace speed 2 over smelting time 3.2s = 0.625/s, and 45/0.625 = 72, 67.5/0.625 = 108.
- [x] **C5 — Byproducts cancel demand instead of spawning a second line.** A multi-output recipe reports its surplus.
  - *Evidence:* `ratio plastic-bar --rate=30 --recipe=petroleum-gas=advanced-oil-processing` gave 545.5/s crude oil, 272.7/s water, and surpluses of 245.5/s light oil and 136.4/s heavy oil. Hand-check: 300/55 = 5.4545 crafts/s, times the recipe's 100 crude, 50 water, 45 light and 25 heavy.
- [x] **C6 — Recipe choices are stated and overridable, never silent.** Every product with more than one recipe reports the ones declined and the flag that switches them.
  - *Evidence:* the same run printed `petroleum-gas: using advanced-oil-processing, declined basic-oil-processing, coal-liquefaction, light-oil-cracking, empty-petroleum-gas-barrel (override with --recipe=petroleum-gas=basic-oil-processing)`.
- [x] **C7 — Modules and beacons resolve with the Space Age falloff.** Effects sum, beacons transmit through `distribution_effectivity` scaled by the `profile` curve, and what does not fit a machine is reported.
  - *Evidence:* synthetic print with two `assembling-machine-3`, four `productivity-module-3` each, one beacon holding two `speed-module-3`. Tool gave 13.3/s output and 5.21 MW. Hand-check: speed -0.6 from prod modules plus 2 x 0.5 x 1.5 x profile[0]=1 gives 1.9x; 1.25 x 1.9 / 0.5 = 4.75 crafts/s; times 1.4 productivity = 6.65/s each. Power: 375kW x (1 + 3.2 + 2.1) x 2 machines + 480kW beacon = 5.205 MW.
- [x] **C8 — The tech tree gives cost, path and totals.** `bun run tech <name> --path` orders the whole prerequisite closure and sums the science.
  - *Evidence:* `tech kovarex --path` produced 34 technologies in a researchable order, totalling 5325 automation, 5190 logistic, 3750 chemical and 1000 space packs, 188075 lab-seconds at speed 1.
- [x] **C9 — Trigger technologies are shown as actions, not as zero cost.** Space Age unlocks several technologies by doing rather than by research.
  - *Evidence:* `tech agricultural-science-pack` printed `trigger craft-item: bioflux x100` and `cost (no science; unlocked by doing)`, matching the prototype's `research_trigger`.
- [x] **C10 — Belt throughput is exact and derived.** `bun run belt <item> --rate=<n>` gives items/s per tier and the saturation of one belt.
  - *Evidence:* 15, 30, 45 and 60 items/s for the four tiers, computed as `speed * 60 / 0.25 * 2`, matching the published figures; `--rate=45` reported one express belt at 100%.
- [x] **C11 — Real blueprint strings decode.** Not a synthetic string of my own making.
  - *Evidence:* 61 distinct blueprint strings extracted from Factorio's own `tips-and-tricks-simulations.lua` and `factoriopedia-simulations.lua` decoded 61 for 61, 0 failures.
- [x] **C12 — A blueprint audit reports where the print binds.** Net flow per item, separating what must be fed in from what it exports.
  - *Evidence:* a shipped 83-entity space platform print reported three crushers making 10/s iron ore, 5/s carbon and 2.5/s ice, needing 0.5/s of each asteroid chunk fed in. Hand-check: `metallic-asteroid-crushing` is 1 chunk to 20 iron ore in 2s, crusher speed 1, so 0.5 crafts/s x 20 = 10/s, and the 0.2-probability chunk return gives the 0.1/s the tool credited.
- [x] **C13 — Beacon coverage is geometric, read from the positions in the print.** Not assumed, and not counted per print.
  - *Evidence:* in the synthetic print above, both machines at x=0.5 and x=6.5 were marked beaconed by the single beacon at x=3.5, from its 3x3 selection box expanded by `supply_area_distance` 3.

## Anti-claims

- [x] **A1 — Nothing under `~/.factorio` or the Steam install is ever written.**
  - *Evidence:* `find ~/.factorio -newermt "2026-08-24 04:00"` and the same over the Steam install both returned nothing after a full `sync` plus every command in the README. Every write in `src/` lives in `dump.ts` and targets a path derived from `PROJECT_ROOT`: `data/`, `data/manifest.json`, and `.factorio-runtime/`. The engine itself is redirected there by a generated `config.ini` setting `write-data`.
- [x] **A2 — No hardcoded game statistics.**
  - *Evidence:* `grep -rnE "(crafting_speed|energy_usage|speed|productivity)\s*[:=]\s*[0-9]" src/` returns three hits, all zero-initialisers for accumulators. The seven declared constants are engine facts absent from the dump, each named and commented: `DEFAULT_ENERGY_REQUIRED`, `DEFAULT_AMOUNT`, `DEFAULT_PROBABILITY`, `DEFAULT_DRAIN_FRACTION`, `ITEM_SPACING_TILES`, `MULTIPLIER_FLOOR`, `PRODUCTIVITY_CEILING`. The raw-material set and the recipe exclusions are derived from `resource`, `tile` and recipe categories, not listed.
- [x] **A3 — No number is invented where the data cannot support one.**
  - *Evidence:* inserter output is reported as a rotation-bound ceiling with a printed caveat naming belt chasing and the capacity research as the reasons it is not a prediction. Quality module scaling is not applied, and a print using quality modules prints a warning saying the figures understate it. Both gaps are visible in the command output, not only in the code.
- [x] **A4 — Recycling recipes never appear as a way to manufacture something.**
  - *Evidence:* first run of `ratio electronic-circuit` proposed `iron-ore-recycling` to make iron ore. After excluding category `recycling`, the same command resolves iron ore as a raw input. `scrap-recycling` is category `recycling-or-hand-crafting` and is deliberately kept, because on Fulgora it is a genuine source.

## Not yet specified

- **Tier C, live game state.** A helper mod writing to `script-output`, or RCON against a local listen server. Different trust posture; Soushi's call.
- **Quality-scaled module effects.** Needs the engine's scaling rule from a citable source, not a guess.
- **Pipe and fluid throughput.** Depends on run length, which no prototype declares.
- **Power generation planning.** Boilers, steam, reactors and solar are all in the snapshot; nothing reads them yet.
- **Spoilage and Gleba timing.** `spoil_ticks` is in the data and unmodelled.
