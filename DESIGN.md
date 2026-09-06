# factorio-advisor: architecture

Read-only advisory toolkit for a vanilla Factorio 2.0 Space Age playthrough. Sibling of `wesnoth-advisor`, same spirit: the tool reads what the game declares and answers questions about it, the player plays.

Target version: Factorio **2.0.77** (build 84539, linux64, steam), mods `base`, `elevated-rails`, `quality`, `space-age`, all 2.0.77.

## The inversion that shapes everything

`wesnoth-advisor` reads the live board because a Wesnoth savegame is plain WML text. Factorio's is not. `game 4.zip` holds `level-init.dat`, a 1 MB version-locked binary blob with no published format. Nothing outside the engine parses it.

So the live board is out of reach without running code inside the game, and that is deliberately out of scope here. What is in reach is everything the game declares before a map exists: every recipe, machine, module, technology, belt, planet and quality tier. That is the substrate for the questions Factorio actually provokes, which are ratio questions, tech questions and throughput questions, not "what is on tile 412,88".

Two tiers, both fully offline:

- **Tier A, the prototype solver.** Production ratios, machine counts, power, pollution, tech costs and research paths, all computed from the game's own declared numbers.
- **Tier B, the blueprint audit.** A blueprint string decodes to plain JSON. Given one, report what it contains and where its throughput actually binds.

## ADR-1: the snapshot comes from `--dump-data` into an isolated write-data

Three ways to get `data.raw`:

1. Parse `data/base/prototypes/*.lua` statically. Rejected. These are real Lua programs with `require`, loops, `data:extend`, and helper functions; `recipe.lua` alone is 2628 lines and Space Age generates recipes procedurally. A static parser would be wrong in exactly the places that matter.
2. Embed a Lua interpreter and replay the data stage. Rejected as disproportionate.
3. Ask Factorio. `bin/x64/factorio --dump-data` writes the fully resolved `data.raw` as JSON. This is the engine's own answer, so it cannot drift from the game.

Option 3 has one problem: the dump lands in `script-output/` under the write-data directory, which by default is `~/.factorio`. Writing into the game's user directory breaks the read-only property that makes this class of tool trustworthy.

The fix is `--config`. Factorio's `config.ini` carries `[path] read-data` and `write-data`, so a generated config pointing `read-data` at the Steam install and `write-data` at a directory inside this project keeps every byte the engine writes inside the project.

Verified 2026-08-24: the run loaded `core`, `base 2.0.77`, `elevated-rails 2.0.77`, `quality 2.0.77`, `space-age 2.0.77` and emitted a 27.8 MB `data-raw-dump.json`, while `~/.factorio` was untouched. A fresh write-data means a fresh `mod-list.json`, which is why `even-distribution` is absent: the snapshot is vanilla Space Age by construction, which is what was asked for.

**Consequence:** `sync` takes about three seconds. Two commands launch the engine, `sync` and `state`; see ADR-6 for the second, which reads a copy of a save and never opens the player's own.

## ADR-2: query time never touches the game

`sync` writes `data/data-raw.json` plus `data/manifest.json` (game version, build, mod set with versions, dump timestamp, byte size). Every other command reads only those. A stale snapshot is therefore detectable and reportable, never silently wrong, and the tool works with Factorio uninstalled.

The snapshot is gitignored. It is 27.8 MB of derived data with a one-command rebuild.

## ADR-3: no hardcoded game numbers

Inherited from `wesnoth-advisor` and load-bearing. Every crafting speed, energy draw, module effect, belt speed and science cost is read from the snapshot. If the game patches, the numbers follow.

The only numeric literals permitted in lookup paths are **engine facts that the dump cannot carry**, each declared once, named, and commented at its definition. Seven belong to this ADR, in two kinds, and ADR-6 declares `TICKS_PER_SECOND` and `BENCHMARK_TICKS` alongside them. The canonical list is ISA anti-claim A2; keep the count there and nowhere else, because a number restated in three files rots in two of them.

Defaults for absent fields, which exist because the dump omits a field equal to its default:

