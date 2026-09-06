# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only advisory toolkit for a vanilla Factorio 2.0 Space Age playthrough. It reads the game's declared prototype data and answers ratio, technology and throughput questions, it audits blueprint strings, and since tier C it reads the state of a save (research, production rates, machine census) by letting the engine tick a copy of it. Soushi plays every minute himself; the tools never send input to the game, never open his save in place, and never write to a game directory.

Sibling of `wesnoth-advisor` and deliberately shaped like it, with one structural difference that drives the whole design: a Wesnoth save is plain WML text, so that tool reads the live board, while a Factorio save is version-locked binary, so this one reads what the game declares before a map exists, and asks the engine itself to report on a save rather than parsing one.

## Commands

```bash
bun run sync                              # refresh the prototype snapshot. Launches Factorio headless.
bun run state --save "game 4"             # research, production rates, machine census from a COPY of a save. Launches Factorio headless.
bun run next                              # what is researchable right now, from the last state read.
bun run next --for=carbon-fiber           # the unresearched path from here to what unlocks an item or tech.
bun run power                             # generation against draw, priced from the census the last state read returned.
bun run search asteroid                   # find prototypes by name across every class
bun run recipe rocket-fuel                # ingredients, results, every machine that can run it, unlocking tech
bun run ratio processing-unit --rate=5    # full production chain, machine counts, raw inputs, power, pollution
bun run tech kovarex --path               # cost, prerequisites, the whole research path with totals
bun run belt iron-plate --rate=45         # belt tier saturation, inserter rotation ceilings
bun run bp --file=blueprint.txt           # decode and audit a blueprint string or book
bun run typecheck                         # tsc --noEmit
```

There is no test suite. Verification is hand-checking tool output against the raw prototype JSON with `jq`, and since tier C also against the engine's own runtime values read through the save copy. That is how all four real defects so far were found: recycling recipes as sources, NaN machine speeds, a hand-named census that missed 73 MW of draw, and a usage/30 drain rule the engine contradicts for radars. Game locations are auto-detected and overridable with `FACTORIO_CORE` and `FACTORIO_USERDATA` (see `src/paths.ts`).

## Architecture

One data flow, bottom up:

