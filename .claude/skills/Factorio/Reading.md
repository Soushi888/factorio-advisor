# How to read a Factorio base

The order matters. A base has one binding constraint at a time and four plausible-looking ones, and reading them out of order produces advice that is true and useless.

## The diagnostic order

**1. Is the state fresh?** The read is as old as the last save on disk. Compare the save's mtime to now and say the age in the first sentence. If he is mid-session, ask for a save before anything else; a confident answer about a base he changed an hour ago is worse than no answer.

**2. What is the base actually doing, as opposed to capable of?** Consumption per minute is what happened. Production per minute is what the lines delivered. **The gap between them is the diagnosis**, and it is called spare. A line making exactly what the base eats has no spare and cannot feed anything new, however many machines it has. A requirement compared against total production instead of against spare calls a saturated line healthy, which is the single easiest way to give wrong advice here.

**3. Are the sinks full?** Ask this before believing any rate, because a full sink and a saturated line produce the identical signature: production equal to consumption, every minute, forever. They want opposite advice. A line at its ceiling needs more machines; a line idling behind a full belt or a full tank needs a consumer, and building machines for it is wasted effort that changes no number. The discriminator is occupancy, not rate, and `bun run bottleneck` prints it: a `sinks` percentage and a reading of `backed-up`, `flowing`, `starved` or `no sink read` on every ranked line. **Quote that reading whenever quoting spare, and never recommend building a line that reads backed-up.** It applies to items exactly as it does to fluids: 15 of the 20 ranked lines on game 4 read backed-up, which is the whole diagnosis of that base. Fluids are only where it bites first, a pipe network being small and closed.

**4. Is the constraint supply or demand?** Lab capacity is the clean test on the science side: labs times lab speed against the current technology's own `unit.time` gives what the labs could eat, and the consumption figure says what they did eat. At 7% utilisation the answer is never "more labs". The same shape appears everywhere: a machine count that dwarfs the throughput means the feed is the limit, not the machines.

**5. What does the grid really deliver?** Never compare delivered watts against drawn watts. In an electric network those are the same number by conservation, so a saturated grid reports a perfect balance while machines brown out. The honest headroom is capacity against delivered, where capacity is solar averaged over the day cycle and steam limited by the boilers that actually exist.

**6. Where is it?** Once the rate question is settled, the geometry says which place to act on: which power block has engines with no boiler, which ore field is nearly spent and which is untouched. A recommendation that names coordinates is worth several that do not, **but a bare point is not a place.** "x -286.5 is not precise enough, what area/tiles are you talking about?" (Soushi, mid-game, 2026-09-21). Every rectangle the tool points at carries its extent, so name the area corner to corner with its size, and where a landmark exists, name that too: a patch is hundreds of tiles across and its top-left corner is usually bare ground.

## What a bottleneck looks like in the data

| Symptom in the state file | What it usually means |
|---|---|
| A pack's production equals its consumption, all packs equal | Research is supply-limited at that rate; find the slowest pack. |
| An ore's consumption exceeds its production | Buffers are draining. The patch, the drills or the belt is the limit, in that order of likelihood as a patch ages. |
| Lab utilisation far below capacity | Pack supply, never lab count. |
| An intermediate with negative spare and a large machine count | The machines are starved; look one level up the chain. |
| An item with a large cumulative total and zero rate | A line that used to run and stopped. Say so rather than treating it as active. |
| A pack tech researched with zero produced ever | He has the unlock, not the line. This is a real and common gap. |
| Any product reading `backed-up` in the `sinks` column | Demand-limited, not supply-limited. Every machine upstream is throttled to what the consumers take, whatever its recipe or count. Build a consumer, never a producer. |
| A product reading `backed-up` with production at exactly zero | A third case, and neither of the other two sentences fits: nothing makes it and the base is living off a bank it built earlier. Say the stock is finite. Piercing rounds on game 4 sit on 772 full lanes with no production, drawn 3.4/min by the turrets. |
| Almost every line reading `backed-up` at once | The base is demand-limited as a whole, so the question is not what to build but what to draw with. Name the one or two lines that are NOT backed up: those are the real constraints. |
| A fluid produced steadily and consumed at exactly zero | A buffer filling toward a stall, and a downstream line that should be drinking it and is not connected. Date the stall: remaining capacity over the production rate. |
| A machine class with a huge count and a tiny craft rate | Read the buffers before concluding anything. 43 refineries at 6.6% duty is not 43 broken refineries, it is one blocked output. |

## Sizing an addition honestly

The target is a rate, and the addition is the **delta** between what he makes now and that target, never the whole target. Solve each chain at the delta, sum the requirements per item, and compare each against that item's spare. What is left is new capacity to build.

Two corrections that the solver does not make for you:

- **It picks the best prototype in the snapshot, not the best one he owns.** If the census shows no assembling machine 3, size with `--machine=assembling-machine-2` and say that is why the count is higher.
- **Space Age declares resources that exist on planets he has not visited.** Sulfuric acid reads as a raw input because a `sulfuric-acid-geyser` resource exists. On Nauvis he must make it, so price the sulfur route by hand and say you did.

## Talking to Soushi about it

He wants the battle plan from the player's point of view, not a technical readout. Lead with the correction to whatever he believes, because that is the whole value: "your labs are at 7%, so it is not the labs" is worth more than six accurate tables. Then the ordered plan, then the numbers behind it. Cheapest and most reversible first: boilers behind engines he already built before a new outpost, an outpost before a refactor.
