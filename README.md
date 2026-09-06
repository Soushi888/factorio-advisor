# factorio-advisor

A read-only advisory toolkit for a vanilla Factorio 2.0 Space Age playthrough. It answers ratio, technology and throughput questions from the game's own declared numbers, and audits blueprint strings. It never touches your saves, your mods or your config.

Sibling of `wesnoth-advisor`, with one structural difference. A Wesnoth save is plain text, so that tool reads the live board. A Factorio save is a version-locked binary blob, so this one reads what the game declares before a map exists: every recipe, machine, module, technology, belt and quality tier. That turns out to cover the questions Factorio actually provokes.

## Quick start

```bash
bun install
bun run sync                              # once, and again after a game update
bun run ratio electronic-circuit --rate=45
```

`sync` launches Factorio headless for about three seconds with its write-data redirected into this project, so the dump lands in `data/` and `~/.factorio` is never written to. Every other command reads that snapshot and never launches anything.

## Commands

```bash
bun run sync                              # refresh the prototype snapshot
bun run search asteroid                   # find prototypes by name
bun run recipe rocket-fuel                # ingredients, results, every machine that can run it
bun run ratio processing-unit --rate=5    # full production chain, machine counts, power, raw inputs
bun run tech kovarex --path               # cost, prerequisites, the whole research path with totals
bun run belt iron-plate --rate=45         # which belt tier carries it, and at what saturation
bun run bp --file=blueprint.txt           # decode and audit a blueprint string
bun run state --save "game 4"             # live state, read from a copy of your save
bun run next                              # what you can research right now
bun run next --for=carbon-fiber           # the path from here to what unlocks an item
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

Reports what your base has actually done: how many technologies are researched, what is being researched now and what is queued behind it, the items and fluids you produce with their one-hour average rate and their lifetime totals, and every machine you have placed counted by prototype.

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

`--for` takes an item or a technology. Given an item, it finds which technology gates it, says which recipe that is via, lists the alternatives when several would do, and then prints only the part of the path you have not already researched, with the science totals for what is left.

Trigger technologies are shown as the action they want rather than as zero cost, because in Space Age a good deal of progress is unlocked by doing rather than by researching. Lab-seconds are at speed 1, before lab speed and productivity, which are live game facts this tool does not read.

If a save carries technologies this snapshot has never heard of, from another version or a modded run, they are listed rather than dropped. A silently shorter answer would look exactly like a correct one.

### bp

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
