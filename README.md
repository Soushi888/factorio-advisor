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

### bp

Feed it a blueprint string from a file, an argument, or stdin. Books are unrolled. The audit resolves every machine's real module loadout, works out which beacons physically reach it from the positions in the print, runs each machine, and nets the flows: what the print needs fed in, what it exports, and what it balances internally.

## What it will not do

**Read the live game.** `level.dat` is undocumented binary. Getting live state would need a helper mod writing to `script-output`, or RCON, which is a different trust posture and a deliberate non-goal.

**Invent a number it cannot read.** Two places where this bites, both reported in the output rather than papered over:

- Inserter throughput. The tool reports the rotation-bound ceiling from `rotation_speed` and says plainly that real throughput depends on belt chasing and the inserter capacity research, which are not prototype facts.
- Quality-scaled module effects. Quality raises a module's effect in game, but the scaling is an engine rule absent from the prototype data. A blueprint using quality modules gets a warning that the figures understate it.

**Guess at your tech level.** `ratio` defaults to the fastest machine that can run each category, which on a Space Age snapshot means foundries and electromagnetic plants. Use `--machine` for the tier you actually have.

## How it is put together

```
paths.ts     find the install and the binary; FACTORIO_CORE / FACTORIO_USERDATA override
dump.ts      the only module that runs Factorio, with write-data redirected into this project
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