| Literal | Meaning | Why it is not in the dump |
|---|---|---|
| `0.5` | `recipe.energy_required` default, in seconds | `electronic-circuit` has no `energy_required` key |
| `1` | `ingredient.amount` / `result.amount` default | Omitted on single-unit entries |
| `1` | `result.probability` default | Present only on probabilistic results such as `uranium-processing` |
| `1/30` | Idle drain of an electric machine with no declared `drain` | `assembling-machine-3` declares none |

Engine rules that are not prototype fields at all:

| Literal | Meaning |
|---|---|
| `0.25` | Item spacing on a belt, in tiles |
| `0.2` | Floor on the speed, consumption and pollution multipliers |
| `3` | Ceiling on the productivity bonus |

Belt throughput follows from the spacing: `items/s = speed * 60 ticks * (1 / 0.25) * 2 lanes = speed * 480`. Yellow belt at `speed 0.03125` gives 15 items/s, which is the published figure.

Two engine rules are deliberately **not** implemented, because implementing them would mean guessing: inserter throughput beyond the rotation-bound ceiling, and how quality scales a module's effect. Both are reported as gaps in the output where they apply. A tool that says "this figure understates your print" is more useful than one that quietly invents a multiplier.

### A machine's own effects are a prototype field, and were unread for a month

Three Space Age machines carry productivity in the building rather than in a module: `electromagnetic-plant`, `foundry` and `biochamber` each declare `effect_receiver.base_effect.productivity` of 0.5. Nothing in `src/` read that field until 2026-09-05, so every command that priced those machines understated them by half: `ratio` asked for 11.25 electromagnetic plants where the game needs 7.5, and a generated row labelled 48/s would have made 72/s and overrun its output belt at 120 percent.

It is a declared prototype field, so reading it was always inside ADR-3 rather than an exception to it. The fix lives in `machines.ts`, in the one function that folds effects, so `ratio`, the blueprint audit and the generator moved together and cannot disagree. Regression both ways: electronic circuits go from 11.25 to 7.5 plants, and C4's steel furnace figures, 72 and 108, do not move at all, because a steel furnace declares no base effect.

Found by the auditor asking what a generated row would DO in the game rather than what it reported, which is the question that separates a plausible artefact from a correct one.

### Raw materials come from the game too

The solver needs to know where a chain stops. That set is derived, not listed: every product a `resource` prototype yields when mined (iron ore, crude oil, scrap, calcite, lithium brine, fluorine, and the rest), plus every fluid a `tile` prototype carries for an offshore pump (water, lava). A new planet's resources therefore arrive on their own.

### Recycling is excluded from production planning

310 of the 659 recipes in Space Age are recycling recipes. A recycler returns a quarter of what went in, so every one of them lists its ingredients as outputs. Left in the producer index, they make the solver propose manufacturing iron ore by recycling iron ore, which it did on the first run. Recipes in category `recycling` and the `parameters` placeholder set are excluded from recipe selection but stay queryable. `scrap-recycling` is category `recycling-or-hand-crafting` and stays in, because on Fulgora it genuinely is how you get things.

## ADR-4: blueprints from strings, never from `blueprint-storage-2.dat`

The local blueprint library is a 500 KB binary file in the same undocumented family as the save. A blueprint **string** is documented and stable: one version byte (`0`), then base64 of a zlib deflate of a JSON object. `node:zlib` inflates it in one call. Tier B therefore accepts a string on stdin, from a file, or from a `.txt`, and never reads the library.

## ADR-5: the solver is exact where the graph allows, and says so where it does not

Given a target rate for an item, the chain expands depth first over the recipe graph. Two honest complications:

- **Choice.** Many items have several recipes (`iron-plate` from smelting or from molten iron, `advanced-oil-processing` versus `basic-oil-processing`). The solver picks by a stated rule, in order: a recipe whose main product is the target beats one that makes it as a byproduct; a shallower chain to raw materials beats a deeper one; a recipe unlocked earlier in the tech tree beats one gated behind a planet; fewer ingredients beats more. The tech-tree term is what separates plain `copper-cable` from `casting-copper-cable`, which tie on every other measure. Without it the tie fell to alphabetical order, which is not a reason to prefer anything. Every alternative that lost is reported with the flag that would switch it, so the choice is arguable rather than buried. `--recipe product=recipe-name` overrides.
- **Cycles.** Oil cracking and coal liquefaction feed themselves. A depth-first expansion would not terminate. The solver detects the cycle, stops expanding, and reports the loop explicitly rather than emitting a plausible wrong number.

