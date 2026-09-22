import type { BpEntity } from "./blueprint.ts";
import type { Data } from "./proto.ts";
import { E, N, S, W, opposite, step, surfaceNodes, tileKey } from "./pipes.ts";

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

/**
 * The picture name each plain pipe in a print needs, by entity number.
 *
 * Pipes that are not plain pipes are absent: a pipe-to-ground has a direction
 * of its own and the generic sprite walk already draws the right mouth for it.
 */
export function pipeShapes(data: Data, entities: BpEntity[]): Map<number, string> {
  selfCheck(data);
  // The one builder, shared with `checkPlumbing`. It used to be a copy here,
  // and the copy carried the machine-edge rule that was silently wrong once.
  const at = surfaceNodes(data, entities);
  const out = new Map<number, string>();
  for (const e of entities) {
    if (e.name !== "pipe") continue;
    const x = e.position?.x ?? 0;
    const y = e.position?.y ?? 0;
    const open: number[] = [];
    for (const d of CARDINALS) {
      const [sx, sy] = step(d);
      const other = at.get(tileKey(x + sx, y + sy));
      // A join is reciprocal: the neighbour has to open back this way. That is
      // what makes an underground facing away read as no connection, and it is
      // the whole difference between drawing a corner and drawing a cross.
      if (other?.surface.includes(opposite(d))) open.push(d);
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

/**
 * The table's own guard, run once, before anything is drawn.
 *
 * The original defect was not a wrong name, it was NO lookup at all: the sprite
 * walk chose between the vertical and the horizontal from an entity direction
 * that a plain pipe does not have, so every pipe in a print drew as the same
 * stick. A guard that only checked names would have passed it. So this asserts
 * the three things whose absence produced it or could produce it again.
 *
 * It lives in the tool rather than in a script beside the tool, because a
 * script under `.local/` is gitignored and rots the first time somebody edits
 * the sprite walk. It costs one pass over sixteen strings, once per process.
 */
let checked = false;
function selfCheck(data: Data): void {
  if (checked) return;
  checked = true;

  // 1. Total and injective. Sixteen sets of open cardinals, sixteen distinct
  //    names, nothing to fall through to, so a case cannot be quietly lost.
  const names = new Set<string>();
  for (let mask = 0; mask < 16; mask += 1) {
    const open = CARDINALS.filter((_, i) => (mask & (1 << i)) !== 0);
    const name = PICTURE[open.join(",")];
    if (!name) {
      throw new Error(
        `The pipe picture table has no name for the open set [${open.join(",")}].\n` +
          "It must be total: sixteen sets, sixteen names, nothing to fall through to.",
      );
    }
    names.add(name);
  }
  if (names.size !== 16) {
    throw new Error(
      `The pipe picture table names ${String(names.size)} distinct pictures for 16 sets.\n` +
        "Two open sets sharing a picture means one of them is drawn wrong.",
    );
  }

  // 2. Every name is a picture the prototype actually declares. A table that
  //    agrees with itself and not with the game draws nothing at all.
  const proto = data.find("pipe", ["pipe"]);
  const pictures = proto?.["pictures"];
  if (typeof pictures !== "object" || pictures === null) {
    throw new Error("The pipe prototype declares no `pictures` in this snapshot.");
  }
  const have = new Set(Object.keys(pictures as Record<string, unknown>));
  const missing = [...names].filter((n) => !have.has(n));
  if (missing.length > 0) {
    throw new Error(
      `The pipe picture table names pictures the prototype does not declare: ${missing.join(", ")}.`,
    );
  }

  // 3. The regression the old behaviour passed. Two pipes in an L: the corner
  //    tile must resolve to a corner, never to the vertical straight. Every
  //    check this project had passed while that L drew as two sticks, which is
  //    why Soushi saw it and nobody here did.
  const at = new Map<string, { surface: number[] }>();
  at.set(tileKey(0, 0), { surface: [N, E, S, W] });
  at.set(tileKey(1, 0), { surface: [N, E, S, W] });
  at.set(tileKey(0, -1), { surface: [N, E, S, W] });
  const open: number[] = [];
  for (const d of CARDINALS) {
    const [sx, sy] = step(d);
    if (at.get(tileKey(sx, sy))?.surface.includes(opposite(d))) open.push(d);
  }
  const corner = PICTURE[open.join(",")];
  if (corner !== "corner_up_right") {
    throw new Error(
      `A pipe open up and right resolves to ${String(corner)}, not corner_up_right.\n` +
        "The picture names list the sides a pipe is OPEN on, measured off the shipped art.",
    );
  }
}
