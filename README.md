# factorio-advisor

A read-only advisory toolkit for a vanilla Factorio 2.0 Space Age playthrough. It answers ratio, technology and throughput questions from the game's own declared numbers, audits blueprint strings, and reads the state of your base out of a copy of your save. It never touches your saves, your mods or your config.

Sibling of `wesnoth-advisor`, with one structural difference. A Wesnoth save is plain text, so that tool reads the live board directly. A Factorio save is a version-locked binary blob, so this one works from two sources instead: what the game declares before a map exists (every recipe, machine, module, technology, belt and quality tier), and what the engine itself reports when asked to tick a copy of your save. Between them they cover the questions Factorio actually provokes.

## Quick start

```bash
bun install
bun run sync                              # once, and again after a game update
bun run ratio electronic-circuit --rate=45
```

`sync` launches Factorio headless for about three seconds with its write-data redirected into this project, so the dump lands in `data/` and `~/.factorio` is never written to.

Two commands launch the engine: `sync`, and `state`, which additionally copies your save and reads the copy. Everything else reads what those two wrote and launches nothing. Neither ever writes to a game directory, and the probe that proves it is in `bun run state`'s own section below.

To ask about your actual base, save in game (or let an autosave fire) and then:

```bash
bun run state                             # reads your newest save, autosaves included
bun run next                              # what you can research now
bun run power                             # generation against draw
```

## Commands

```bash
bun run sync                              # refresh the prototype snapshot
bun run search asteroid                   # find prototypes by name
bun run recipe rocket-fuel                # ingredients, results, every machine that can run it
bun run ratio processing-unit --rate=5    # full production chain, machine counts, power, raw inputs
bun run tech kovarex --path               # cost, prerequisites, the whole research path with totals
bun run belt iron-plate --rate=45         # which belt tier carries it, and at what saturation
bun run bp --file=blueprint.txt           # decode and audit a blueprint string
bun run bp --file=bp.txt --rate=45        # judge that print against a target rate
bun run state --save "game 4"             # live state, read from a copy of your save
bun run next                              # what you can research right now
bun run next --for=carbon-fiber           # the path from here to what unlocks an item
bun run power                             # generation against draw, from your census
bun run gen electronic-circuit --rate=45  # one recipe step, laid out as a placeable row
bun run typecheck
```

### ratio

```bash
bun run ratio plastic-bar --rate=90/m
bun run ratio plastic-bar --rate=30 --recipe=petroleum-gas=advanced-oil-processing
bun run ratio electronic-circuit --rate=45 --machine=assembling-machine-3 --modules=productivity-module-3x4 --beacons=8
```

| Flag | Meaning |
|---|---|
| `--rate=45` / `90/m` / `5400/h` | target output rate |
| `--machine=<name>` | prefer this machine wherever it can run the category |
| `--modules=<name>x<n>,...` | modules in every machine; what does not fit is reported |
| `--beacons=<n>` `--beacon-modules=<spec>` | beacons reaching each machine, with the Space Age falloff profile applied |
| `--recipe=<product>=<recipe>` | override a recipe choice |
| `--raw=iron-plate,copper-plate` | treat these as bought in and stop expanding there |

The solver states its own choices. When a product has several recipes it names the ones it declined and prints the flag that would switch them, so a default you disagree with is one flag away rather than buried.

### state

```bash
bun run state --save "game 4"        # the save name as it appears in your save list
bun run state --save "game 4" --top=20 --force=player
```

Reports what your base has actually done: how many technologies are researched, what is being researched now and what is queued behind it, the items and fluids you produce with their one-hour average rate and their lifetime totals, every machine you have placed counted by prototype, evolution and pollution per surface, and what is sitting in your logistic network.

With no `--save` it reads the newest save in your save directory, autosaves included, so the loop is: save in game, then ask.

It works by copying your save into `.factorio-runtime/saves/`, appending a collector to the copy's own `control.lua`, and running the engine against the copy in benchmark mode. Your save is never opened in place and never written back. No mod is installed, so a save made with mods still loads.

Rates are the game's own one-hour average expressed in items per minute. Totals are cumulative since the map was created. The parsed result is written to `data/state/<save>.json`, shaped like this, so other commands can build on it:

```
{ snapshot: { gameVersion, build, mods, dumpedAt },
  save:     { name, copiedFrom, tick, hoursPlayed, surfaces, readAt },
  forces:   { <force>: { technologies: { researched[], current, queue[] },
                         production:  { item:  { <name>: { input, output, perMinute } },
                                        fluid: { <name>: { input, output, perMinute } } },
                         machines:    { <prototype>: count } } } }
```