Byproducts are tracked and reported as surplus, not silently discarded.

## ADR-6: live state comes from a copy of the save, ticked by the engine itself

Tier C was left open because the save is version-locked binary and nothing outside the engine parses it. That framing turned out to name the wrong obstacle. We never needed to parse the save. We needed the engine to read it for us and tell us what it saw.

Three facts make that cheap, and each was verified against the real binary rather than recalled:

1. `factorio --benchmark <save> --benchmark-ticks N` loads a save and runs the update loop. It is not a server, so it wants no multiplayer state and no credentials.
2. A save carries its own `control.lua`. Appending to it needs no mod, so the mod set never changes and a save made with mods installed still loads.
3. Scripts run and `on_nth_tick` fires with no player connected, and `helpers.write_file` lands under the write-data directory, which ADR-1 already redirects into this project.

So `bun run state --save "game 4"` copies the save into `.factorio-runtime/saves/`, appends a collector to the copy's control script, runs the binary against the copy, reads one JSON file back, and writes `data/state/<save>.json`.

The player's save is never opened in place and never written back. Verified 2026-09-05 on `game 4.zip`: after a full run, `find` over `~/.factorio` and over the Steam install both returned nothing newer than the run start, and the original save kept its 2026-07-10 mtime and its digest.

**Rejected alternative.** A generated mod under `.factorio-runtime/mods/` was the obvious design and is worse: it changes the mod set the save is loaded with, which risks a mismatch refusal on exactly the saves a player actually has. The save's own script is already there and already runs.

**One rate, measured rather than assumed.** `LuaFlowStatistics.get_flow_count` returns a rate, not a total, and its unit is per minute. The same call on `iron-plate` over the one-hour window gave 113774.95 with `count = true` and 1896.249 without, and 113774.95 / 60 = 1896.249 exactly. Cumulative totals come from `input_counts` and `output_counts`, which are unambiguous.

Two engine constants are declared here, in the ADR-3 sense: `TICKS_PER_SECOND` at 60, to turn a tick count into hours played, and `BENCHMARK_TICKS` at 60, which is a choice rather than a game fact and is commented as one. The collector reports what the game says and computes nothing the snapshot could compute instead.

**What this does not do.** It reads a save on disk, so it is as fresh as the last time the game saved, not as fresh as the running game. Nothing here connects to a live session.

## ADR-7: power is priced from the census, and the solar average is read rather than remembered

`power` joins the machine census ADR-6 returns to the energy fields in the snapshot. Generation by source, the steam chain, accumulator capacity, and the draw of every electric consumer.

**Every watt is derived, and the derivation is printed.** A steam engine is `fluid_usage_per_tick 0.5 x 60 x (maximum_temperature 165 - steam default_temperature 15) x heat_capacity 0.2kJ x effectivity 1`, which is 900 kW. The output column names those fields so a reader can redo the arithmetic against `data-raw.json` without asking anyone.

**Two probes of different shape, before a line was written.** The prototype strings were cross-checked against the engine's own runtime values, read through the ADR-6 mechanism: `steam-engine.max_power_output` is 15000 J per tick, which is the same 900 kW; `assembling-machine-2.energy_usage` is 2500 J per tick, which is the 150 kW the prototype declares. The snapshot alone is sufficient, and the runtime agrees with it. That check also settled the boiler, where two readings of the heat-capacity rule were available and only one is right: a unit of 165 degree steam carries 30 kJ, because an engine consuming 30 units a second produces exactly 900 kW. So a 1.8 MW boiler emits 60 units a second and feeds two engines.

