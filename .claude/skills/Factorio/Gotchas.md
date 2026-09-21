# Traps that have already cost a run

**The repo's own constraints live in `CLAUDE.md` § Constraints that must hold, and are not restated here.** Read-only, no hardcoded game statistics, never invent a number the data cannot support, never state a game fact without naming the snapshot, the `grep -a` coverage check, the main-tree rule for the loop. A rule copied into two files rots in one of them, and this repo has already lost a count that way twice in one evening.

What follows is only what `CLAUDE.md` does not carry: things found by running the tool against real data, which would otherwise have to be rediscovered.

## The engine's statistics use opposite conventions

On **item and fluid production statistics**, `input_counts` is what was **made** and `output_counts` is what was **used**. Settled against the save rather than the docs: the lab item reports `input = 84` on a base with 84 labs placed, and nothing in the game consumes a lab.

On **electric network statistics** it is the reverse: producers appear in `output_counts`, consumers in `input_counts`, verified by 34 radars at a 300 kW nameplate landing at 10.14 MW.

Getting this wrong gave a production column that was consumption, and made a saturated line indistinguishable from an idle one.

## Fluids are not in the item map

`crude-oil`, `petroleum-gas`, `water`, `lubricant` and `sulfuric-acid` live in `production.fluid`. Reading only `production.item` once reported "3453/min of crude oil needed, 0 spare, 0 made, 0 used" on a base running 43 refineries.

## Delivered equals drawn, always

In an electric network, what the grid supplied is what the machines took, by conservation. Spare computed against drawn watts is identically zero and means nothing. Headroom is capacity against delivered, where capacity is solar averaged and steam limited.

## A transport line's `line_length` is 1 per belt entity

Not the merged segment length; 1.15 on a curve. So a lane's `get_contents` count is that tile's own, and a lane holding 4 items on a span of 1 is exactly full. Measured by `bus`, 2026-09-21, and the opposite assumption would have carried a whole density model. Recorded in the C26 evidence and at the top of `src/bus.ts`.

## Proving the read-only property while Soushi is playing

The `find ~/.factorio -newermt` sweep is the probe of record on a quiet machine, and it is useless mid-session: his own game writes `factorio-current.log`, `player-data.json`, `config.ini` and autosaves continuously, and the sweep cannot tell his writes from ours. Use a byte comparison across one run instead: hash `config.ini` and `player-data.json` before and after a `state` read. Done 2026-09-21 at 02:21 with the game running: identical.

## Ghosts are not the base

The map collector excludes `tile-ghost`: this save holds 136298 of them, planned landfill, eighty percent of everything placed, and they set the density shading of the whole map on their own. Entity ghosts stay, because planned construction is part of the base.

## The page needs a charset

A `file://` page with no `<meta charset="utf-8">` is guessed as latin-1 by Chrome, which turns a middle dot into two characters mid-table.

## The solver is not constrained to what he owns

It picks the best prototype in the snapshot. If the census has no assembling machine 3, size with `--machine=assembling-machine-2` and say why the count is higher. Space Age also declares resources from planets he has not reached: sulfuric acid reads as raw because a `sulfuric-acid-geyser` exists, so on Nauvis the sulfur route must be priced by hand.

## Recall is not evidence, including recall of a recipe

The battery recipe was remembered as 1 sulfuric acid and is 20, which moved a requirement by a factor of four. Read the recipe before quoting an amount.
