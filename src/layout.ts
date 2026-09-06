import type { BpEntity, Blueprint, Decoded } from "./blueprint.ts";
import { encode } from "./blueprint.ts";
import { beltItemsPerSecond } from "./belts.ts";
import type { CraftingMachine, Data, Proto } from "./proto.ts";

/**
 * Laying one recipe step out as a placeable row.
 *
 * Everything positional here is read from the snapshot or derived from real
 * blueprints, never remembered. Two facts do the work, and both were measured
 * against the shipped 83-entity platform print before a line of this was written:
 *
 *   - **Tile footprint is `selection_box`, not `collision_box`.** A collision box
 *     is inset for movement, so a 2x2 turret collides over 1.4 tiles and a 3x3
 *     assembler over 2.4. The selection box is the footprint: 2x2 and 3x3 exactly.
 *
 *   - **Position parity follows footprint parity.** An odd dimension sits at a
 *     half coordinate (the centre of a tile), an even one at an integer (the seam
 *     between two). Checked against every entity in that print: 83 of 83.
 *
 * Factorio 2.0 uses sixteen directions, so North is 0, East 4, South 8 and West
 * 12. That is also measured rather than recalled: the print contains directions
 * 0, 4, 8 and 12 and nothing else, and the parity rule only closes at 83 of 83
 * when 4 and 12 are the axes that swap width and height.
 *
 * **An inserter's direction names the side it picks up FROM, not the side it
 * delivers to.** Asked of the engine, not assumed: an inserter placed facing
 * north reports `pickup_position` at y-1 and `drop_position` at y+1.2, so it
 * moves items southward. The first version of this file read it the other way
 * and emitted every row with both inserters reversed, feeding the input belt
 * from the machine and the machine from the output belt. Nothing static caught
 * it: the census, the ratios, the belt figures and the decode round-trip are all
 * indifferent to which way an inserter faces. The sandbox caught it on its first
 * run, which is the whole argument of ADR-10.
 */

/** The sixteen-direction compass Factorio 2.0 uses. */
export const NORTH = 0;
export const EAST = 4;
export const SOUTH = 8;
export const WEST = 12;

export interface Footprint {
  width: number;
  height: number;
}

/**
 * Tile footprint from `selection_box`.
 *
 * Returns null when the prototype declares no selection box, which is a gap to
 * report rather than a number to invent.
 */
export function footprintOf(proto: Proto): Footprint | null {
  const sb = proto["selection_box"];
  if (!Array.isArray(sb) || sb.length !== 2) return null;
  const [a, b] = sb as [unknown, unknown];
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const width = Math.round(Number(b[0]) - Number(a[0]));
  const height = Math.round(Number(b[1]) - Number(a[1]));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return null;
  }
  return { width, height };
}

/**
 * Snap a centre coordinate to the grid a footprint of this size must sit on.
 *
 * Odd sizes centre on a tile and land on a half coordinate; even sizes straddle
 * a seam and land on an integer.
 */
export function snap(centre: number, size: number): number {
  return size % 2 === 1 ? Math.floor(centre) + 0.5 : Math.round(centre);
}

export interface RowOptions {
  machine: CraftingMachine;
  machineCount: number;
  recipe: string;
  /** Belt prototype for the input and output lanes. */
  belt: Proto | null;
  /** Inserter prototype between belt and machine. */
  inserter: Proto | null;
  /** Modules to place in every machine, by name, repeated per slot. */
  modules: string[];
  label: string;
}

export interface RowResult {
  blueprint: Blueprint;
  string: string;
  entityCount: number;
  width: number;
  height: number;
  /** Gaps: prototypes whose footprint the snapshot does not declare. */
  gaps: string[];
}

/**
 * One row: machines left to right, an input belt above and an output belt below,
 * one inserter per machine per side.
 *
 * The row is a straight line because a straight line is the shape whose geometry
 * is fully determined by the footprints. Anything cleverer would be a layout
 * opinion this tool has no source for.
 */