**The solar average is not the remembered 70 percent.** It is computed from the curve, and the curve is read from the game. The cycle length is a prototype field: `planet.surface_properties.day-night-cycle`, 25200 ticks on Nauvis and different on every planet. The curve itself (`dusk`, `evening`, `morning`, `dawn`) is a runtime surface property rather than a prototype field, so ADR-6's collector was extended to record it. Lit from dawn round through 0 to dusk, dark from evening to morning, linear between, so the ramps average a half. On Nauvis that yields 0.7. It happens to match the figure every player knows, which is the point: the number is now sourced instead of recalled, and on Vulcanus or Aquilo it will differ because their curves do.

A state file written before the curve was collected has no curve. That case prints peak only and says why, rather than falling back to a constant.

**Nameplate is not capacity.** Counting every engine built overstates generation when the boilers cannot make enough steam for them. The steam-limited figure is computed and the balance is drawn against it, with the gap named. On the save this was built against, 407 engines are built and 115 boilers can feed 230 of them, so 177 engines have no boiler behind them.

**The census class list is derived, and that is the whole lesson of U3b.** The first version named twelve entity classes by hand and omitted inserter, roboport, radar, lamp, pump, electric-turret and accumulator. The draw figure called itself a ceiling with everything running, and was short by 73 MW on the base it was built against, with 5521 inserters and 645 accumulators simply absent. A hand-written list cannot fail safely, because nothing warns you about the class you did not think of. The collector now asks the running game for every entity class declaring an energy source of any kind, which on this snapshot is 31 classes, and counts those. A class added by a future version arrives on its own.

**Drain is copied from the engine, not inferred.** The obvious rule, a thirtieth of usage where the prototype omits `drain`, is correct for an assembling machine and wrong for a radar: measured, `radar.energy_usage` is 5000 J per tick with drain 0, while `assembling-machine-2` is 2500 J per tick with drain 83.33, which is exactly usage/30. One rule cannot give both, so the collector records what the engine resolved and the report copies it. Where a state file predates that, the old inference is used and the output says so.

**Per-event draw is separated, not converted.** An inserter spends `energy_per_movement` per swing and a radar `energy_per_sector` per scan. Their idle drain is continuous and is counted; the per-event cost is reported in its own table and excluded from the total, because a rate of swings per second is exactly the quantity ADR-3 already refuses to invent for inserter throughput. These fields come from the snapshot rather than the runtime, which was checked: the runtime does not expose them under those names.

**What is still not modelled**, and is printed as such: what the grid actually delivered, which is a runtime figure; and the draw figure is a ceiling, since no base runs every machine at once.

## ADR-8: what the grid did, not only what it could

ADR-7 priced the base from prototype fields, and every one of its footers had to apologise for the same thing: nameplate capacity is not delivered power. The collector now reads the game's own electric network statistics, so it no longer has to.

**Per network, then summed.** A base has several electric networks (four on the save this was built against), and the statistics live on each. Every distinct network on every surface is visited through its poles and the flows are summed.

**The unit was measured, not assumed.** The figures are joules per tick. `count = true`, which for item statistics returns a total, here returns the number of contributing entities instead, so the trick that settled the item flow unit does not transfer. What settles it is a machine with a known duty cycle: a radar scans continuously at 300 kW, and 34 of them report 169041, which times 60 is 10.14 MW against a nameplate 10.2 MW. No other reading of the unit survives that. The result is checkable by anyone: on this save production and consumption both come to 112 MW, and an electric network that did not balance would be a bug in the reading.

**Everything else in this unit is a copy.** Lab speed modifier, research progress, evolution factor, surface pollution and logistic network contents are read from the Lua API and written out unchanged. The one derived figure is lab speed as a multiplier, and even that was checked rather than assumed: `laboratory_speed_modifier` is 1.9, the five researched `research-speed` technologies declare +0.2, +0.3, +0.4, +0.5 and +0.5, and those sum to exactly 1.9, so the field is a bonus and a lab runs at 2.9 times base.

**Additive by design.** Every field this adds is optional, so a state file written before it still works and the commands that do not need it are unchanged. Where a figure is missing the output says so rather than falling back to a guess.

