import { beltItemsPerTile } from "./belts.ts";
import { surveyIn } from "./bus.ts";
import type { Data, Proto } from "./proto.ts";
import type { ContainerContents, GameState } from "./state.ts";

/**
 * Whether a product's sinks are full (C43).
 *
 * Every other reading in this project measures flow. This one measures whether
 * the flow had anywhere to go, and it exists because without it a rate cannot
 * be read at all. **A machine whose output has nowhere to go stops, and a
 * stopped machine produces exactly what its consumers take**, so on a base with
 * full sinks `producedPerMinute` is a measurement of demand and says nothing
 * about capacity. Made equal to used is then the signature of a line at its
 * ceiling AND the signature of a line idling behind a full belt, and the two
 * want opposite advice: more machines for the first, a consumer for the second.
 *
 * Round 9 found this for fluids and wrote it down as a fluid rule. That framing
 * was the blind spot: a fluid is only the case where the sink fills first and
 * loudest. Measured on game 4 at tick 20673724, 281 of the 522 containers
 * holding items are full, 97% of the 237764 banked copper plate sits in a
 * container with no free slot, and 47019 of the 50961 transport lines sit at
 * exactly 4.00 items per tile per lane. Against that, copper plate reading
 * 964.3 made against 963.3 used is not a line at its ceiling. It is a line
 * idling, and `advise` ranked copper ore first for an outpost because of it.
 *
 * Nothing here is a new measurement. The collector already records what every
 * transport line carries (C26) and what every container holds (MAP-2); the
 * ceiling comes from `beltItemsPerTile` in `belts.ts`, and a container's room
 * from the `inventory_size`, `stack_size` and `fluid_box.volume` the snapshot
 * declares. This module is the join, and A2's grep must keep finding no game
 * number typed into it.
 *
 * Two refusals, both of which the tool would otherwise get confidently wrong:
 *
 *   - **Only plain transport belts are read.** A splitter's eight lines and an
 *     underground pair's span do not divide into a per-tile density the same
 *     way, and both read above the ceiling on this save (4.29 and 4.33 against
 *     4.00). They are excluded rather than corrected, and `lanes` says how many
 *     lines the reading covers so the exclusion is visible.
 *
 *   - **A product with no belt and no container carrying it has no reading.**
 *     `fullShare` is null and the verdict is `unknown`, never `empty`. Absence
 *     of a sink is absence of evidence, and this is the common case for a
 *     product consumed in the machine that makes it.
 */

/**
 * The share of a product's sinks that must be full before the reading calls it
 * backed up. A judgment about when to speak, not a fact about the game, and
 * kept deliberately high: the claim it licenses is "building a producer changes
 * no number", which is wrong to say about a line with real room left. On game 4
 * it fires for copper ore at 0.989 and does not for iron ore at 0.808, which is
 * the distinction it exists to make: the iron line really is short.
 */
const BACKED_UP = 0.9;

/**
 * How empty a product's sinks must be before the reading calls it starved.
 * Same kind of constant as `STARVED` in `bus.ts` and chosen to agree with it.
 */
const STARVED = 0.15;

/**
 * How close to its declared capacity a single sink must sit to count as full.
 *
 * Not a tolerance for rounding: it is the measurement. **A fluid network at
 * equilibrium never reaches its declared volume**, because the last fraction of
 * a unit is the gradient that moves fluid at all. All 108 petroleum gas tanks
 * on game 4 hold 24999.969956099987 of a declared 25000, the same value to
 * twelve digits in every one of them, which is the signature of a network that
 * stopped rather than of tanks that happen to be near full. An exact `>=`
 * against the volume called every one of them empty and the whole oil side
 * starved, which is the opposite of what Round 9 measured. The same figure
 * serves a belt line, where a `line_length` artifact puts a full lane fractionally
 * either side of the ceiling.
 */
const AT_CEILING = 0.99;

/**
 * How many sinks a product needs before the verdict speaks at all.
 *
 * A judgment about sample size: one chest at 0% is not a starved line, it is
 * one chest. Below this the row still carries its counts, and the verdict stays
 * `unknown` so nothing downstream can build a finding on it.
 */
const MIN_SINKS = 3;

export type SinkVerdict = "backed-up" | "flowing" | "starved" | "unknown";

