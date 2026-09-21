# Analysis

One question about the game, answered from the data.

## Ideal state

Soushi asks something specific and gets the answer in the first sentence, with the measurement behind it and the snapshot it came from named. Where the data cannot answer, he is told that instead of being given a plausible number.

## Done looks like

- **The answer leads.** Not the method, not the tables. "Your labs are at 7.4% of capacity, so the limit is pack supply" first; the derivation after, if it earns its place.
- **Every figure is traceable.** A prototype path, a state path, or a command whose output is shown. A number with no source does not go in the answer.
- **The question is answered, including the part he did not ask.** If he asks why purple is slow and the data says the real constraint is two levels down, say both: what he asked, then what the numbers actually show.
- **A wrong belief is corrected plainly.** He is often working from a memory of the base rather than its current state. "You said you have yellow science; the save says the technology is researched and no pack was ever made" is the most valuable sentence the tool can produce, and it needs no softening.
- **Limits are declared in the same breath as the number.** Sized on a machine he does not own, priced through a resource he cannot reach, computed from a rate that is a one-hour average: say which, in one clause.

## Do

Pick the command that answers it; `Commands.md` is the map. Most questions about the base are `advise`, `state`, `power` or `next`. Most questions about a recipe or a target rate are `ratio`, `recipe`, `tech` or `belt`. A pasted blueprint is `bp`, and `bp --rate=` when he wants it judged rather than described.

Read `Reading.md` before answering anything about a bottleneck: the diagnostic order is what keeps an accurate answer from being a useless one.

When a claim about the game turns out to be wrong, verify against the snapshot with `jq` before changing anything, and cite the prototype path in the correction. Recall is not evidence, including recall of a recipe: the battery recipe was remembered as 1 sulfuric acid and is 20, which moved a requirement by a factor of four.

## Falsifiers

- An acronym, a recipe, an amount or a machine name stated without a source read this session.
- A rate quoted without saying it is the game's own one-hour average.
- A machine count sized on a prototype his census does not contain, without saying so.
- An answer that is technically correct and does not address what he will do next.