## ADR-9: the generator lays out one row, and every coordinate is measured

`gen` emits a blueprint string for ONE recipe step. Not a chain, not a bus. A row of machines with an input belt above, an output belt below, and an inserter per machine per side.

**Why one step.** A row is the largest shape whose geometry is fully determined by the prototypes. Once a second recipe joins, where the two rows sit relative to each other is a layout opinion, and this project has no source for opinions. `ratio` already answers what a chain needs; `gen` answers what one step looks like on the ground.

**Two placement facts, both measured against the shipped 83-entity platform print before any code was written.**

The tile footprint is `selection_box`, not `collision_box`. Collision boxes are inset so entities can be walked past: a 2x2 turret collides over 1.4 tiles and a 3x3 assembler over 2.4. The selection box gives 2x2 and 3x3 exactly, which is the footprint a blueprint needs.

Position parity follows footprint parity. An odd dimension sits at a half coordinate, the centre of a tile; an even one sits at an integer, the seam between two. Checked against every entity in that print, and it holds 83 of 83.

**Factorio 2.0 has sixteen directions**, so North is 0, East 4, South 8 and West 12. This was measured, not recalled, and the measurement mattered: under the old eight-direction reading the parity rule failed on six entities. Treating 4 and 12 as the axes that swap width and height brings it to 83 of 83, and the print contains only 0, 4, 8 and 12. Emitting `2` for east, which the 1.x convention would have suggested, would have produced prints that place wrong.

**An inserter's direction names the side it picks up FROM.** Measured, after the first version of ADR-9 assumed the opposite and shipped every row with both inserters reversed. Asked of the engine: an inserter at direction 0 (north) reports `pickup_position` at y-1 and `drop_position` at y+1.2; direction 4 (east) picks up at x+1 and drops at x-1.2; 8 and 12 are their mirrors. So a north-facing inserter moves items southward.

The consequence was a row that read correctly and did nothing. Its input inserter picked up inside the machine and dropped on the input belt; its output inserter took from the output belt and fed it back into the machine. Both inserters in every generated row now face north, because both carry items southward across the row: belt to machine above, machine to belt below.

Nothing static could have caught it. The entity census, the ratios, the belt saturation and the decode round-trip are all indifferent to which way an inserter faces, and all four passed on the broken row. That is the argument for ADR-5 level three in one example, and the sandbox found it on its first run.

**Two engine facts found the same night, kept because each cost a run.** `require` works only while a scenario's `control.lua` is being parsed: called inside an event handler it raises "Require can't be used outside of control.lua parsing" and kills the run, so anything a handler needs is required at the top and closed over. And `electromagnetic-plant` is 4x4, not the 3x3 it resembles; `footprintOf` reads that correctly from `selection_box`, which is exactly why footprints are read rather than remembered.

**A missing field is a gap, never a constant.** A prototype with no `selection_box` has an unknown footprint, so nothing is placed for it and the omission is printed. Inventing a size would put entities in the wrong tiles, which is worse than placing nothing.

**Fractional machines round up** (decided with Soushi, 2026-09-05). A player building to a target wants the target met and reads surplus as headroom, so the row overbuilds and prints the overcapacity, which also goes into the blueprint label so it survives into the game. `--machines=<n>` pins a count instead and states the resulting rate, which can be a shortfall and is labelled as one. The belt tier is chosen for the rounded-up rate, and a row that outruns its belt prints a warning rather than a quiet 140 percent.

**The input side is sized and never silently ignored.** A row's ingredient demand comes from the same run the output does, so the auditor re-derives it from the entities. Eight electromagnetic plants pull 128 items a second, which is 213 percent of one turbo belt and therefore three input lanes. The row lays ONE, prints the number needed, and says the rest is the player's to route: where a second lane goes is a layout opinion and this tool has no source for opinions.

**The inserter tier is chosen by its ceiling.** The first version placed whatever came first in the list, a basic inserter at 0.84/s, against sixteen items a second of demand. The tier is now the cheapest whose rotation ceiling covers the busier side, and when none covers it, which is the usual case at these rates, the output says so rather than shipping a row that cannot move its own throughput.

