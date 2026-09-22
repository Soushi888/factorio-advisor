import type { BpEntity } from "./blueprint.ts";
import type { Data } from "./proto.ts";
import { E, N, S, W, opposite, portsAt, step } from "./pipes.ts";

/**
 * Which of a pipe's eighteen pictures each tile needs (the way the game does it).
 *
 * A plain pipe carries no direction at all, so nothing on the entity says what
 * it should look like. The engine draws it from what its NEIGHBOURS do: a pipe
 * with two connections facing each other is a straight, one with two at right
 * angles is a corner, three is a T and four is a cross, and a pipe with one
 * connection gets the cap that leaves its open side open. Drawing the vertical
 * straight everywhere, which is what a direction of zero implies and what this
 * tool did before, turns every corner and every junction in a print into a run
 * of disconnected sticks. The shape of a pipe IS the information, exactly as it
 * is for a belt, and `belt-shape.ts` is the same idea for the other half.
 *
 * The naming is the game's and it lists the OPEN sides, which was measured off
 * the shipped art rather than assumed: `corner_up_left` is open up and left,
 * `t_up` is open up, left and right, and `ending_up` is open upward, confirmed
 * by differencing it against `straight_vertical` and finding the change in the
 * bottom half. That check exists because the sibling belt rows were read in the
 * wrong order for a whole evening by a check that read a drawn arrow.
 */

/** The four cardinals in the order a shape key counts them. */
const CARDINALS = [N, E, S, W] as const;

/**
 * Every connection set a pipe can have, as the picture the game draws for it.
 *
 * Keyed by the open directions in `CARDINALS` order joined by a comma, so the
 * lookup is total: sixteen sets, sixteen names, nothing to fall through to.
 */
const PICTURE: Record<string, string> = {
  "": "straight_vertical_single",
  "0": "ending_up",
  "4": "ending_right",
  "8": "ending_down",
  "12": "ending_left",
  "0,8": "straight_vertical",
  "4,12": "straight_horizontal",
  "0,12": "corner_up_left",
  "0,4": "corner_up_right",
  "8,12": "corner_down_left",
  "4,8": "corner_down_right",
  "0,4,12": "t_up",
  "4,8,12": "t_down",
  "0,8,12": "t_left",
  "0,4,8": "t_right",
  "0,4,8,12": "cross",
};

/** What stands on a tile, and which ways it can take a fluid on the surface. */
interface Surface {
  /** Directions this thing connects on, from its own tile, above ground. */
  faces: number[];
}

function key(x: number, y: number): string {
  return `${String(Math.round(x))}:${String(Math.round(y))}`;
}

/**
 * Every tile in a print that can meet a pipe, and the ways it can meet one.
 *
 * A plain pipe meets anything on all four sides. A pipe-to-ground opens only
 * toward its own facing, which is why an underground laid backwards reads as a
 * dead end here rather than as a join. A machine registers its EDGE tile rather
 * than its port tile, facing outward, because a pipe standing on the port tile
 * would otherwise overwrite the very thing it is connecting to: the same trap
 * `checkPlumbing` records, and this duplicates its node build rather than
 * sharing one, which is a seam worth closing when both are next touched.
 */
function surfaces(data: Data, entities: BpEntity[]): Map<string, Surface> {
  const at = new Map<string, Surface>();
  for (const e of entities) {
    const x = e.position?.x ?? 0;
    const y = e.position?.y ?? 0;
    const dir = e.direction ?? 0;
    if (e.name === "pipe") {
      at.set(key(x, y), { faces: [...CARDINALS] });
    } else if (e.name === "pipe-to-ground") {
      at.set(key(x, y), { faces: [dir] });
    } else {
      const proto = data.find(e.name, data.entityClasses());
      if (!proto) continue;
      for (const p of portsAt(proto, [x, y], dir)) {
        const [sx, sy] = step(p.facing);
        at.set(key(p.tile[0] - sx, p.tile[1] - sy), { faces: [p.facing] });
      }
    }
  }
  return at;
}

/**
 * The picture name each plain pipe in a print needs, by entity number.
 *
 * Pipes that are not plain pipes are absent: a pipe-to-ground has a direction
 * of its own and the generic sprite walk already draws the right mouth for it.
 */
export function pipeShapes(data: Data, entities: BpEntity[]): Map<number, string> {
  const at = surfaces(data, entities);
  const out = new Map<number, string>();
  for (const e of entities) {
    if (e.name !== "pipe") continue;
    const x = e.position?.x ?? 0;
    const y = e.position?.y ?? 0;
    const open: number[] = [];
    for (const d of CARDINALS) {
      const [sx, sy] = step(d);
      const other = at.get(key(x + sx, y + sy));
      // A join is reciprocal: the neighbour has to open back this way. That is
      // what makes an underground facing away read as no connection, and it is
      // the whole difference between drawing a corner and drawing a cross.
      if (other?.faces.includes(opposite(d))) open.push(d);
    }
    const name = PICTURE[open.join(",")];
    if (name) out.set(e.entity_number, name);
  }
  return out;
}

/** Exported for the shape table's own test: every set of cardinals is named. */
export const PIPE_PICTURE = PICTURE;
export const PIPE_CARDINALS = CARDINALS;
export { E, N, S, W };
