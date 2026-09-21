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

## Useful flags

- `ratio`: `--machine=assembling-machine-2` to hold it to what he has, `--modules=`, `--beacons=`, `--recipe=<product>=<recipe>`, `--raw=iron-plate,copper-plate`.
- `advise`: `--spm=`, `--force=`, `--top=`.
- `state`: `--save=`, `--force=`, `--top=`.

## What they refuse, on purpose

- **Inserter throughput past the rotation ceiling.** Real throughput needs belt chasing and the capacity bonus, neither of which is a prototype fact. The output says so.
- **Quality-scaled module effects.** Not applied; a print using quality modules prints a warning that the figures understate it.
- **A cycle in a production chain.** Reported, never unrolled.
- **A technology name the snapshot does not carry.** Listed as unknown, never dropped.
- **A recycling recipe as a way to manufacture something.** 310 of the 659 recipes list their ingredients as outputs; leaving them in makes the solver propose making iron ore by recycling iron ore. `scrap-recycling` is deliberately kept, because on Fulgora it is a genuine source.