### next

```bash
bun run next                         # everything researchable right now, cheapest first
bun run next --for=carbon-fiber      # the path from where you are to that item
bun run next --for=kovarex-enrichment-process   # a technology name works too
bun run next --save "game 4" --top=40 --force=player
```

Reads the state file `bun run state` wrote and intersects it with the technology tree. A technology is listed exactly when it is not researched and every one of its prerequisites is. Nothing is ranked by taste: the table is sorted by lab-seconds, and `opens` says how many further technologies each one unblocks, so a cheap tech that opens six others is visible as such.

Lab-seconds are given twice: at speed 1, and at your actual lab speed read from the save, which is the number that tells you how long a technology will really take. Research progress on the current technology is printed too.

`--for` takes an item or a technology. Given an item, it finds which technology gates it, says which recipe that is via, lists the alternatives when several would do, and then prints only the part of the path you have not already researched, with the science totals for what is left.

Trigger technologies are shown as the action they want rather than as zero cost, because in Space Age a good deal of progress is unlocked by doing rather than by researching. Lab-seconds are at speed 1, before lab speed and productivity, which are live game facts this tool does not read.

If a save carries technologies this snapshot has never heard of, from another version or a modded run, they are listed rather than dropped. A silently shorter answer would look exactly like a correct one.

### power

```bash
bun run power                        # uses your newest save's state
bun run power --save="game 4"        # or a named one
```

Prices your base two ways. **Delivered** is what your grid actually did over the last hour, copied from the game's own electric network statistics across every network you have, so it is measurement rather than arithmetic. **Draw** is the ceiling if every machine ran at once, priced from the machine census. The gap between them is duty cycle.

Then the rest, from the census: Generation by source with the prototype fields each figure came from, the steam chain and whether your boilers can actually feed your engines, accumulator capacity, and the draw of every machine type if all of them ran at once.

Every watt is derived, and the `derived from` column tells you how, so you can redo any of it by hand from `data/data-raw.json`. A steam engine, for instance, is `fluid_usage_per_tick 0.5 x 60 ticks x (maximum_temperature 165 minus steam's default_temperature 15) x steam heat_capacity 0.2kJ x effectivity 1`, which is 900 kW.

Solar reports both peak and the average over a day-night cycle, and the average is not a remembered constant. The cycle length is a prototype field (`planet.surface_properties.day-night-cycle`, 25200 ticks on Nauvis) and the curve itself is read off the surface when `state` runs. Lit from dawn round to dusk, dark from evening to morning, linear between, which on Nauvis gives 0.7. If you are reading an older state file that predates the curve being collected, it says so and reports peak only rather than inventing a factor.

The census counts every entity class the game declares with an energy source of any kind, and that list is read off the running game rather than typed here. The first version listed twelve classes by hand and silently missed inserters, roboports, radars, lamps, pumps, turrets and accumulators, which understated the draw ceiling by 73 MW on a real base. A hand-written list cannot fail safely: nothing warns you about the class you forgot.

Drain is copied from the engine, not inferred. A radar declaring no drain resolves to zero; an assembling machine declaring none resolves to a thirtieth of its usage. No single rule produces both, so no rule is applied.

Some machines draw per event rather than per second. An inserter spends `energy_per_movement` on each swing, a radar `energy_per_sector` on each scan. Their idle drain is in the total, because it is paid every tick, but the per-event cost is listed separately and left out, since converting it to watts needs a swings-per-second that no prototype declares. That is the same wall the inserter throughput figure hits, and it is not worth guessing past.

Three honest limits, all printed. Draw is a ceiling, since no base runs every machine at once. Generation is nameplate capacity, not what your grid actually delivered, which is a runtime figure this tool does not read yet. And where the boilers cannot feed the engines built, the steam-limited figure is computed and the balance drawn against that, because the nameplate number would otherwise be a fiction.

### gen

```bash
bun run gen electronic-circuit --rate=45
bun run gen iron-plate --rate=100 --belt=fast-transport-belt
bun run gen electronic-circuit --rate=45 --machines=8    # pin the count instead
```

Lays ONE recipe step out as a row and prints a blueprint string you can paste into the game: machines side by side, an input belt above, an output belt below, an inserter per machine per side. The string is printed last and alone, so it is easy to copy.

