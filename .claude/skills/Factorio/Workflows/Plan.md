# Plan

The ordered battle plan: what to build next, how much of it, and where.

## Ideal state

Soushi reads it and knows what to do when he alt-tabs back into the game, in what order, and why that order. Each step is priced from the data and placed on the map where the data supports a place.

## Done looks like

- **Written from the player's point of view.** He is a player at a keyboard, not a reader of a technical report. "Put the next copper outpost at 0, 1152" is the register; "the copper-ore requirement exhibits a negative headroom" is not.
- **Ordered by cost and reversibility, cheapest first.** Boilers behind steam engines he already paid for come before a new outpost; an outpost comes before a refactor. The order is the argument.
- **Each step priced.** Machines, megawatts, items per minute, all derived. A step with no number attached is not a step, it is a mood.
- **Each step placed, where the geometry supports it.** A coordinate from the map, with what is there now and what it is compared against: "11.8M with nothing on it, against 8.3M left under the 129 drills at -512, 32."
- **The thing he believes that is wrong, named first.** A plan built on his current belief about the base, when the save disagrees, will be followed and will fail.
- **The scope stated honestly.** If reaching the target means roughly doubling the raw end, say that plainly rather than listing twelve intermediate steps that imply it.

## Where it goes

**A plan is a file the dashboard renders, not a document beside it.** Write `data/plans/<slug>.json` and it becomes the top section of `reports/index.html`: ordered steps, each with its cost, what it buys, how reversible it is, a live progress bar, and a click that flies the one map to the place the step names.

The contract, from `src/plan.ts`: a step's prose is authored and a step's numbers are not. Anything a step wants to show as a figure is declared as a `check` with a path into the state file, a `from` baseline and a `target`, and it is read at render time. That is what lets a step know it is half done without anyone ticking a box, and it is why a number typed into the prose is a defect rather than a shortcut. A step's `where` is `{x, y, w, h, layer}`, the same shape the advisor's own focus takes.

A long form under `.local/` is optional and secondary: link it from the plan's `source` if the reasoning is worth keeping at length. The dashboard is where the plan lives.

## Do

Start from `bun run advise` with a target he named, or the derived one if he did not. Run `bun run bottleneck` too: machine-class utilisation is what separates "you are short of machines" from "your machines are starved", and those want opposite steps. Cross-check every coordinate against the ore and point tables in the state file rather than reading it off the rendered map. Where the chain runs through something he cannot make yet, price that sub-chain separately with `ratio` and say it is new construction rather than an expansion.

When the plan would change how the tool itself works, that is a repo change and it goes through the covenant in `.local/convene/`, not into the plan.

## Falsifiers

- A step with no measurement.
- A coordinate that no entity or resource in the state file sits at.
- A plan that assumes a machine, a technology or a planet he does not have.
- An order that puts an expensive irreversible build before a cheap reversible one that removes the same constraint.
- A plan presented as complete while a part of it is blocked, instead of saying which part and why.
- A figure in a step's prose that should have been a check, so it goes stale while the bar beside it stays current.
- A step with a `where` that no entity or resource in the state file sits at.