export interface Occupancy {
  name: string;
  /** Plain transport lines carrying it, and how many sit at the ceiling. */
  lanes: number;
  lanesFull: number;
  /** Containers and tanks holding it, and how many have no room left. */
  holders: number;
  holdersFull: number;
  /** Units held in containers, and the part of that in a full one. */
  stored: number;
  storedInFull: number;
  /**
   * Units more the containers holding it could take. Room in a shared chest is
   * its free slots at this product's own declared stack size plus what is
   * missing from the stacks it already occupies, which is exactly the question
   * "how much more of this could go here". Containers only: a belt's occupancy
   * is read as lanes, for the reason given on `beltShare`.
   */
  room: number;
  /**
   * The two sink kinds, each read the way it actually blocks, and never mixed.
   *
   * A lane is small and is either compressed or it is not, so belts are read as
   * the share of lanes at the ceiling. A buffer is large and fills gradually,
   * so containers are read by volume: game 4's lubricant sits in 16 tanks at
   * 19909.57 of 25000 each, not one of them "full", which as a headcount reads
   * 0% and starved when the truth is a buffer 80% of the way to a stall.
   *
   * Mixing the two by volume was tried first and is wrong, because a chest
   * holds thousands where a lane holds four: eleven half-empty chests of iron
   * ore outweighed 1607 backed-up lanes and the reading fell from 81% to 38%.
   * Storage room is real, but it is not what stops a machine. What stops a
   * machine is the sink at its own output, so either kind being full is enough.
   */
  beltShare: number | null;
  storeShare: number | null;
  /**
   * The worse of the two, which is the one that stops production. Null when the
   * product has no sink, which is a missing reading rather than a zero.
   */
  fullShare: number | null;
  /** What the share was computed over, so a printed line can say. */
  basis: "belts" | "containers" | "both" | "none";
  verdict: SinkVerdict;
}

/** Every prototype of this name that declares how much it holds. */
function holderProto(data: Data, name: string): Proto | null {
  return data.all(name).find((p) => typeof p["inventory_size"] === "number") ?? null;
}

function tankVolume(data: Data, name: string): number {
  for (const p of data.all(name)) {
    const box = p["fluid_box"];
    if (box && typeof box === "object") {
      const volume = (box as Record<string, unknown>)["volume"];
      if (typeof volume === "number") return volume;
    }
    const capacity = p["capacity"];
    if (typeof capacity === "number") return capacity;
  }
  return 0;
}

function stackSize(data: Data, name: string): number {
  const size = data.item(name)?.["stack_size"];
  return typeof size === "number" && size > 0 ? size : 0;
}

/**
 * Slots a container's contents occupy against the slots it declares.
 *
 * Stacks rather than counts, because that is what fills an inventory: 2400
 * copper ore at a declared stack of 50 is 48 stacks, which is exactly a steel
 * chest. A content whose stack size the snapshot does not declare is counted as
 * one slot rather than skipped, so an unknown item cannot make a full chest
 * read as empty.
 */
function slotsUsed(data: Data, items: Record<string, number>): number {
  let used = 0;
  for (const [item, count] of Object.entries(items)) {
    const stack = stackSize(data, item);
    used += stack > 0 ? Math.ceil(count / stack) : 1;
  }
  return used;
}

/**
 * What one container holds of each product, and how much more it could take.
 *
 * Room in a chest is attributed per product because a chest is shared: free
 * slots would hold this product at ITS declared stack size, and the stacks it
 * already occupies are usually not topped up. A chest with no free slot has
 * room only in its own partial stacks, which is what makes a full chest read
 * full for the thing that fills it and not for the thing that does not.
 */
function contents(
  data: Data,
  c: ContainerContents,
): { full: boolean; parts: Array<{ name: string; held: number; room: number }> } {
  if (c.items) {
    const slots = (holderProto(data, c.name)?.["inventory_size"] as number | undefined) ?? 0;
    const used = slotsUsed(data, c.items);
    const free = Math.max(0, slots - used);
    return {
      full: slots > 0 && used >= slots,
      parts: Object.entries(c.items).map(([name, held]) => {
        const stack = stackSize(data, name);
        if (stack <= 0) return { name, held, room: 0 };
        const mine = Math.ceil(held / stack);
        return { name, held, room: free * stack + (mine * stack - held) };
      }),
    };
  }
  if (c.fluid) {
    const volume = tankVolume(data, c.name);
    if (volume <= 0) return { full: false, parts: [] };
    return {
      full: c.fluid.amount / volume >= AT_CEILING,
      parts: [
        { name: c.fluid.name, held: c.fluid.amount, room: Math.max(0, volume - c.fluid.amount) },
      ],
    };
  }
  return { full: false, parts: [] };
}