**The generator checks itself against the auditor.** `gen` and `bp --rate` share no code path: one lays entities out from the solver, the other reads entities back and re-derives their rates. Running the second over the first's output is therefore a real test rather than a tautology, and it is the unit's own acceptance criterion. On `electronic-circuit --rate=45` the generator places 12 machines for an exact 11.25, and the auditor independently recovers 48/s and 11.25.

**Worktrees share `data/` by symlink.** The snapshot is gitignored, so a worktree has none until it is linked from the main tree. That link is read-only in practice and must stay so: `bun run state` writes `data/state/<save>.json`, and two trees writing it at once would corrupt what the other reads. `.gitignore` carries `/data` and `/.local` because a trailing-slash pattern does not match a symlink.

## Module map

Bottom up, one data flow, mirroring the sibling project.

```
paths.ts     locate the Steam install, the binary, the user dir; FACTORIO_CORE / FACTORIO_USERDATA override
dump.ts      generate the isolated config, run --dump-data, write data/ + manifest
energy.ts    parse "375kW", "1.5MW", "0.2kJ" into watts and joules
proto.ts     load the snapshot once, index it, typed accessors per prototype class
recipes.ts   normalise ingredients and results, index by product, resolve which recipe makes what
machines.ts  which machines serve a recipe category, effective speed under modules and beacons, power, pollution
solve.ts     target rate -> machine counts, raw inputs, byproducts, power, pollution
belts.ts     belt and inserter throughput, saturation
tech.ts      prerequisite closure, cumulative science cost, what unlocks a recipe, research path
blueprint.ts decode and encode blueprint strings
state.ts     copy a save, inject a collector, run the engine, read live state back
next.ts      intersect the tech tree with what a save says is already researched
target.ts    judge an audited print against a target rate
layout.ts    lay one recipe step out as a row and emit a blueprint string
power.ts     generation, steam chain and draw, priced from the machine census
audit.ts     entity census, ratio check against the solver, belt saturation, module and beacon coverage
render.ts    tables and trees for the terminal
cli.ts       the only entry point and the only place that formats output
```

`proto.ts` is the choke point every other module reads through, the way `save.ts` is in the sibling project.

## Commands

```bash
bun run sync                              # refresh the prototype snapshot
bun run search plate                      # find prototypes by name or type
bun run recipe electronic-circuit         # ingredients, results, makers, unlocking tech
bun run ratio science --rate=1.5          # full chain for 1.5/s, machine counts, raw inputs, power
bun run ratio plastic-bar --rate=90/m --machine=assembling-machine-3 --modules=productivity-module-3
bun run tech logistics-3                  # cost, prerequisites, unlocks
bun run tech --path=kovarex-enrichment-process   # full research path with cumulative science
bun run belt iron-plate --rate=45         # belts and inserters needed, saturation
bun run bp --file=blueprint.txt           # decode and audit a blueprint
bun run state --save "game 4"             # live state read from a copy of a save
bun run next                              # what is researchable now, from that state
bun run next --for=carbon-fiber           # the unresearched path to what unlocks an item
bun run power                             # generation against draw, from the census
bun run gen electronic-circuit --rate=45  # one recipe step as a placeable row
bun run typecheck
```

## Constraints that must hold

- **Read-only, and stricter than "does not corrupt".** No writes anywhere under `~/.factorio` or the Steam install. No save of the player's is opened in place; `state` reads a copy. No mod is installed. The engine runs once per `sync` and once per `state`, headless, with its write-data redirected into this project.
- **No hardcoded game statistics.** Only the declared engine constants of ADR-3 and ADR-6, each named and commented at its definition.
- **Never state a game fact without the snapshot behind it.** Every command prints the snapshot's game version and dump date in its header, the way the sibling prints the save name.
- Strict TypeScript with `noUncheckedIndexedAccess`.
- Bun only, never npm.

## Deliberately out of scope

Modded runs. The snapshot is vanilla Space Age by construction, and a state read reports whatever the save contains without interpreting mod prototypes it has never seen.
