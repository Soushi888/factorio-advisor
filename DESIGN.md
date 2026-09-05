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

**Consequence:** `bun run sync` is the only command that launches Factorio, it takes about three seconds, and it never opens a save.

## ADR-2: query time never touches the game

`sync` writes `data/data-raw.json` plus `data/manifest.json` (game version, build, mod set with versions, dump timestamp, byte size). Every other command reads only those. A stale snapshot is therefore detectable and reportable, never silently wrong, and the tool works with Factorio uninstalled.

The snapshot is gitignored. It is 27.8 MB of derived data with a one-command rebuild.

## ADR-3: no hardcoded game numbers

Inherited from `wesnoth-advisor` and load-bearing. Every crafting speed, energy draw, module effect, belt speed and science cost is read from the snapshot. If the game patches, the numbers follow.

The only numeric literals permitted in lookup paths are **engine facts that the dump cannot carry**, each declared once, named, and commented at its definition. There are seven, in two kinds.

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
audit.ts     entity census, ratio check against the solver, belt saturation, module and beacon coverage
render.ts    tables and trees for the terminal
cli.ts       the only entry point and the only place that formats output
```

`proto.ts` is the choke point every other module reads through, the way `save.ts` is in the sibling project.

## Commands

```bash
bun run sync                              # refresh the prototype snapshot (the only command that launches Factorio)
bun run search plate                      # find prototypes by name or type
bun run recipe electronic-circuit         # ingredients, results, makers, unlocking tech
bun run ratio science --rate=1.5          # full chain for 1.5/s, machine counts, raw inputs, power
bun run ratio plastic-bar --rate=90/m --machine=assembling-machine-3 --modules=productivity-module-3
bun run tech logistics-3                  # cost, prerequisites, unlocks
bun run tech --path=kovarex-enrichment-process   # full research path with cumulative science
bun run belt iron-plate --rate=45         # belts and inserters needed, saturation
bun run bp --file=blueprint.txt           # decode and audit a blueprint
bun run typecheck
```

## Constraints that must hold

- **Read-only, and stricter than "does not corrupt".** No writes anywhere under `~/.factorio` or the Steam install. No save is opened. No mod is installed. The engine runs exactly once per `sync`, headless, with its write-data redirected into this project.
- **No hardcoded game statistics.** Only the four documented defaults in ADR-3, each commented at its use site.
- **Never state a game fact without the snapshot behind it.** Every command prints the snapshot's game version and dump date in its header, the way the sibling prints the save name.
- Strict TypeScript with `noUncheckedIndexedAccess`.
- Bun only, never npm.

## Deliberately out of scope

Live game state (Tier C: a helper mod writing to `script-output`, or RCON). It is a different trust posture and a separate decision.
