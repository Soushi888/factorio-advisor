# The commands, and what each one refuses

Every one prints the snapshot it answered from in its header: version, build, mod set, dump date. A figure quoted without that header is a figure with no provenance.

Run them from `~/Projets/factorio-advisor`. **bun always, never npm.**

## Reading the game

| Command | Answers | Launches the engine |
|---|---|---|
| `bun run sync` | Refresh the prototype snapshot from the installed game. | yes, ~3 s |
| `bun run state --save="game 4"` | Research, production and consumption rates, machine census, power delivered, evolution, pollution, logistic contents, and the map geometry, from a **copy** of the save. | yes |
| `bun run report --save="game 4"` | The same read, plus a diff against the previous report of that save, plus `reports/index.html`. | yes |
| `bun run watch` | Leave it running. A save in game becomes a report and refreshes the page. **Main tree only.** | on each save |

The save is copied into `.factorio-runtime/saves/` and read there; his own save is never opened in place. A modded save still loads, because the collector is appended to the copy's own `control.lua` rather than shipped as a mod.

## Advising

| Command | Answers |
|---|---|
| `bun run advise` | Where the base stands and what the next step costs, with the measurement under each call. Target defaults to twice the best current pack line. |
| `bun run advise --spm=45` | The same against a target of 45 packs a minute. **Per minute**, not per second. |
| `bun run next` | What is researchable right now, cheapest first, with lab-seconds at his actual lab speed. |
| `bun run next --for=carbon-fiber` | The unresearched path from here to what unlocks an item or a technology. |
| `bun run power` | Generation against draw, priced from the census: nameplate, solar averaged, steam limited, and the shortfall. |
| `bun run bottleneck` | Two readings, never blended: machine classes by how much of their time the output accounts for, and items and fluids by what is left over against their own demand. Each row names the recipe it charged and the split it used. Lines that are behind come first, biggest hole first; the ratio stays as a column because it answers whether a line is healthy, which is a different question from what is holding the base back. When the two readings agree on one story, the first sentence is that story: a class at the wall means short of machines, no class near it plus a raw input as the biggest hole means short of that input, and anything else gets no such sentence. |

## Answering a question

| Command | Answers |
|---|---|
| `bun run ratio processing-unit --rate=5` | The full chain: machine counts, raw inputs, power, pollution, and which recipe it declined at each step. |
| `bun run recipe rocket-fuel` | Ingredients, results, every machine that can run it, the unlocking technology. |
| `bun run tech kovarex --path` | Cost, prerequisites, the whole research path with totals. |
| `bun run belt iron-plate --rate=45` | Belt tier saturation and the inserter rotation ceiling. |
| `bun run search asteroid` | Prototypes by name across every class. |
| `bun run bp --file=print.txt` | Decode and audit a blueprint or book: real loadouts, which beacons physically reach, the netted bottleneck. |
| `bun run bp --file=print.txt --rate=45` | The same print judged against a target rate: scale, spare machines, belt tier, inserter ceiling. |
| `bun run gen electronic-circuit --rate=45` | Lay one recipe step out as a placeable row and print the blueprint string. |
| `bun run bp --file=print.txt --draw` | Draw that print to scale under `.local/`: every entity at the footprint its prototype declares, belts arrowed by travel direction, the short-fed machines outlined from the audit's own flows. `--render` is the same flag; `--svg` writes the bare file; `--out=` places either. |
| `bun run gen ... --draw` | The same drawing, straight off the row the generator built, with no round trip through the encoder. |

## Useful flags

- `ratio`: `--machine=assembling-machine-2` to hold it to what he has, `--modules=`, `--beacons=`, `--recipe=<product>=<recipe>`, `--raw=iron-plate,copper-plate`.
- `advise`: `--spm=`, `--force=`, `--top=`.
- `bottleneck`: `--save=`, `--force=`, `--top=` (how many tightness rows).
- `state`: `--save=`, `--force=`, `--top=`, `--belts` (writes the belt survey too, which is large).
- `report`: `--save=`, `--threshold=`, `--now` (one report and exit), `--page` (redraw `reports/index.html` from the state file on disk, no engine run).
- `bp` and `gen`: `--draw` or `--render`, `--svg`, `--out=<path>`.

## The dashboard

`bun run report` writes `reports/index.html`: one zoomable, layered map drawn tile by tile in the save's own coordinates, the written plan from `data/plans/<save>.json` when there is one, the derived advice, and six sections. `bun run report --page` redraws it from the last read without launching the engine, which is the loop for working on the page.

The map uses the game's own icons, resolved out of the installed game by `src/icons.ts`. **They are never copied into this repository**: that is Wube's art and the repo is public.

## What they refuse, on purpose

- **Inserter throughput past the rotation ceiling.** Real throughput needs belt chasing and the capacity bonus, neither of which is a prototype fact. The output says so.
- **Quality-scaled module effects.** Not applied; a print using quality modules prints a warning that the figures understate it.
- **A cycle in a production chain.** Reported, never unrolled.
- **A technology name the snapshot does not carry.** Listed as unknown, never dropped.
- **Which machine of a shared class did the work.** A save reports no recipe per machine, so `bottleneck` splits a recipe's work between the census classes that could have run it, by count times crafting speed. Classes sharing a recipe therefore read the same busy fraction; that is the measurement's honest resolution, not a bug.
- **Module loadouts.** A save read reports none, so `bottleneck` charges every machine at its bare prototype speed. A class running speed or productivity modules reads busier than it is, and the output says so instead of applying a factor.
- **A recipe the force has not researched.** Never charged, however well it fits the product: `acid-neutralisation` would otherwise take credit for every boiler's steam.
- **A craft rate read off an item's consumption.** `bottleneck` bounds a recipe by its own output and by its fluid inputs only. An item's consumption counts fuel burned, entities built and hand-crafting, and on a base drawing ore out of chests it does not balance over the hour; reading plastic off coal charged 16.5 chemical plants where the plastic itself allows 1.4.
- **Guessing which of two recipes a base runs.** Where the base's own rates cannot tell them apart, the leftover goes through the default rule and the row says so. Where they can, the rates decide: on game 4 the heavy oil pins advanced processing, the crude it did not eat pins basic, and the refineries land on crude used over 1200 exactly.
- **A recycling recipe as a way to manufacture something.** 310 of the 659 recipes list their ingredients as outputs; leaving them in makes the solver propose making iron ore by recycling iron ore. `scrap-recycling` is deliberately kept, because on Fulgora it is a genuine source.
