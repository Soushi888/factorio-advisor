---
name: factorio-advisor
principal_stated_goal: "Do you think it is possible to make a factorio-advisor folder similar to this one where I can ask you advice for my Factorio game? vanilla Space Age is it. You can start /SoftwareDesign it and then /Implement tiers A and B in a new project folder."
phase: tier C complete (Convene pm-builder run, 2026-09-05, six commits from an empty repo)
progress: 18/18
frozen: false
---

# Factorio Advisor

## Goal

A read-only toolkit that lets SoushAI advise Soushi on a vanilla Factorio 2.0 Space Age playthrough, grounded in the game's own declared numbers rather than in recall or a wiki page.

## Vision

Soushi asks a ratio, technology or throughput question and gets an exact answer with the snapshot it came from named in the header. Where the game's own data cannot answer, the tool says so instead of inventing a plausible number. Blueprint strings get audited for where they actually bind rather than for what they contain.

## Out of Scope

- Parsing `level.dat` ourselves. It is undocumented binary. Tier C reads live state by letting the engine tick a copy of the save (ADR-6), chosen by Soushi on 2026-09-05 over a helper mod in his game or RCON.
- Reading the running session. `state` is as fresh as the last save on disk, never fresher.
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
- [x] **C14 — Live state is read from a copy of the save, by the engine itself.** `bun run state --save <name>` copies the save into `.factorio-runtime/saves/`, appends a collector to the copy's own `control.lua`, runs `factorio --benchmark` on the copy, and reports research, one-hour production rates and machine counts under the snapshot header (ADR-6). Landed in commit `0e29c72` on base `0485062`.
  - *Evidence:* pm re-ran `bun run state --save "game 4"` at 20:02:57 on 2026-09-05: 140 technologies researched, current `steel-plate-productivity`, queue `steel-plate-productivity -> mining-productivity-3 -> braking-force-5`, iron-ore 1981.9/min, 4715 machines across 12 prototypes, tick 19168256 (88.7 h), one surface. Every figure matched the builder's independent run (ledger builder#10). Second probe of a different shape: `jq` over `data-raw.json` found all 140 researched techs in the snapshot, the researched set closed under prerequisites, and all three queued techs unresearched with prerequisites met. Open: comparison against Soushi's own technology screen, pending a screenshot.
- [x] **C15 — The next research is advised from the live state.** `bun run next` lists every technology whose prerequisites are all researched and which is not itself researched, with cost, lab-seconds and unlocks; `--for=<item>` gives the research path from the current state to the tech unlocking that item. Landed in commit `8844b3e` on base `0e29c72`.
  - *Evidence:* on game 4, 140 of 275 researched and 17 researchable, cheapest first `space-platform` and `uranium-processing` (trigger technologies), then the two formula techs, then `battery-mk2-equipment` at 3000 lab-seconds up to `weapon-shooting-speed-6` at 36000. pm re-derived the candidate set with `jq` (enabled, unresearched, every prerequisite researched): 17 of 17 names identical. `--for=carbon-fiber` gave 14 technologies; pm's recursive prerequisite closure minus the researched set gave the same 14. `--for=rocket-silo` reports already researched instead of an empty table. Non-blocking N1 carried into C16: `--for` without `=` is silently ignored.
