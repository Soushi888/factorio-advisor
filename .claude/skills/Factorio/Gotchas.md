# Traps that have already cost a run

**The repo's own constraints live in `CLAUDE.md` § Constraints that must hold, and are not restated here.** Read-only, no hardcoded game statistics, never invent a number the data cannot support, never state a game fact without naming the snapshot, the `grep -a` coverage check, the main-tree rule for the loop. A rule copied into two files rots in one of them, and this repo has already lost a count that way twice in one evening.

What follows is only what `CLAUDE.md` does not carry: things found by running the tool against real data, which would otherwise have to be rediscovered.

## The engine's statistics use opposite conventions

On **item and fluid production statistics**, `input_counts` is what was **made** and `output_counts` is what was **used**. Settled against the save rather than the docs: the lab item reports `input = 84` on a base with 84 labs placed, and nothing in the game consumes a lab.

On **electric network statistics** it is the reverse: producers appear in `output_counts`, consumers in `input_counts`, verified by 34 radars at a 300 kW nameplate landing at 10.14 MW.

Getting this wrong gave a production column that was consumption, and made a saturated line indistinguishable from an idle one.

## Fluids are not in the item map

`crude-oil`, `petroleum-gas`, `water`, `lubricant` and `sulfuric-acid` live in `production.fluid`. Reading only `production.item` once reported "3453/min of crude oil needed, 0 spare, 0 made, 0 used" on a base running 43 refineries.

## Every chain runs backwards: the consumer sets the rate

This is the mechanic that decides whether a rate can be read at all, and reading a base without it produces confident nonsense. A machine whose output has nowhere to go stops, indefinitely, with no error and no entry in any statistic, so **a line runs at exactly the rate its consumers take, never at the rate its machines could make**, and the machine count upstream then carries no information about throughput.

**This is not a fluid rule, and calling it one was the blind spot that produced a night of wrong advice.** A fluid is only the case where the sink fills first and loudest, because a pipe network is small and closed. Items take longer and get there: a belt compresses, a chest fills, a logistic network runs out of storage, and the smelter at the end of it stops exactly like a refinery. Soushi said it himself twice before anything here was measured: "the production is based on the consumption", then "the active provider chest that received them is locked and full so its production should go idle". Measured on game 4 at tick 20673724, 281 of the 522 containers holding items are full, 97% of the 237764 banked copper plate sits in a container with no free slot, and 47019 of the 50961 transport lines sit at exactly 4.00 items per tile per lane. Copper plate read 964.3 made against 963.3 used, which is the signature of a line at its ceiling and was a line idling.

`bun run bottleneck` now prints a `sinks` column and a reading of `backed-up`, `flowing`, `starved` or `no sink read` on every row, and `advise` drops an outpost recommendation for a resource whose sinks are full. On game 4 that column reads backed-up on 15 of the 20 ranked lines, which is the honest diagnosis of the base: only iron ore is genuinely short. **A reading of `backed-up` means more of that line changes no number in the game.** The answer there is to drain it, never to build it.

Two consequences worth stating out loud when advising, both sharpest on fluids.

Changing a recipe to one with a better yield buys nothing while the product is backed up. A refinery on `advanced-oil-processing` makes 55 petroleum gas per 100 crude against 45 for `basic-oil-processing`, so the switch looks like a 22% gain, and against a full gas network it is a 0% gain that consumes less crude for the same output. Measured on game 4 at tick 19673479: 108 petroleum-gas tanks holding 2700000 of 2700000, exactly full, 43 refineries running 33.9 crafts a minute against a combined capacity near 516 (5 s per craft, `crafting_speed` 1), so 93% idle, while `bun run advise` reported crude oil as the thing to build for. Crude was 94.8% banked in its own tanks.

A machine with several fluid outputs is gated by its most blocked one. `advanced-oil-processing` yields heavy oil, light oil and petroleum gas from one craft, and the craft is atomic: if any one of the three has nowhere to go, the refinery makes none of the other two either. So the smallest sink in a three-product chain sets the whole chain, which is why heavy oil cracking is load-bearing out of all proportion to its size. One chemical plant on `heavy-oil-cracking` disposes of 1200 heavy oil a minute, enough for 48 advanced refinery crafts a minute, which is more than a 43-refinery bank running flat out.

## The rate table cannot see a full sink