Machine counts round up, so the row meets the target and the overcapacity is printed and written into the blueprint label, where it survives into your game. `--machines=<n>` pins a count instead and tells you the rate that gives, shortfall included. The belt tier is picked for the rounded-up rate, and a row that outruns its belt says so rather than quietly running at 140%.

Every coordinate comes from the prototypes. Footprints are read from `selection_box`, which is the real tile size, rather than `collision_box`, which is inset so you can walk past things. A prototype with no selection box gets nothing placed and the gap is printed, because a guessed size puts entities in the wrong tiles.

Both sides are sized. The output belt tier is picked for the rounded-up rate, and the input demand is computed from the recipe and reported per ingredient, with the number of input lanes the row would need. The row lays one lane each way and tells you when that is not enough, rather than drawing a picture that cannot run. Inserters are picked by rotation ceiling, and when no tier in the game keeps up with the row's throughput, it says that too.

One step only. A whole chain or a main bus is out of scope and the output says so; `bun run ratio` is what sizes a chain. Check a generated row the same way you would check anyone else's: `bun run bp --rate=<same>` reads it back and re-derives its rates through a different code path.

### bp

With `--rate=<n[/s|/m|/h]>` the audit stops describing the print and starts judging it: what fraction of the target it reaches, how many of the print the target would take, what that scale means per machine type, whether the belt tier it places carries the target, and how many inserters per machine the target needs at the rotation ceiling. `--item=<name>` picks which product to judge; without it the print's largest net export is used and the output says so.

A print scales as a unit, so every step scales with it, including steps that make none of the target item. The output says that too, because the alternative is a column that reads like a per-recipe requirement and is not one. To size a single recipe rather than a whole print, use `bun run ratio`.

Without `--rate` the output is exactly what it was before the flag existed.

Feed it a blueprint string from a file, an argument, or stdin. Books are unrolled. The audit resolves every machine's real module loadout, works out which beacons physically reach it from the positions in the print, runs each machine, and nets the flows: what the print needs fed in, what it exports, and what it balances internally.

## What it will not do

**Touch your game.** Not the install, not `~/.factorio`, not your saves, not your mods, not your blueprint library. `sync` and `state` both launch Factorio headless with its write-data redirected into this project, and `state` reads a *copy* of your save rather than the save itself. After a full run, `find ~/.factorio -newermt "<run start>"` and the same over the Steam install both come back empty. That probe is the anti-claim, and it is checked by running it, not by reading the code.

**Read a running game.** `state` reads a save on disk, so it is as fresh as your last save, not as fresh as the session you are playing right now. Nothing here connects to a live game or sends it input.

**Invent a number it cannot read.** Two places where this bites, both reported in the output rather than papered over:

- Inserter throughput. The tool reports the rotation-bound ceiling from `rotation_speed` and says plainly that real throughput depends on belt chasing and the inserter capacity research, which are not prototype facts.
- Quality-scaled module effects. Quality raises a module's effect in game, but the scaling is an engine rule absent from the prototype data. A blueprint using quality modules gets a warning that the figures understate it.

**Guess at your tech level.** `ratio` defaults to the fastest machine that can run each category, which on a Space Age snapshot means foundries and electromagnetic plants. Use `--machine` for the tier you actually have.

## How it is put together

```
paths.ts     find the install and the binary; FACTORIO_CORE / FACTORIO_USERDATA override
dump.ts      runs Factorio for the prototype dump, with write-data redirected into this project
state.ts     runs Factorio over a copy of a save to read live state back
next.ts      intersects the tech tree with what a save says is already researched
power.ts     generation, steam chain and draw, priced from the machine census
target.ts    judges an audited print against a target rate
layout.ts    lays one recipe step out as a row and emits a blueprint string
proto.ts     load and index the snapshot; every other module reads through here
energy.ts    parse "375kW", "1.5MW", "0.2kJ"
recipes.ts   normalise recipes, index by product, choose a default and justify it
machines.ts  machines for a category, effective speed under modules and beacons, power, pollution
solve.ts     target rate to machine counts, raw inputs, byproducts, power, pollution
belts.ts     belt throughput (exact) and inserter ceilings (labelled as ceilings)
tech.ts      prerequisite closure, science cost, research paths, trigger technologies
blueprint.ts decode and encode blueprint strings
audit.ts     entity census, beacon geometry, net flow analysis
render.ts    tables for the terminal
cli.ts       the only entry point and the only place that formats output
```

Design rationale and the decisions behind it are in `DESIGN.md`. What "done" means, with falsifiers, is in `ISA.md`.