/**
 * Occupancy per product, for every product any sink on the surface carries.
 *
 * One pass over the belt survey and one over the containers, so a caller that
 * wants many products asks once and looks them up.
 */
export function occupancy(state: GameState, data: Data): Map<string, Occupancy> {
  const rows = new Map<string, Occupancy>();
  const row = (name: string): Occupancy => {
    let r = rows.get(name);
    if (!r) {
      r = {
        name,
        lanes: 0,
        lanesFull: 0,
        holders: 0,
        holdersFull: 0,
        stored: 0,
        storedInFull: 0,
        room: 0,
        beltShare: null,
        storeShare: null,
        fullShare: null,
        basis: "none",
        verdict: "unknown",
      };
      rows.set(name, r);
    }
    return r;
  };

  for (const survey of surveyIn(state) ?? []) {
    for (const belt of survey.belts) {
      // Only plain belts: see the refusals in this module's docblock.
      if (belt.type !== "transport-belt") continue;
      const laneCount = belt.lanes.length || 1;
      for (const lane of belt.lanes) {
        if (!lane.item || lane.span <= 0) continue;
        const capacity = (lane.span * beltItemsPerTile()) / laneCount;
        if (capacity <= 0) continue;
        const r = row(lane.item);
        r.lanes += 1;
        // At or above the ceiling counts as full, and what is above it is
        // clamped rather than believed. Above happens: `line_length` on a short
        // or curved line undercounts the tiles, which reads as 4.83 where the
        // ceiling is 4.00. That is an artifact of the span, never evidence of a
        // belt holding more than a belt can hold, and left unclamped it would
        // make a backed-up line report more than a belt can hold.
        if (lane.count / capacity >= AT_CEILING) r.lanesFull += 1;
      }
    }
  }

  for (const surface of state.map ?? []) {
    for (const c of surface.containers ?? []) {
      if (c.unread) continue;
      const { full, parts } = contents(data, c);
      for (const part of parts) {
        const r = row(part.name);
        r.holders += 1;
        r.stored += part.held;
        r.room += part.room;
        if (full) {
          r.holdersFull += 1;
          r.storedInFull += part.held;
        }
      }
    }
  }

  for (const r of rows.values()) {
    if (r.lanes + r.holders === 0) continue;
    r.basis = r.lanes > 0 && r.holders > 0 ? "both" : r.lanes > 0 ? "belts" : "containers";
    if (r.lanes >= MIN_SINKS) r.beltShare = r.lanesFull / r.lanes;
    const capacity = r.stored + r.room;
    if (r.holders >= MIN_SINKS && capacity > 0) r.storeShare = r.stored / capacity;
    const shares = [r.beltShare, r.storeShare].filter((s): s is number => s !== null);
    if (shares.length === 0) continue;
    r.fullShare = Math.max(...shares);
    r.verdict =
      r.fullShare >= BACKED_UP
        ? "backed-up"
        : // Starved is the claim that NOTHING is holding this product back, so
          // it answers to every sink it has, not to the worst one.
          Math.max(...shares) <= STARVED
          ? "starved"
          : "flowing";
  }

  return rows;
}

/** The reading for one product, or an unknown row when nothing carries it. */
export function occupancyOf(rows: Map<string, Occupancy>, name: string): Occupancy {
  return (
    rows.get(name) ?? {
      name,
      lanes: 0,
      lanesFull: 0,
      holders: 0,
      holdersFull: 0,
      stored: 0,
      storedInFull: 0,
      room: 0,
      beltShare: null,
      storeShare: null,
      fullShare: null,
      basis: "none",
      verdict: "unknown",
    }
  );
}

/**
 * The occupancy as one clause, for a table cell or the tail of a finding.
 *
 * Always names what it measured, because "98% full" over three lanes and over
 * four thousand are different claims and the reader cannot tell them apart from
 * the percentage.
 */
export function occupancyPhrase(o: Occupancy): string {
  if (o.fullShare === null) return "no belt or chest carries it";
  const pct = `${(o.fullShare * 100).toFixed(0)}%`;
  const parts: string[] = [];
  if (o.lanes > 0) parts.push(`${o.lanesFull}/${o.lanes} lanes full`);
  if (o.holders > 0) parts.push(`${o.holdersFull}/${o.holders} chests full`);
  return `${pct} of its sinks are full (${parts.join(", ")})`;
}

/**
 * True when building more of this product cannot raise its rate.
 *
 * The one question every piece of advice in this project should ask before it
 * tells Soushi to build something.
 */
export function isBackedUp(o: Occupancy): boolean {
  return o.verdict === "backed-up";
}
