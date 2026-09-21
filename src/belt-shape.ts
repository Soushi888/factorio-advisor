import type { BpEntity } from "./blueprint.ts";
import { BELT_ROW, COMPASS_NAME } from "./sprites.ts";
import { EAST, NORTH, SOUTH, WEST } from "./layout.ts";

/**
 * Which of the twenty belt pictures each tile needs (the way the game does it).
 *
 * The engine does not draw a belt from the belt's own direction. It draws it
 * from what the tile's NEIGHBOURS do: a belt fed from the side is a curve, a
 * belt nothing feeds gets a start cap, a belt whose output goes nowhere gets an
 * end cap, and only a belt fed from behind is the plain straight. Drawing the
 * straight everywhere and painting an arrow on top is the thing a blueprint
 * drawing must not do, because the shape of a belt IS the information: a corner
 * is visible as a corner and a dead end is visible as a dead end.
 *
 * Everything here works off the print's own entities. No prototype field says
 * which neighbour feeds which, so the rule is geometric: a thing feeds the tile
 * its output lands on, and a thing accepts from the tile behind its own front.
 */

/** One step in tiles, for each of the four directions a belt can run. */
function step(direction: number): [number, number] {
  if (direction === EAST) return [1, 0];
  if (direction === SOUTH) return [0, 1];
  if (direction === WEST) return [-1, 0];
  return [0, -1];
}

/** The compass name of a direction, for looking a row up by name. */
function nameOf(direction: number): string {
  if (direction === EAST) return "east";
  if (direction === SOUTH) return "south";
  if (direction === WEST) return "west";
  return "north";
}

/** The four cardinals a belt can face, snapped from the sixteen the game counts. */
function cardinal(direction: number): number {
  const d = ((Math.round(direction / 4) * 4) % 16 + 16) % 16;
  return d;
}

function key(x: number, y: number): string {
  return `${String(Math.round(x))},${String(Math.round(y))}`;
}

/** The tile an entity's centre sits in, as the key both sides of a join use. */
function tileKey(e: BpEntity): string {
  return key(Math.floor(e.position.x), Math.floor(e.position.y));
}

interface Node {
  entity: BpEntity;
  direction: number;
  type: string;
  /** Moves items along a belt line at all. */
  beltish: boolean;
}

/**
 * What a thing puts items onto, and what it takes them from.
 *
 * A transport belt and a splitter carry straight through. An underground belt
 * or a loader has two ends and the print says which this one is: an `output`
 * end emits onto the tile in front of it and takes nothing from the surface
 * behind, and an `input` end is the reverse. Nothing else in a print moves
 * items along a belt line, so nothing else counts as a neighbour here.
 */
function emitsForward(n: Node): boolean {
  if (n.type === "transport-belt" || n.type === "splitter") return true;
  if (n.type === "underground-belt" || n.type === "loader" || n.type === "loader-1x1") {
    return String(n.entity["type"] ?? "input") === "output";
  }
  return false;
}

function acceptsFromBehind(n: Node): boolean {
  if (n.type === "transport-belt" || n.type === "splitter") return true;
  if (n.type === "underground-belt" || n.type === "loader" || n.type === "loader-1x1") {
    return String(n.entity["type"] ?? "input") === "input";
  }
  return false;
}

export interface BeltShape {
  /** The row of the belt sheet this tile's surface should use. */
  row: number;
  /** Extra rows drawn over it: the start cap, the end cap, or neither. */
  caps: number[];
}

const BELT_TYPES = new Set(["transport-belt", "underground-belt", "splitter", "loader", "loader-1x1"]);

/**
 * Work out every belt tile's picture from the print as a whole.
 *
 * Returns a map keyed by `entity_number`, so a caller that draws entity by
 * entity does one lookup and no geometry of its own.
 */