- [x] **C16 — Power is priced from the machine census and the snapshot.** `bun run power` prints generation by source, the boiler-to-engine chain, the solar day-night average from the surface curve the collector records, accumulators, the draw ceiling per prototype with the engine's own resolved drain, per-event draws named rather than converted, and the balance. Commits `ff6e2e8` (U3) and `2a0f546` (U3b, census fix) on base `8844b3e`; verdicts pm#18 and pm#19.
  - *Evidence:* pm reproduced every printed watt by hand: 407 engines x 900 kW = 366 MW, where 900 kW follows from `fluid_usage_per_tick` 0.5, `maximum_temperature` 165, steam `default_temperature` 15 and `heat_capacity` 0.2kJ; 1399 panels x 60 kW = 83.9 MW, x 0.7 over the Nauvis cycle = 58.8 MW; boiler 1.8 MW over 150 K x 0.2 kJ = 60 steam/s, engine 30/s, so one boiler feeds two and 115 feed 230 of the 407 built; 645 accumulators x 5 MJ = 3225 MJ at 194 MW; draw 493 MW over 26 classes and 12677 entities, idle drain 46.8 MW summed by hand; shortfall 227 MW against the steam-limited 266 MW. The builder's second probe of a different shape, the engine's own `max_power_output` at runtime, agreed with the derivation.
  - *Defect closed (pm#16):* U3's hand-named census omitted inserters, radars, roboports, turrets, lamps, pumps and accumulators and understated draw by 73 MW; fixing it exposed that a usage/30 drain rule invented 10 kW per radar the engine resolves to zero. U3b derives the class list from every prototype declaring an energy source and copies the engine's resolved usage, drain and buffer per class, applying no rule.
  - *On trust:* the solar ramp between the four curve points is linear (the values print, so it is refutable); roboport 50 kW and radar 0 drain, which only the engine resolves and a second run reproduced.
  - *Open, non-blocking N4:* bare `bun run state` asks for a save name while the README says it reads the newest save; assigned to U5.
- [x] **C17 — The documentation matches the shipped code.** README, DESIGN, CLAUDE.md and this file agree with `src/` at `ea88b28`, checked by a CodeDocs Sync pass and verified by the builder, who did not write them. Docs commit `5d44e5c`.
  - *Evidence:* the builder's first verification (builder#32) refuted the pass: `energy.ts` and `tech.ts` had no paragraph in CLAUDE.md, and the constant inventory in A2 and CLAUDE.md missed `LANES` and misplaced `TICKS_PER_SECOND`. Both fixed; the second verification (builder#33) confirms in both directions: all sixteen `src/*.ts` basenames named in CLAUDE.md, all eleven `package.json` scripts documented, the canonical grep's ten constants all present in A2, the four stale DESIGN strings absent, README line 22 true, DocSync links 4 checked 0 broken. The refusal is kept here on purpose: a docs pass that its own author verified would have shipped both gaps.
  - *Falsifier:* a command, flag, path or constant named in a document that `src/` does not have, or the reverse.
- [x] **C18 — The collector reports what Soushi asked to see on 2026-09-05 and could not.** Lab speed modifier and research progress; evolution factor and pollution per surface; logistic network contents by item; electric network statistics, so `power` prints what the grid delivered against nameplate; and bare `bun run state` reads the newest save (N4). Each figure is copied from the Lua API on the copy; the one derived figure, the lab multiplier, is checked. Commit `ea88b28` on base `2a0f546`; verdict pm#22.
  - *Evidence:* pm ran bare `state` at 20:34:40 with both A1 probes empty. Delivered power for game 4: 61.3 MW steam, 50.5 MW solar, 67 kW accumulator, against 112 MW consumed, and production minus consumption from the state file is -0.5 W. The electric flow unit (joules per tick, times 60) was settled by a machine of known duty cycle: 34 radars report 298 kW each against a 300 kW nameplate. Lab speed bonus 1.9 equals the sum of the five researched `research-speed` effects in the snapshot, 0.2 + 0.3 + 0.4 + 0.5 + 0.5, so a lab runs at 2.9x and `steel-plate-productivity` is 39.3% done. Nauvis evolution 0.8978, pollution 54322.6; two logistic networks, 102 item kinds, copper-ore 73354 on top. U2 and U3 output unchanged after the additive schema change. ADR-8 records the unit derivation.
  - *On trust:* the logistic counts and the evolution value themselves, copied from the API; refutable against the in-game screens.
  - *Falsifier:* a printed figure that a second read of the same save, or the in-game statistics screen at the same tick, contradicts; or a figure that appears when the save carries no such data instead of a stated gap.

## Anti-claims

- [x] **A1 — Nothing under `~/.factorio` or the Steam install is ever written.**
  - *Evidence:* `find ~/.factorio -newermt "2026-08-24 04:00"` and the same over the Steam install both returned nothing after a full `sync` plus every command in the README. Every write in `src/` lives in `dump.ts` and `state.ts` and targets a path derived from `PROJECT_ROOT`: `data/`, `data/manifest.json`, `data/state/`, and `.factorio-runtime/`. The engine itself is redirected there by a generated `config.ini` setting `write-data`. Re-checked after C14 on 2026-09-05: both probes empty at run start 20:02:57 (pm) and 20:01:58 (builder), `game 4.zip` kept its 2026-07-10 mtime and digest `c66b0e5b…`, and `readlink -f` confirmed the probed Steam path and the engine's own path are one directory.
- [x] **A2 — No hardcoded game statistics.**
  - *Evidence:* `grep -rnE "(crafting_speed|energy_usage|speed|productivity)\s*[:=]\s*[0-9]" src/` returns three hits, all zero-initialisers for accumulators, unchanged after C14 (re-run by pm at `0e29c72`). The declared constants are engine facts absent from the dump, each named and commented at its definition. The canonical inventory is the grep, not a list kept here: `grep -rnE "^(export )?const [A-Z][A-Z_]+ = [0-9.]+" src/`. At `ea88b28` it returns twelve declarations naming ten distinct constants: `DEFAULT_ENERGY_REQUIRED`, `DEFAULT_AMOUNT`, `DEFAULT_PROBABILITY` (proto.ts), `MULTIPLIER_FLOOR`, `PRODUCTIVITY_CEILING`, `DEFAULT_DRAIN_FRACTION` (machines.ts), `ITEM_SPACING_TILES`, `LANES` (belts.ts), `TICKS_PER_SECOND` (declared in belts.ts, state.ts and power.ts, one fact three times), and `BENCHMARK_TICKS` (state.ts, a choice rather than a game fact, commented as one, ADR-6). An earlier version of this line said seven, then nine, and was wrong both times because it was typed rather than regenerated (builder#32). The raw-material set and the recipe exclusions are derived from `resource`, `tile` and recipe categories, not listed.
- [x] **A3 — No number is invented where the data cannot support one.**
  - *Evidence:* inserter output is reported as a rotation-bound ceiling with a printed caveat naming belt chasing and the capacity research as the reasons it is not a prediction. Quality module scaling is not applied, and a print using quality modules prints a warning saying the figures understate it. Both gaps are visible in the command output, not only in the code.
- [x] **A4 — Recycling recipes never appear as a way to manufacture something.**
  - *Evidence:* first run of `ratio electronic-circuit` proposed `iron-ore-recycling` to make iron ore. After excluding category `recycling`, the same command resolves iron ore as a raw input. `scrap-recycling` is category `recycling-or-hand-crafting` and is deliberately kept, because on Fulgora it is a genuine source.

## Not yet specified

- **Tier C, live session state.** `state` reads the last save on disk (C14). Reading the running game would need a helper mod in Soushi's own game or RCON, both declined on 2026-09-05 in favour of the save copy. Reopen only if save freshness turns out to be the bottleneck while playing.
- **Quality-scaled module effects.** Needs the engine's scaling rule from a citable source, not a guess.
- **Pipe and fluid throughput.** Depends on run length, which no prototype declares.
- **Power generation planning.** Boilers, steam, reactors and solar are all in the snapshot; nothing reads them yet.
- **Spoilage and Gleba timing.** `spoil_ticks` is in the data and unmodelled.