Production equal to consumption is the signature of a line at its ceiling AND the signature of a line idling behind a full buffer. The rate table renders them identically and they want opposite advice: more machines for the first, a consumer for the second. **Occupancy is the only thing that separates them**, `src/saturation.ts` is the one reader, and the `sinks` column on `bottleneck` is where it surfaces. What it joins was already in the state file: `map[].containers` carries every chest and tank, and the belt survey carries what every transport line holds. Each sink kind is read the way it blocks and the two are never mixed. A lane is full or it is not, so belts read as the share of lanes at `beltItemsPerTile()` per lane. A buffer fills gradually, so containers read by volume, against the `inventory_size`, `stack_size` and `fluid_box.volume` the snapshot declares. Mixing them by volume was tried first and is wrong: a chest holds thousands where a lane holds four, so eleven half-empty chests of iron ore outweighed 1607 backed-up lanes and the reading fell from 81% to 38%.

Three things the reading refuses to say, and a fourth to remember when quoting it. It reads plain transport belts only, because a splitter's lines and an underground pair's span do not divide into a per-tile density the same way and both measure above the ceiling on this save. A product no belt and no chest carries has no reading at all, never a zero: heavy oil and light oil live in pipes, which the collector does not open, so they read `no sink read`. A single full tank is read at 99% of its declared volume rather than at 100%, because a fluid network at equilibrium never reaches its volume: all 108 petroleum gas tanks on game 4 hold 24999.969956099987 of 25000, identical to twelve digits, and an exact comparison called every one of them empty. And the whole base is treated as one pool, so a product backed up on one side and starved on the other reads as backed up. The verdict answers "could more of this go anywhere", never "is it in the right place".

The same reading dates a stall before it happens. A fluid produced steadily and consumed at exactly zero is a buffer filling toward a hard stop, and remaining capacity over the production rate says when. Game 4's lubricant: 315577 in 16 tanks at x -32.5..-29.5, produced at 200/min, consumed at 0.0/min, with 92 machines set to `electric-engine-unit` making nothing because that recipe wants 15 lubricant and the pipe never reached them.

## A fluid stage's recipe mix is solvable from rates, and the solve is its own check

A save reports no recipe per machine, but a refinery bank's split between `basic-oil-processing` and `advanced-oil-processing` follows from the rates alone, because only the advanced recipe yields heavy oil. Advanced crafts per minute is heavy oil made over 25; basic is crude used over 100 minus that. Then every other product is predicted rather than fitted, and the prediction is the evidence: light oil should be 45 per advanced craft plus 30 per 40 of the heavy that went to cracking, where cracking is heavy used minus lubricant made. On game 4 that predicted 407.04/min against 407.05/min measured, and gas from plastic and sulfur alone predicted 1717.85/min against 1717.85/min consumed.

**An algebra that closes on a product you did not solve for is evidence; one that closes only on the product you solved for is arithmetic.** State which kind you have. The same discipline as the sprite rule below: presence and extent are weak, difference against an independent prediction is strong.

## An hour average hides the last half hour

`producedPerMinute` in the state file is the engine's one-hour rolling window, so an evening of play is mostly invisible in it and a change made twenty minutes ago is diluted to a third. For anything Soushi just did, compute the instantaneous rate from the cumulative `produced` and `consumed` totals across two `reports/<save>-<tick>.json` snapshots, divided by the tick delta over 3600. Those snapshots are full state files kept per tick, which is what makes the arithmetic possible at all.

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

## A sprite sheet's layout is measured, never recalled

A belt sheet's first four rows are east, west, north, south, not the compass order, and its other sixteen are curves and end caps rather than angles. Read the row length out of the PNG header, recover the order by where the marker pixel sits, and tell a start cap from an end cap by texture: the end is the nose with the tread curving over the lip, the start is a flat plate. `directionIndex` in `src/sprites.ts` refuses a frame count that is not a power of two for exactly this reason.

And the check on any of it must look at the sprite, not at a page containing it. The verification that missed the belt rows for a whole evening read the tool's own drawn arrows, which were the only thing in the picture guaranteed to be right.

## Recall is not evidence, including recall of a recipe

The battery recipe was remembered as 1 sulfuric acid and is 20, which moved a requirement by a factor of four. Read the recipe before quoting an amount.