export function buildRow(data: Data, opts: RowOptions): RowResult {
  const gaps: string[] = [];
  const entities: BpEntity[] = [];
  let n = 1;

  const mFoot = footprintOf(opts.machine as unknown as Proto);
  if (!mFoot) {
    throw new Error(
      `${opts.machine.name} declares no selection_box in this snapshot, so its\n` +
        "footprint is unknown and a row cannot be laid out without inventing one.",
    );
  }

  const beltFoot = opts.belt ? footprintOf(opts.belt) : null;
  if (opts.belt && !beltFoot) gaps.push(`${String(opts.belt["name"])} (no selection_box)`);
  const insFoot = opts.inserter ? footprintOf(opts.inserter) : null;
  if (opts.inserter && !insFoot) gaps.push(`${String(opts.inserter["name"])} (no selection_box)`);

  // The row runs along x. Machines sit in the middle band; the inserter and belt
  // lanes sit one tile out on each side, which is the only spacing an inserter's
  // one-tile reach allows.
  const machineY = 0;
  const inserterOffset = mFoot.height / 2 + 0.5;
  const beltOffset = mFoot.height / 2 + 1.5;

  const items = opts.modules.length > 0
    ? opts.modules.map((name) => ({ id: { name }, items: { in_inventory: [] } }))
    : undefined;

  for (let i = 0; i < opts.machineCount; i += 1) {
    const cx = i * mFoot.width + mFoot.width / 2;
    const machine: BpEntity = {
      entity_number: n++,
      name: opts.machine.name,
      position: { x: snap(cx, mFoot.width), y: snap(machineY, mFoot.height) },
      recipe: opts.recipe,
    };
    if (items) machine["items"] = items;
    entities.push(machine);

    if (opts.inserter && insFoot) {
      // Both inserters face NORTH, because north means "pick up from the north".
      // The input one sits above the machine and moves belt -> machine; the
      // output one sits below and moves machine -> belt. Same direction, because
      // both are carrying items southward down the row.
      entities.push({
        entity_number: n++,
        name: String(opts.inserter["name"]),
        position: { x: snap(cx, insFoot.width), y: snap(-inserterOffset, insFoot.height) },
        direction: NORTH,
      });
      entities.push({
        entity_number: n++,
        name: String(opts.inserter["name"]),
        position: { x: snap(cx, insFoot.width), y: snap(inserterOffset, insFoot.height) },
        direction: NORTH,
      });
    }
  }

  if (opts.belt && beltFoot) {
    const span = opts.machineCount * mFoot.width;
    for (let x = 0; x < span; x += beltFoot.width) {
      const cx = x + beltFoot.width / 2;
      entities.push({
        entity_number: n++,
        name: String(opts.belt["name"]),
        position: { x: snap(cx, beltFoot.width), y: snap(-beltOffset, beltFoot.height) },
        direction: EAST,
      });
      entities.push({
        entity_number: n++,
        name: String(opts.belt["name"]),
        position: { x: snap(cx, beltFoot.width), y: snap(beltOffset, beltFoot.height) },
        direction: EAST,
      });
    }
  }

  const blueprint: Blueprint = {
    item: "blueprint",
    label: opts.label,
    entities,
    icons: [{ signal: { name: opts.machine.name }, index: 1 }],
    version: 562949955649536,
  };

  const xs = entities.map((e) => e.position.x);
  const ys = entities.map((e) => e.position.y);
  return {
    blueprint,
    string: encode({ blueprint } as unknown as Decoded),
    entityCount: entities.length,
    width: Math.round(Math.max(...xs) - Math.min(...xs)) + mFoot.width,
    height: Math.round(Math.max(...ys) - Math.min(...ys)) + 1,
    gaps,
  };
}

/** The cheapest belt tier that carries a rate on one belt, or the fastest there is. */
export function beltFor(data: Data, ratePerSecond: number, preferred?: string): Proto | null {
  const belts = data.belts();
  if (belts.length === 0) return null;
  if (preferred) {
    const named = belts.find((b) => String(b["name"]) === preferred);
    if (!named) {
      throw new Error(
        `Unknown belt: ${preferred}. This snapshot has ${belts.map((b) => String(b["name"])).join(", ")}.`,
      );
    }
    return named;
  }
  const sorted = [...belts].sort((a, b) => beltItemsPerSecond(a) - beltItemsPerSecond(b));
  return sorted.find((b) => beltItemsPerSecond(b) >= ratePerSecond) ?? sorted[sorted.length - 1]!;
}