`paths.ts` locates the Steam install and the binary, and defines the only paths this project writes to, all under the project root: `data/` (snapshot, `manifest.json`, and `state/<save>.json`) and `.factorio-runtime/` (the engine's redirected write-data, config, and save copies).

`dump.ts` runs Factorio for the prototype dump, and `state.ts` reuses its isolated config to run it over a save copy. The load-bearing trick: `--dump-data` normally writes into `~/.factorio/script-output`, which would break the read-only property, so `dump.ts` generates a `config.ini` setting `read-data` to the Steam install and `write-data` to `.factorio-runtime/` inside this project, and passes it with `--config`. A fresh write-data also means a freshly generated `mod-list.json`, which is why the snapshot is vanilla Space Age no matter what Soushi has installed. The manifest's version and mod set are parsed out of the run's own log, not assumed.

`proto.ts` loads the 27.8 MB snapshot once and indexes it. Prototype classes are grouped by the fields they carry, not by a hardcoded list of class names: item classes are the ones declaring `stack_size`, crafting machines are the ones declaring both `crafting_categories` and a numeric `crafting_speed`. That last check matters, because `character` and `god-controller` declare categories with a null speed and would otherwise poison every machine count with NaN.

`energy.ts` parses the suffixed strings the prototypes use for every watt and joule (`375kW`, `1.5MW`, `0.2kJ`) into numbers, and keeps power and energy as distinct quantities because the unit letter says which one a field is. Every figure in `machines.ts`, `power.ts` and the state collector's prototype reads goes through it.

`recipes.ts` normalises ingredients and results, folding `amount_min`/`amount_max`, `probability` and `extra_count_fraction` into one expected amount, and owns the two rules that make the solver sane. First, **310 of the 659 recipes are recycling recipes**, and since a recycler returns a quarter of what went in, every one of them lists its ingredients as outputs; left in, the solver proposes making iron ore by recycling iron ore, which it did on the first run. Categories `recycling` and `parameters` are excluded from recipe selection but stay queryable. Second, **the raw-material set is derived, not listed**: every product a `resource` prototype yields when mined, plus every fluid a `tile` prototype carries for an offshore pump.

The default-recipe rule is ordered and stated in the output: main product over byproduct, then shallower chain to raw, then earlier in the tech tree, then fewer ingredients. The tech-tree term is what separates `copper-cable` from `casting-copper-cable`, which tie on everything else; without it the tie fell to alphabetical order.

`machines.ts` resolves effective speed under modules and beacons. A beacon transmits each module at `distribution_effectivity` scaled by `profile[n-1]`, where n is the number of beacons reaching the machine and `profile` is the Space Age falloff curve read off the prototype.

`solve.ts` walks the graph twice: depth first to choose recipes and cut cycles, then reverse topological to size them. The second pass is what lets a byproduct cancel demand for the same product further down instead of quietly building a second line for it. Cycles are reported, never unrolled.

`belts.ts` computes belt throughput exactly from `speed * 60 / 0.25 * 2`, and deliberately refuses to predict inserter throughput, reporting a rotation-bound ceiling with the reasons stated.

`tech.ts` owns the technology graph: `costOf` folds a technology's unit cost, count or count formula, and `research_trigger` into one `TechCost`; `researchPath` orders the prerequisite closure of a target so it is researchable in sequence; `totalCost` sums packs and lab-seconds over a path; `unlocksOf`, `dependents` and `labsFor` answer what a technology opens, what needs it, and which labs accept its packs. `bun run tech` reads it directly and `next.ts` reuses it with the researched set subtracted, so a path or a cost is computed in exactly one place.

`blueprint.ts` decodes the documented string format (version byte, base64, zlib, JSON) and reads both the 2.0 nested `items` shape and the 1.x flat map. The local `blueprint-storage-2.dat` is binary and is never read.

`audit.ts` resolves each machine's real loadout, works out which beacons physically reach it from the selection boxes and positions, and nets the flows so the print's own bottleneck shows up.

`state.ts` is tier C. It copies the named save into `.factorio-runtime/saves/`, appends a collector to the copy's own `control.lua` (no mod, so the mod set the save was made with is unchanged and a modded save still loads), runs the binary with `--benchmark` on the copy under the same redirected write-data, and parses the JSON the collector wrote into `data/state/<save>.json`. Production rates come from `get_flow_count`, measured to be per minute (ADR-6), never assumed. The player's save is never opened in place. Freshness is the last save on disk, not the running session.

`next.ts` is a set operation between the technology graph and the researched set a state file reports: a technology is researchable exactly when it is unresearched and every prerequisite is researched. `--for=` walks the prerequisite closure of the target and subtracts what is done. Technology names the snapshot does not know are listed, never dropped.

`power.ts` joins the census a state read returned to the energy fields in the snapshot (ADR-7). Generation per source is derived and the derivation is printed in the row; the steam chain is priced from boiler consumption and engine fluid usage against steam's declared heat capacity; the solar average is computed from the day-night curve the collector records on the surface, never from a remembered factor. The census class list is derived from every prototype declaring an energy source, and usage, drain and buffer per class are the engine's own resolved values copied from the collector, because no single drain rule matches both an assembling machine and a radar. Per-event draws (inserter movements, radar sectors) are named in their own table and never converted to watts.

`render.ts` formats tables. `cli.ts` is the only entry point and the only place that formats output.

## Constraints that must hold

- **Read-only.** No write anywhere outside the project root. `ISA.md` anti-claim A1 is the falsifier, and it is checked with `find ~/.factorio -newermt`, not by reading the code.
- **No hardcoded game statistics.** Every number comes from the snapshot or from what the engine reports about a save. The only literals in lookup paths are the declared constants, each named and commented at its definition. The inventory is produced, never typed: `grep -rnE "^(export )?const [A-Z][A-Z_]+ = [0-9.]+" src/`, and `ISA.md` anti-claim A2 records what that grep returned at the last verified commit (ten distinct names across `proto.ts`, `machines.ts`, `belts.ts`, `state.ts` and `power.ts`, one of them, `BENCHMARK_TICKS`, a commented choice rather than a game fact). A count typed into a document rotted twice in one evening; run the grep.
- **Never invent a number the data cannot support.** Inserter throughput beyond the rotation ceiling, and quality-scaled module effects, are both gaps. They are reported as gaps in the command output. Adding a plausible multiplier for either is a regression, not a feature.
- **Never state a game fact without naming the snapshot.** Every command prints the version, build, mod set and dump date in its header.
- Strict TypeScript with `noUncheckedIndexedAccess`; index access needs `!` or a guard.
- bun always, never npm.

## Working in this repo

When a claim about the game turns out to be wrong, verify against the snapshot with `jq` before changing anything, and cite the prototype path in the fix. `DESIGN.md` holds the decisions and their rationale; `ISA.md` is the state of record and its "Not yet specified" section is the real backlog. Tier C was decided by Soushi on 2026-09-05: the save copy (ADR-6), not a helper mod in his game and not RCON. Reading the running session rather than the last save stays parked unless save freshness turns out to be the bottleneck while playing. Changes land as reviewed units: the builder session owns `src/` and commits, the PM session owns the ISA, claims and verdicts, and the ledger under `.local/convene/` is the record.
