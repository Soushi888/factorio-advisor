# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only advisory toolkit for a vanilla Factorio 2.0 Space Age playthrough. It reads the game's declared prototype data and answers ratio, technology and throughput questions, and it audits blueprint strings. Soushi plays every minute himself; the tools never send input to the game, never open a save, and never write to a game directory.

Sibling of `wesnoth-advisor` and deliberately shaped like it, with one structural difference that drives the whole design: a Wesnoth save is plain WML text, so that tool reads the live board, while a Factorio save is version-locked binary, so this one reads what the game declares before a map exists.

## Commands

```bash
bun run sync                              # refresh the prototype snapshot; the only command that launches Factorio
bun run search asteroid                   # find prototypes by name across every class
bun run recipe rocket-fuel                # ingredients, results, every machine that can run it, unlocking tech
bun run ratio processing-unit --rate=5    # full production chain, machine counts, raw inputs, power, pollution
bun run tech kovarex --path               # cost, prerequisites, the whole research path with totals
bun run belt iron-plate --rate=45         # belt tier saturation, inserter rotation ceilings
bun run bp --file=blueprint.txt           # decode and audit a blueprint string or book
bun run typecheck                         # tsc --noEmit
```

There is no test suite. Verification is hand-checking tool output against the raw prototype JSON with `jq`, which is how both real defects so far were found. Game locations are auto-detected and overridable with `FACTORIO_CORE` and `FACTORIO_USERDATA` (see `src/paths.ts`).

## Architecture

One data flow, bottom up:

`paths.ts` locates the Steam install and the binary, and defines the only three paths this project writes to, all under the project root: `data/`, `data/manifest.json`, `.factorio-runtime/`.

`dump.ts` is the only module that runs Factorio. The load-bearing trick: `--dump-data` normally writes into `~/.factorio/script-output`, which would break the read-only property, so `dump.ts` generates a `config.ini` setting `read-data` to the Steam install and `write-data` to `.factorio-runtime/` inside this project, and passes it with `--config`. A fresh write-data also means a freshly generated `mod-list.json`, which is why the snapshot is vanilla Space Age no matter what Soushi has installed. The manifest's version and mod set are parsed out of the run's own log, not assumed.

`proto.ts` loads the 27.8 MB snapshot once and indexes it. Prototype classes are grouped by the fields they carry, not by a hardcoded list of class names: item classes are the ones declaring `stack_size`, crafting machines are the ones declaring both `crafting_categories` and a numeric `crafting_speed`. That last check matters, because `character` and `god-controller` declare categories with a null speed and would otherwise poison every machine count with NaN.

`recipes.ts` normalises ingredients and results, folding `amount_min`/`amount_max`, `probability` and `extra_count_fraction` into one expected amount, and owns the two rules that make the solver sane. First, **310 of the 659 recipes are recycling recipes**, and since a recycler returns a quarter of what went in, every one of them lists its ingredients as outputs; left in, the solver proposes making iron ore by recycling iron ore, which it did on the first run. Categories `recycling` and `parameters` are excluded from recipe selection but stay queryable. Second, **the raw-material set is derived, not listed**: every product a `resource` prototype yields when mined, plus every fluid a `tile` prototype carries for an offshore pump.

The default-recipe rule is ordered and stated in the output: main product over byproduct, then shallower chain to raw, then earlier in the tech tree, then fewer ingredients. The tech-tree term is what separates `copper-cable` from `casting-copper-cable`, which tie on everything else; without it the tie fell to alphabetical order.

`machines.ts` resolves effective speed under modules and beacons. A beacon transmits each module at `distribution_effectivity` scaled by `profile[n-1]`, where n is the number of beacons reaching the machine and `profile` is the Space Age falloff curve read off the prototype.

`solve.ts` walks the graph twice: depth first to choose recipes and cut cycles, then reverse topological to size them. The second pass is what lets a byproduct cancel demand for the same product further down instead of quietly building a second line for it. Cycles are reported, never unrolled.

`belts.ts` computes belt throughput exactly from `speed * 60 / 0.25 * 2`, and deliberately refuses to predict inserter throughput, reporting a rotation-bound ceiling with the reasons stated.

`blueprint.ts` decodes the documented string format (version byte, base64, zlib, JSON) and reads both the 2.0 nested `items` shape and the 1.x flat map. The local `blueprint-storage-2.dat` is binary and is never read.

`audit.ts` resolves each machine's real loadout, works out which beacons physically reach it from the selection boxes and positions, and nets the flows so the print's own bottleneck shows up.

`render.ts` formats tables. `cli.ts` is the only entry point and the only place that formats output.

## Constraints that must hold

- **Read-only.** No write anywhere outside the project root. `ISA.md` anti-claim A1 is the falsifier, and it is checked with `find ~/.factorio -newermt`, not by reading the code.
- **No hardcoded game statistics.** Every number comes from the snapshot. The only literals in lookup paths are the seven declared engine constants in `proto.ts`, `belts.ts` and `machines.ts`, each named and commented.
- **Never invent a number the data cannot support.** Inserter throughput beyond the rotation ceiling, and quality-scaled module effects, are both gaps. They are reported as gaps in the command output. Adding a plausible multiplier for either is a regression, not a feature.
- **Never state a game fact without naming the snapshot.** Every command prints the version, build, mod set and dump date in its header.
- Strict TypeScript with `noUncheckedIndexedAccess`; index access needs `!` or a guard.
- bun always, never npm.

## Working in this repo

When a claim about the game turns out to be wrong, verify against the snapshot with `jq` before changing anything, and cite the prototype path in the fix. `DESIGN.md` holds the decisions and their rationale; `ISA.md` is the state of record and its "Not yet specified" section is the real backlog, where tier C (live game state through a helper mod or RCON) is the open question that needs Soushi's call rather than a patch.