export function beltShapes(
  entities: BpEntity[],
  typeOf: (name: string) => string,
): Map<number, BeltShape> {
  const nodes: Node[] = entities.map((entity) => {
    const type = typeOf(entity.name);
    return {
      entity,
      direction: cardinal(Number(entity.direction ?? 0)),
      type,
      beltish: BELT_TYPES.has(type),
    };
  });

  // Where each thing sits, and where each thing puts items. A splitter covers
  // two tiles, so it is registered on both and emits from both.
  const at = new Map<string, Node[]>();
  const emitsInto = new Map<string, Node[]>();
  for (const n of nodes) {
    if (!n.beltish) continue;
    const [dx, dy] = step(n.direction);
    const tiles = [tileKey(n.entity)];
    if (n.type === "splitter") {
      // The second tile is across the belt, on the side the position's own half
      // coordinate points at: a splitter centres on the seam between its tiles.
      const acrossX = dx === 0 ? 1 : 0;
      const acrossY = dx === 0 ? 0 : 1;
      tiles.push(key(Math.floor(n.entity.position.x) - acrossX, Math.floor(n.entity.position.y) - acrossY));
    }
    for (const t of tiles) {
      at.set(t, [...(at.get(t) ?? []), n]);
      if (!emitsForward(n)) continue;
      const [tx, ty] = t.split(",").map(Number) as [number, number];
      const target = key(tx + dx, ty + dy);
      emitsInto.set(target, [...(emitsInto.get(target) ?? []), n]);
    }
  }

  const out = new Map<number, BeltShape>();
  for (const n of nodes) {
    if (n.type !== "transport-belt") continue;
    const tile = tileKey(n.entity);
    const [tx, ty] = tile.split(",").map(Number) as [number, number];
    const [dx, dy] = step(n.direction);

    const feeders = emitsInto.get(tile) ?? [];
    const fedFrom = new Set<string>();
    for (const f of feeders) {
      if (f.entity.entity_number === n.entity.entity_number) continue;
      const [fx, fy] = tileKey(f.entity).split(",").map(Number) as [number, number];
      // Which side of this tile the feeder sits on, as a compass name.
      if (fx === tx + 1 && fy === ty) fedFrom.add("east");
      else if (fx === tx - 1 && fy === ty) fedFrom.add("west");
      else if (fy === ty + 1 && fx === tx) fedFrom.add("south");
      else if (fy === ty - 1 && fx === tx) fedFrom.add("north");
    }

    const behind = nameOf(cardinal((n.direction + 8) % 16));
    const facing = nameOf(n.direction);
    const sides = [...fedFrom].filter((s) => s !== behind && s !== facing);

    // A belt fed from behind is straight however many sides also feed it: that
    // is side loading, and the game draws it straight. A curve is the case where
    // the ONLY thing feeding it comes in from one side.
    let row = BELT_ROW[facing] ?? 0;
    if (!fedFrom.has(behind) && sides.length === 1) {
      row = BELT_ROW[`${sides[0]!}_to_${facing}`] ?? row;
    }

    const caps: number[] = [];
    if (fedFrom.size === 0) {
      const start = BELT_ROW[`starting_${facing}`];
      if (start !== undefined) caps.push(start);
    }
    const ahead = at.get(key(tx + dx, ty + dy)) ?? [];
    const taken = ahead.some((a) => {
      if (!acceptsFromBehind(a)) return false;
      // A belt pointing straight back at this one does not accept from it.
      return a.direction !== cardinal((n.direction + 8) % 16);
    });
    if (!taken) {
      const end = BELT_ROW[`ending_${facing}`];
      if (end !== undefined) caps.push(end);
    }

    out.set(n.entity.entity_number, { row, caps });
  }
  return out;
}

/** Exported for the probe that checks a direction against the sheet's own rows. */
export const STRAIGHT_ROWS = COMPASS_NAME.map((name) => ({ name, row: BELT_ROW[name] ?? 0 }));

/** The four directions, as the drawing's own vocabulary. */
export const CARDINALS = [NORTH, EAST, SOUTH, WEST];
