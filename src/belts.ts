import type { Data, Proto } from "./proto.ts";

/**
 * Throughput.
 *
 * Belts are exact. `transport-belt.speed` is tiles per tick, items sit one
 * quarter tile apart, a belt has two lanes, and the game runs at 60 ticks per
 * second, so items/s = speed * 60 / 0.25 * 2 = speed * 480. Yellow belt at
 * speed 0.03125 gives 15 items/s, which is the published figure.
 *
 * Inserters are not exact, and this module says so rather than inventing a
 * number. Real inserter throughput depends on belt chasing, the stack bonus
 * from research, and where the source and destination sit. What can be derived
 * honestly from the prototype alone is the rotation-bound ceiling, and that is
 * what gets reported, labelled as a ceiling.
 */

/** Engine constant: items on a belt are spaced a quarter tile apart. */
const ITEM_SPACING_TILES = 0.25;
/** Engine constant: the simulation runs at 60 ticks per second. */
const TICKS_PER_SECOND = 60;
/** A transport belt carries two lanes. */
const LANES = 2;

export function beltItemsPerSecond(belt: Proto): number {
  const speed = belt["speed"];
  if (typeof speed !== "number") return 0;
  return (speed * TICKS_PER_SECOND * LANES) / ITEM_SPACING_TILES;
}

export interface BeltFit {
  belt: Proto;
  itemsPerSecond: number;
  /** How many of this belt the rate needs. */
  beltsNeeded: number;
  /** Fraction of one belt the rate occupies, above 1 when it overflows. */
  saturation: number;
}

export function beltOptions(data: Data, ratePerSecond: number): BeltFit[] {
  return data
    .belts()
    .map((belt) => {
      const itemsPerSecond = beltItemsPerSecond(belt);
      return {
        belt,
        itemsPerSecond,
        beltsNeeded: itemsPerSecond > 0 ? ratePerSecond / itemsPerSecond : Infinity,
        saturation: itemsPerSecond > 0 ? ratePerSecond / itemsPerSecond : Infinity,
      };
    })
    .sort((a, b) => a.itemsPerSecond - b.itemsPerSecond);
}

export interface InserterCeiling {
  inserter: Proto;
  /** Full swings per second, from rotation speed alone. */
  swingsPerSecond: number;
  /** Bulk inserters move a hand of several items, so this is a floor of one. */
  bulk: boolean;
  /** Items per second at one item per swing. A ceiling, not a prediction. */
  itemsPerSecondCeiling: number;
}

export function inserterCeilings(data: Data): InserterCeiling[] {
  const out: InserterCeiling[] = [];
  for (const ins of data.inserters()) {
    const rot = ins["rotation_speed"];
    if (typeof rot !== "number" || rot <= 0) continue;
    // A swing is 180 degrees out and 180 degrees back, so one full turn.
    const ticksPerSwing = 1 / rot;
    const swingsPerSecond = TICKS_PER_SECOND / ticksPerSwing;
    out.push({
      inserter: ins,
      swingsPerSecond,
      bulk: ins["bulk"] === true,
      itemsPerSecondCeiling: swingsPerSecond,
    });
  }
  return out.sort((a, b) => a.swingsPerSecond - b.swingsPerSecond);
}
