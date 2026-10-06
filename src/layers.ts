/**
 * The layer model for the one map (C33, extended for C32).
 *
 * `map.ts` bakes a whole map into one SVG string, which is the right shape for a
 * thumbnail and the wrong one for a map you can switch parts of on and off. This
 * builds the same geometry as a list of layers instead, each with its own body,
 * its own count and its own mark, so the page can toggle a `<g>` rather than
 * re-render.
 *
 * Three things this file has to get right, and all three are about the map
 * telling the truth rather than looking good.
 *
 * **Tile by tile.** Soushi asked for it on 2026-09-21 and the collector now
 * carries it: every placed entity's own position, water as tile runs, ore as
 * tile runs. So a machine is drawn at the footprint its prototype declares,
 * at the coordinate the engine reported, and the shoreline is the real
 * shoreline. Nothing here is a bucket except the pollution cloud, which the
 * engine itself only reports per chunk.
 *
 * **Readable at both ends of the zoom.** The base spans 2655 tiles and the pane
 * is about 600 pixels, so a 3 by 3 assembler is half a pixel at the whole-base
 * view: drawn plainly, the map is a grey smudge. Every shape is therefore
 * stroked with `vector-effect: non-scaling-stroke`, a width in SCREEN pixels
 * that the page thins as the view closes in. Far out you see the stroke and
 * nothing vanishes; close in you see the true rectangle. That is the pair of
 * behaviours the game's own map has.
 *
 * **Counts that match the dashboard.** A layer reports what it DREW and what the
 * census says EXISTS, and names the difference. They agree now that positions
 * are kept for everything, and the machinery stays because the budget in
 * `state.ts` can still drop the commonest prototype on a bigger save, and a map
 * quietly drawing three quarters of a base is worse than one that says so.
 */

import type { GameState, SurfaceMap } from "./state.ts";
import { type Area } from "./map.ts";
import type { RecipeBlock } from "./map.ts";
import type { Data, Proto } from "./proto.ts";
import { footprintOf } from "./layout.ts";
import { cutArea, cutterAvailable, dataUriAt, iconCut, largestPicture, spritesFor, PIXELS_PER_TILE } from "./sprites.ts";
import type { SpriteCut } from "./sprites.ts";

/** A mark for the legend key, so no layer is told apart by colour alone. */
export type Mark = "dot" | "square" | "fill" | "box";

/** Which part of the legend a layer belongs to. */
export type LayerGroup = "ground" | "base" | "places";

export interface MapLayer {
  id: string;
  label: string;
  colour: string;
  mark: Mark;
  group: LayerGroup;
  /** On when the page opens. */
  on: boolean;
  /** Entities, tiles or areas actually drawn. */
  drawn: number;
  /** What the census says exists, when the layer maps onto census prototypes. */
  census: number;
  /** Prototypes the census counts but the collector gave no positions for. */
  missing: Array<{ name: string; count: number }>;
  /** SVG shapes, with no wrapping group: the page owns the `<g>`. */
  body: string;
  /** One line under the legend entry, when there is something to say. */
  note: string;
}

export interface MapModel {
  surface: string;
  cellTiles: number;
  viewBox: { x: number; y: number; w: number; h: number };
  layers: MapLayer[];
  /** What a click can read, beside what the eye can see. */
  facts: MapFacts;
}

/** Where a click on a line of text should send the map. */
export interface Focus {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The layer that explains the place, turned on by the same click. */
  layer: string;
}

const ORE_COLOURS: Record<string, string> = {
  "iron-ore": "#8fb0d8",
  "copper-ore": "#d98b52",
  coal: "#4e4e58",
  stone: "#c2b184",
  "uranium-ore": "#5fd98f",
  "crude-oil": "#a678d8",
};

/**
 * Entity types, grouped by the part of the base a player would call them.
 *
 * Types rather than prototype names, so a new belt tier or a foundry joins the
 * right layer without this list being edited. The name of every placed entity
 * comes from the save and its type from the snapshot, so nothing here decides
 * what exists; it only decides which colour it is drawn in.
 */
const DOMAINS = {
  rail: [
    "straight-rail",
    "curved-rail-a",
    "curved-rail-b",
    "half-diagonal-rail",
    "elevated-straight-rail",
    "elevated-curved-rail-a",
    "elevated-curved-rail-b",
    "rail-signal",
    "rail-chain-signal",
    "train-stop",
    "locomotive",
    "cargo-wagon",
    "fluid-wagon",
    "artillery-wagon",
  ],
  belts: ["transport-belt", "underground-belt", "splitter", "lane-splitter", "loader", "loader-1x1", "inserter"],
  pipes: ["pipe", "pipe-to-ground", "pump", "storage-tank", "offshore-pump"],
  walls: ["wall", "gate"],
  power: [
    "electric-pole",
    "generator",
    "boiler",
    "solar-panel",
    "accumulator",
    "reactor",
    "heat-pipe",
    "heat-interface",
    "burner-generator",
    "fusion-reactor",
    "fusion-generator",
  ],
  production: ["assembling-machine", "furnace", "rocket-silo", "cargo-landing-pad", "beacon"],
  mining: ["mining-drill"],
  defence: ["ammo-turret", "electric-turret", "fluid-turret", "artillery-turret", "turret", "radar"],
  logistics: ["roboport", "container", "logistic-container", "linked-container", "car", "spider-vehicle"],
  science: ["lab"],
} as const;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

function round(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/**
 * Every entity of a group, drawn at the size it really is.
 *
 * One path, one rectangular subpath per entity, at the footprint the prototype
 * declares. `footprintOf` returns null for a prototype with no selection box,
 * which is a gap rather than a number to invent: those fall back to a single
 * tile and the layer's note says how many did.
 */
/**
 * One path per prototype rather than one per layer, carrying the prototype's
 * name, so a click on any outline can say what it is. The art layer used to be
 * the only thing a click could name, which left every prototype without art,
 * the silo first among them, answering with nothing but its chunk.
 */
function footprints(groups: Array<{ name: string; points: Array<[number, number]>; w: number; h: number }>, cls = "fp"): string {
  const out: string[] = [];
  for (const g of groups) {
    const d: string[] = [];
    if (g.w === 1 && g.h === 1) {
      // Single-tile entities are merged into runs first. A belt line is 1x1
      // repeated fifty times, and fifty rectangles cost fifty times what one
      // does to rasterise: this save draws 29624 belt pieces, and merging them
      // into the lines they already form is the difference between a map that
      // pans and one that stutters. Exactness is untouched, because a run
      // covers exactly the tiles the entities stand on.
      for (const [x, y, w, h] of merged(g.points)) {
        d.push(`M${round(x)} ${round(y)}h${round(w)}v${round(h)}h${round(-w)}z`);
      }
    } else {
      const hw = g.w / 2;
      const hh = g.h / 2;
      for (const [x, y] of g.points) {
        d.push(`M${round(x - hw)} ${round(y - hh)}h${round(g.w)}v${round(g.h)}h${round(-g.w)}z`);
      }
    }
    if (d.length > 0) out.push(`<path class="${cls}" data-n="${esc(g.name)}" d="${d.join("")}"/>`);
  }
  return out.join("");
}

/**
 * Single-tile positions merged into the longest rectangles that cover them.
 *
 * Horizontally first, since a belt line is usually a row; whatever is left as a
 * single tile is then merged down its column, which catches the vertical runs.
 * The output covers exactly the same tiles as the input, so nothing is drawn
 * that is not there and nothing there goes undrawn.
 */
function merged(points: Array<[number, number]>): Array<[number, number, number, number]> {
  const rows = new Map<number, number[]>();
  for (const [cx, cy] of points) {
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    const row = rows.get(y);
    if (row) row.push(x);
    else rows.set(y, [x]);
  }

  const out: Array<[number, number, number, number]> = [];
  const singles: Array<[number, number]> = [];
  for (const [y, xs] of rows) {
    xs.sort((a, b) => a - b);
    let start = xs[0]!;
    let prev = start;
    for (let i = 1; i <= xs.length; i += 1) {
      const x = xs[i];
      if (x !== undefined && x === prev + 1) {
        prev = x;
        continue;
      }
      const width = prev - start + 1;
      if (width === 1) singles.push([start, y]);
      else out.push([start, y, width, 1]);
      if (x === undefined) break;
      start = x;
      prev = x;
    }
  }

  // What is left is one tile wide, so try the other direction.
  const cols = new Map<number, number[]>();
  for (const [x, y] of singles) {
    const col = cols.get(x);
    if (col) col.push(y);
    else cols.set(x, [y]);
  }
  for (const [x, ys] of cols) {
    ys.sort((a, b) => a - b);
    let start = ys[0]!;
    let prev = start;
    for (let i = 1; i <= ys.length; i += 1) {
      const y = ys[i];
      if (y !== undefined && y === prev + 1) {
        prev = y;
        continue;
      }
      out.push([x, start, 1, prev - start + 1]);
      if (y === undefined) break;
      start = y;
      prev = y;
    }
  }
  return out;
}

/**
 * Tile runs, as one path of rectangles.
 *
 * A run is `[x, y, length]` in whole tiles, which is how the collector records
 * water and ore: a lake is mostly long rows of the same thing, so a run keeps
 * the exact shoreline at a fraction of the size of one entry per tile.
 */
function runPath(runs: Array<[number, number, number]>, cls: string, fill?: string): string {
  if (runs.length === 0) return "";
  const d = runs.map(([x, y, n]) => `M${round(x)} ${round(y)}h${round(n)}v1h${round(-n)}z`).join("");
  return `<path class="${cls}"${fill ? ` fill="${fill}" color="${fill}"` : ""} d="${d}"/>`;
}

/**
 * A stop name as Soushi wrote it, stripped of 2.0 rich-text markers for display.
 *
 * The name in the state file is untouched: this only decides what goes on the
 * map, where fifteen characters of `[virtual-signal=...]` would bury the word
 * the name is actually about.
 */
function cleanStopName(name: string): string {
  return name.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim() || name;
}

/**
 * How much a label is worth keeping when two of them would overprint.
 *
 * The page hides the loser of every collision at the current zoom, and this is
 * the order it hides them in: a power block over an ore field over a train stop
 * over a recipe block, and within one kind the larger place first. A name is
 * never removed from the document, only from the frame where it would land on
 * another one, so zooming in brings it back and a click still reads it.
 */
const LABEL_RANK = { power: 4, ore: 3, stop: 2, block: 1 } as const;
type LabelKind = keyof typeof LABEL_RANK;

function labelRank(kind: LabelKind, size: number): number {
  return LABEL_RANK[kind] * 1e7 + Math.min(1e7 - 1, Math.max(0, Math.round(size)));
}

/** A label the page keeps at a readable size, with a halo so it survives anything under it. */
function label(x: number, y: number, text: string, rank: number): string {
  return `<text class="lbl" data-p="${String(rank)}" x="${round(x)}" y="${round(y)}">${esc(text)}</text>`;
}

function areaShapes(areas: Area[], kind?: LabelKind): string {
  return areas
    .map((a) => {
      const text = kind ? label(a.x + a.w / 2, a.y - 3, a.label, labelRank(kind, a.w * a.h)) : "";
      return (
        `<g class="area ${a.tone}" data-x="${a.x.toFixed(0)}" data-y="${a.y.toFixed(0)}" ` +
        `data-w="${a.w.toFixed(0)}" data-h="${a.h.toFixed(0)}">` +
        `<rect x="${a.x.toFixed(0)}" y="${a.y.toFixed(0)}" ` +
        `width="${a.w.toFixed(0)}" height="${a.h.toFixed(0)}"/>` +
        `<title>${esc(a.label)}</title>${text}</g>`
      );
    })
    .join("");
}

/**
 * Chunk squares, banded by opacity into a handful of paths.
 *
 * One `<rect>` per chunk is 3823 DOM nodes for the charted ground alone, and
 * the browser lays out and rasterises every one of them on every pan. Rounding
 * the opacity to a few bands and emitting one path per band leaves the map
 * looking the same and the document a few nodes long. The cost is the per-chunk
 * tooltip, which said what the legend already says.
 */
const OPACITY_BANDS = 6;

function chunkPaths(
  cells: Array<{ cx: number; cy: number; opacity: number; size?: number }>,
  cell: number,
): string {
  const bands = new Map<number, string[]>();
  for (const c of cells) {
    const band = Math.max(1, Math.round(c.opacity * OPACITY_BANDS));
    const size = c.size ?? cell;
    const inset = (cell - size) / 2;
    const x = c.cx * cell + inset;
    const y = c.cy * cell + inset;
    const d = `M${round(x)} ${round(y)}h${round(size)}v${round(size)}h${round(-size)}z`;
    const list = bands.get(band);
    if (list) list.push(d);
    else bands.set(band, [d]);
  }
  return [...bands.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([band, ds]) => `<path opacity="${(band / OPACITY_BANDS).toFixed(2)}" d="${ds.join("")}"/>`)
    .join("");
}

/** What the snapshot says about a placed prototype: which family, and how big. */
interface Shape {
  type: string;
  w: number;
  h: number;
  guessed: boolean;
}

function shapesOf(data: Data | null, names: string[]): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const name of names) {
    const protos: Proto[] = data?.all(name) ?? [];
    // An entity prototype is the one carrying a selection box; an item of the
    // same name does not, which is why this picks rather than takes the first.
    const proto = protos.find((p) => "selection_box" in p) ?? protos[0] ?? null;
    const foot = proto ? footprintOf(proto) : null;
    out.set(name, {
      type: proto ? String(proto.type ?? "") : "",
      w: foot?.width ?? 1,
      h: foot?.height ?? 1,
      guessed: foot === null,
    });
  }
  return out;
}

/**
 * Types drawn with a fine mark rather than the layer's full ink.
 *
 * A pole is everywhere power reaches, so at the whole-base zoom its marks are
 * a spray of dots across every block, the same weight as the engines and
 * boilers that are the reason to look at the layer. Drawn fine, the poles still
 * show where the grid reaches and the generators stand out of it. They go first
 * in the layer so the machines paint over them.
 */
const THIN_TYPES = new Set<string>(["electric-pole"]);

/**
 * Pixels a tile carries in embedded art. The closest the page zooms is one
 * chunk across the pane, about 25 screen pixels a tile on an 800 pixel pane, so
 * 32 is enough at any zoom it allows.
 */
const ART_PX_PER_TILE = 32;

/** Track pieces, whose art depends on a direction the save does not record. */
const RAIL_TRACK = new Set<string>([
  "straight-rail",
  "curved-rail-a",
  "curved-rail-b",
  "half-diagonal-rail",
  "elevated-straight-rail",
  "elevated-curved-rail-a",
  "elevated-curved-rail-b",
  "elevated-half-diagonal-rail",
]);

/** Placed things that are not parts of the base: they move, or they are not built yet. */
const NOT_BUILDINGS = ["construction-robot", "logistic-robot", "combat-robot", "entity-ghost", "tile-ghost", "character", "character-corpse", "item-entity", "item-request-proxy", "corpse", "fish", "tree", "simple-entity", "resource", "unit", "unit-spawner", "turret", "spider-unit", "segmented-unit", "asteroid", "plant", "cliff", "projectile", "explosion", "fire", "sticker"];

interface BuildContext {
  map: SurfaceMap;
  shapes: Map<string, Shape>;
  census: Record<string, number>;
  dropped: Map<string, number>;
}

/**
 * One layer: every placed entity whose prototype's type belongs to this family.
 *
 * The count reconciliation is the part worth reading. `drawn` is how many
 * rectangles went on the map. `census` is what the game says the force owns, and
 * it only covers prototypes that declare an energy source, so a train stop, a
 * wagon and a wall appear in the positions and in no census row. Where the
 * census is silent the positions are the only count there is, and where the
 * budget dropped a prototype the difference is named rather than absorbed.
 */
function entityLayer(
  id: string,
  labelText: string,
  colour: string,
  mark: Mark,
  group: LayerGroup,
  types: readonly string[],
  ctx: BuildContext,
  on: boolean,
): MapLayer {
  const want = new Set<string>(types);
  const groups: Array<{ name: string; points: Array<[number, number]>; w: number; h: number }> = [];
  const thin: typeof groups = [];
  const missing: Array<{ name: string; count: number }> = [];
  let drawn = 0;
  let census = 0;
  let guessed = 0;

  for (const [name, points] of Object.entries(ctx.map.points)) {
    const shape = ctx.shapes.get(name);
    if (!shape || !want.has(shape.type)) continue;
    (THIN_TYPES.has(shape.type) ? thin : groups).push({ name, points, w: shape.w, h: shape.h });
    drawn += points.length;
    if (shape.guessed) guessed += points.length;
    census += Math.max(points.length, ctx.census[name] ?? 0);
  }

  // Anything the budget dropped, or anything the census knows about and the
  // positions do not, still has to be counted somewhere.
  for (const [name, count] of ctx.dropped) {
    const shape = ctx.shapes.get(name);
    if (!shape || !want.has(shape.type)) continue;
    missing.push({ name, count });
    census += count;
  }
  for (const [name, count] of Object.entries(ctx.census)) {
    if (ctx.map.points[name] || ctx.dropped.has(name)) continue;
    const shape = ctx.shapes.get(name);
    if (!shape || !want.has(shape.type)) continue;
    missing.push({ name, count });
    census += count;
  }
  missing.sort((a, b) => b.count - a.count);

  const notes: string[] = [];
  if (missing.length > 0) {
    notes.push(
      `${String(missing.reduce((n, m) => n + m.count, 0))} not drawn ` +
        `(${missing.map((m) => m.name).join(", ")})`,
    );
  }
  if (guessed > 0) notes.push(`${String(guessed)} drawn at one tile: no selection box in the snapshot`);

  return {
    id,
    label: labelText,
    colour,
    mark,
    group,
    on,
    drawn,
    census,
    missing,
    body: footprints(thin, "fp thin") + footprints(groups),
    note: notes.join(" · "),
  };
}

export interface ModelInput {
  state: GameState;
  map: SurfaceMap;
  /** The game's own icons, so a panel can show the thing it names. */
  icons?: { url(name: string): string | null } | null;
  /** The prototype snapshot, for footprints and types. */
  data?: Data | null;
  /** The bus corridors, when a belt survey has been read for this save. */
  busAreas?: Area[];
  /**
   * Why the corridors are absent, when they are (MAP-3).
   *
   * Three different facts that the page used to render as one sentence. `none`
   * is no survey at all, which is the one the old text described. `stale` is a
   * survey that exists and describes a DIFFERENT tick, which is the dangerous
   * one: the layer is refused on purpose and a legend saying "none read" sends
   * the reader to run a command that will not help. `ok` is a survey at this
   * tick, whether or not it found any corridors.
   */
  busSurvey?: { state: "ok" | "none" | "stale"; tick?: number; stateTick?: number };
  /** Machine blocks, already clustered by recipe (MAP-4). */
  recipeBlocks?: RecipeBlock[];
  /** The belt survey for this surface, when it came back at this tick. */
  belts?: Array<{ x: number; y: number; dir?: number; lanes: Array<{ item: string; count: number }> }>;
  /** The places the advice points at. */
  adviceAreas?: Area[];
  /** Power blocks and ore fields, already derived by `advise.ts`. */
  powerAreas?: Area[];
  oreAreas?: Area[];
  force?: string;
}

/**
 * Everything the page can say about a place, as data rather than as drawing.
 *
 * The map draws merged runs and banded paths, which is what makes it fast and
 * what makes a single entity impossible to hit-test out of it. So the facts
 * travel beside the picture: what stands in each chunk, what ore is under it,
 * what the census and the engine say about each prototype. A click reads this;
 * it computes nothing and it invents nothing, and a prototype the state file
 * has no row for simply has fewer lines in its panel.
 */
export interface MapFacts {
  cell: number;
  /** Per chunk, keyed `cx,cy`: what the force has standing there. */
  chunks: Record<string, { by: Record<string, number>; total: number; pollution?: number }>;
  /** Per chunk: remaining amount by resource. */
  ore: Record<string, Record<string, number>>;
  /** Per chunk: nests and worms. */
  enemy: Record<string, [number, number]>;
  /** Per prototype the census or the points know about. */
  protos: Record<
    string,
    {
      /** The entity type, for the sentence that says what kind of thing it is. */
      type: string;
      /** Placed, from the census. Absent for a class the census does not count. */
      count?: number;
      /** Tile footprint. */
      w: number;
      h: number;
      /** The game's own icon, when the installation has one. */
      icon?: string;
      /** The engine's own resolved figures, in watts and joules. */
      usage?: number;
      drain?: number;
      buffer?: number;
      /** Slots for a chest, fluid volume for a tank, from the prototype. */
      slots?: number;
      volume?: number;
    }
  >;
  /** Every machine the save read: x, y, prototype, recipe ("" for none), modules by name. */
  machines: Array<[number, number, string, string, Record<string, number> | 0]>;
  /** Every container the save read: x, y, prototype, items by name, fluid. */
  holds: Array<[number, number, string, Record<string, number> | 0, { name: string; amount: number } | 0]>;
  /** The game's own icon for every recipe, module, item and fluid the two lists name. */
  icons: Record<string, string>;
  /**
   * Every belt tile carrying something, packed as base64 of an Int16Array of
   * sevens: tile x, tile y, direction (sixteenths), left lane item, left count,
   * right lane item, right count. An item is an index into `beltItems`, -1 for
   * an empty lane. Packed because 27776 tiles as JSON objects were a megabyte.
   */
  belts: string;
  beltItems: string[];
}

/**
 * How many machines a block needs before its name is drawn on the map.
 *
 * A reading choice, named here rather than buried. Three is where a row starts
 * looking like a line rather than a stray machine, and it leaves 56 one-machine
 * blocks on this save drawn but unlabelled, which the click panel still names.
 */
const NAMED_BLOCK_MACHINES = 3;

/**
 * A colour for an item, derived from its own name.
 *
 * Deliberately not a table of hand-picked colours: this project refuses to type
 * in game facts, and "iron plate is grey" is a game fact somebody would have to
 * keep. A hash to a hue is stable across reads, distinct enough to tell twenty
 * items apart, and says nothing the data does not.
 */
function hueOf(item: string): string {
  let h = 0;
  for (let i = 0; i < item.length; i += 1) h = (h * 31 + item.charCodeAt(i)) % 360;
  return `hsl(${String(h)} 62% 56%)`;
}

/** Points merged into runs and emitted as one path, filled and titled by item. */
function runsOf(points: Array<[number, number]>, item: string): string {
  const parts = merged(points).map(
    ([x, y, w, h]) => `M${round(x)} ${round(y)}h${round(w)}v${round(h)}h${round(-w)}z`,
  );
  if (parts.length === 0) return "";
  return (
    `<path vector-effect="non-scaling-stroke" fill="${hueOf(item)}" ` +
    `d="${parts.join("")}"><title>${esc(item)}</title></path>`
  );
}

/** What the belt layer says about itself when it has nothing to draw. */
function beltNote(
  drawn: number,
  survey: { state: "ok" | "none" | "stale"; tick?: number; stateTick?: number } | undefined,
): string {
  if (survey?.state === "stale") {
    const behind =
      survey.tick !== undefined && survey.stateTick !== undefined
        ? ` (${String(Math.round((survey.stateTick - survey.tick) / 3600))} minutes of play apart)`
        : "";
    return `refused: the belt survey is from another tick${behind}, so it would be drawn over a base it no longer matches`;
  }
  if (drawn > 0) return `${String(drawn)} clusters of parallel belt runs`;
  if (survey?.state === "ok") return "the survey found no bus corridors on this surface";
  return "no belt survey in this read: bun run report, which now collects one";
}

export function mapModel(input: ModelInput): MapModel {
  const { state, map } = input;
  const census = state.forces[input.force ?? "player"]?.machines ?? {};
  const cell = map.cellTiles;
  const b = map.bounds;
  const pad = cell;
  const viewBox = b
    ? {
        x: b.minX - pad,
        y: b.minY - pad,
        w: b.maxX - b.minX + pad * 2,
        h: b.maxY - b.minY + pad * 2,
      }
    : { x: 0, y: 0, w: 1, h: 1 };

  const dropped = new Map<string, number>(
    (map.pointsDropped ?? []).map((d) => [d.name, d.count] as const),
  );
  const names = new Set<string>([
    ...Object.keys(map.points),
    ...Object.keys(census),
    ...dropped.keys(),
  ]);
  const ctx: BuildContext = {
    map,
    census,
    dropped,
    shapes: shapesOf(input.data ?? null, [...names]),
  };

  const layers: MapLayer[] = [];

  // ---- The ground -------------------------------------------------------
  //
  // Drawn first so everything else sits on it, and drawn at all because the
  // first version of this map had no ground: a base with no coastline and no
  // charted edge is an abstract diagram, and the map Soushi already has in the
  // game is not.

  const terrain = map.terrain ?? [];
  if (terrain.length > 0) {
    layers.push({
      id: "ground",
      label: "Charted ground",
      colour: "#6b6f78",
      mark: "fill",
      group: "ground",
      on: true,
      drawn: terrain.length,
      census: terrain.length,
      missing: [],
      note: `${String(terrain.length)} chunks charted: the extent the map in game would show you`,
      body: chunkPaths(terrain.map((t) => ({ cx: t.cx, cy: t.cy, opacity: 0.1 })), cell),
    });
  }

  const water = map.water ?? [];
  if (water.length > 0) {
    const tiles = water.reduce((n, r) => n + r[2], 0);
    layers.push({
      id: "water",
      label: "Water",
      colour: "#3f77b8",
      mark: "fill",
      group: "ground",
      on: true,
      drawn: tiles,
      census: tiles,
      missing: [],
      note: `${String(tiles)} water tiles, at their own edges`,
      body: runPath(water, "tile water"),
    });
  }

  // Ore, tile by tile, each resource in its own colour, and the named fields
  // carrying their own labels: a patch with a name on it is the difference
  // between a coloured shape and somewhere to put the next outpost.
  const oreRuns = map.oreRuns ?? {};
  const oreNames = Object.keys(oreRuns).sort();
  let oreTiles = 0;
  const oreBody: string[] = [];
  for (const name of oreNames) {
    const runs = oreRuns[name] ?? [];
    oreTiles += runs.reduce((n, r) => n + r[2], 0);
    oreBody.push(runPath(runs, "tile", ORE_COLOURS[name] ?? "#8a8a8a"));
  }
  if (oreBody.length > 0) {
    layers.push({
      id: "ore",
      label: "Ore and oil",
      colour: "#c2b184",
      mark: "fill",
      group: "ground",
      on: true,
      drawn: oreTiles,
      census: oreTiles,
      missing: [],
      note: `${oreNames.join(", ")}, each in its own colour`,
      body: oreBody.join("") + areaShapes(input.oreAreas ?? [], "ore"),
    });
  }

  const enemy = map.enemy ?? [];
  if (enemy.length > 0) {
    const nests = enemy.reduce((n, e) => n + e.nests, 0);
    const worms = enemy.reduce((n, e) => n + e.worms, 0);
    const max = Math.max(...enemy.map((e) => e.nests + e.worms));
    layers.push({
      id: "enemy",
      label: "Nests",
      colour: "#c0455a",
      mark: "fill",
      group: "ground",
      on: true,
      drawn: nests + worms,
      census: nests + worms,
      missing: [],
      note: `${String(nests)} nests and ${String(worms)} worms in the charted area, counted per chunk`,
      body: chunkPaths(
        enemy.map((e) => ({
          cx: e.cx,
          cy: e.cy,
          opacity: 0.45,
          // Sized by how much is in the chunk and centred on it, never filling
          // it: the count is real and the position is the chunk, which is as
          // precise as this measurement gets.
          size: cell * Math.min(0.55, 0.18 + 0.37 * Math.sqrt((e.nests + e.worms) / Math.max(1, max))),
        })),
        cell,
      ),
    });
  }

  const polluted = map.cells.filter((c) => (c.pollution ?? 0) > 0);
  if (polluted.length > 0) {
    const max = Math.max(...polluted.map((c) => c.pollution ?? 0));
    layers.push({
      id: "pollution",
      label: "Pollution",
      colour: "#9a7a3a",
      mark: "fill",
      group: "ground",
      on: false,
      drawn: polluted.length,
      census: polluted.length,
      missing: [],
      note: `the surface's own cloud, read at each chunk centre, up to ${String(Math.round(max))}`,
      body: chunkPaths(
        polluted.map((c) => ({
          cx: c.cx,
          cy: c.cy,
          opacity: Math.min(0.55, 0.08 + 0.47 * Math.sqrt((c.pollution ?? 0) / max)),
        })),
        cell,
      ),
    });
  }

  // ---- The base ---------------------------------------------------------
  //
  // Ordered so the things a player looks for end up on top of the things that
  // merely cover ground: belts and rails under machines, machines under
  // turrets and labs.

  layers.push(entityLayer("rail", "Rail network", "#9aa3b0", "square", "base", DOMAINS.rail, ctx, true));
  layers.push(entityLayer("belts", "Belts and inserters", "#d8b64a", "square", "base", DOMAINS.belts, ctx, true));
  layers.push(entityLayer("pipes", "Pipes and tanks", "#2fc4c4", "square", "base", DOMAINS.pipes, ctx, true));
  layers.push(entityLayer("walls", "Walls", "#9a7f6a", "square", "base", DOMAINS.walls, ctx, true));
  layers.push(entityLayer("power", "Power", "#ff8a3d", "dot", "base", DOMAINS.power, ctx, true));
  const powerLayer = layers[layers.length - 1];
  if (powerLayer && input.powerAreas && input.powerAreas.length > 0) {
    powerLayer.body += areaShapes(input.powerAreas, "power");
  }
  layers.push(entityLayer("mining", "Drills and pumpjacks", "#f4f1e8", "dot", "base", DOMAINS.mining, ctx, true));
  layers.push(
    entityLayer("production", "Assembly, chemistry, furnaces", "#5fd98a", "square", "base", DOMAINS.production, ctx, true),
  );
  layers.push(entityLayer("logistics", "Roboports and chests", "#4d8ef5", "square", "base", DOMAINS.logistics, ctx, true));
  layers.push(entityLayer("defence", "Turrets and radar", "#e8615a", "dot", "base", DOMAINS.defence, ctx, true));
  layers.push(entityLayer("science", "Labs", "#b88ae8", "square", "base", DOMAINS.science, ctx, true));

  // Everything placed that no family above claims, so the map never drops a
  // building silently: lamps, combinators, speakers, whatever a later version
  // adds. Robots, ghosts and the character are left out on purpose, being
  // things that move or are not yet built rather than parts of the base.
  const claimed = new Set<string>([...Object.values(DOMAINS).flat(), ...NOT_BUILDINGS]);
  const rest = [...new Set([...ctx.shapes.values()].map((sh) => sh.type))].filter((t) => t !== "" && !claimed.has(t));
  const other = entityLayer("other", "Everything else", "#ff7fbf", "square", "base", rest, ctx, true);
  if (other.drawn + other.census > 0) {
    const present = rest.filter((t) =>
      Object.keys(ctx.map.points).some((n) => ctx.shapes.get(n)?.type === t),
    );
    other.note = present.join(", ") + (other.note ? ` · ${other.note}` : "");
    layers.push(other);
  }

  // Roboport coverage, from each roboport's own declared radius.
  //
  // The one layer here that draws something you cannot see standing in the
  // game without turning the overlay on, and the reason it is worth drawing:
  // a gap in the logistic area is invisible until a robot refuses to deliver
  // into it. The square is the shape the game uses, `logistics_radius` tiles
  // either side of the roboport, read from the prototype and never assumed.
  const ports = map.points["roboport"] ?? [];
  if (ports.length > 0) {
    const proto = input.data?.find("roboport", ["roboport"]) ?? null;
    const radius = Number(proto?.["logistics_radius"] ?? 0);
    const build = Number(proto?.["construction_radius"] ?? 0);
    if (radius > 0) {
      const box = (r: number): string =>
        ports
          .map(([x, y]) => `M${round(x - r)} ${round(y - r)}h${round(r * 2)}v${round(r * 2)}h${round(-r * 2)}z`)
          .join("");
      layers.push({
        id: "coverage",
        label: "Roboport coverage",
        colour: "#5fb0f0",
        mark: "box",
        group: "base",
        on: false,
        drawn: ports.length,
        census: census["roboport"] ?? ports.length,
        missing: [],
        note: `${String(radius)} tiles of logistic area and ${String(build)} of construction area per roboport, from the prototype`,
        body:
          `<path class="cov build" d="${box(build)}"/>` +
          `<path class="cov" d="${box(radius)}"/>`,
      });
    }
  }

  // Train stops, with the names Soushi gave them.
  const stops = state.forces[input.force ?? "player"]?.stops ?? [];
  if (stops.length > 0) {
    const shown = stops.flatMap((s) =>
      s.at.map(([x, y]) => label(x, y - 2, cleanStopName(s.name), labelRank("stop", s.count))),
    );
    layers.push({
      id: "stops",
      label: "Train stops",
      colour: "#d0d6e0",
      mark: "square",
      group: "base",
      on: true,
      drawn: stops.reduce((n, s) => n + s.count, 0),
      census: stops.reduce((n, s) => n + s.count, 0),
      missing: [],
      note: `${String(stops.length)} names across ${String(stops.reduce((n, s) => n + s.count, 0))} stops`,
      body: shown.join(""),
    });
  }

  // The base as the game paints it, revealed by zooming in.
  //
  // The rectangles above are the map; this is the ground truth under it, and it
  // is the same art the game draws, cut out of the installation by `sprites.ts`
  // at the cell each prototype declares. It is a separate layer because it can
  // only be afforded close in: a few thousand images are free while they are
  // hidden and expensive while they are not, so the page reveals them at the
  // zoom where a machine is big enough to recognise and hides them again above
  // it.
  //
  // Two honest limits, both stated in the layer's note. A state file records a
  // position and not a direction, so everything is drawn at its north-facing
  // frame, which is right for a machine and wrong for a belt; the belt layer's
  // rectangles remain the truthful drawing of a belt. And only prototypes with
  // fewer placed instances than the cap get art, because 30000 images is not a
  // map, it is a stall. 1500 rather than 1200 so a solar field (1396 panels on
  // game 4) draws as panels: each one is a reference to a single definition,
  // and the cap is about references, which the belts at thirty thousand blow
  // and a solar field does not.
  const ART_CAP = 1500;
  if (input.data && cutterAvailable()) {
    const defs: string[] = [];
    const pieces: string[] = [];
    let drawn = 0;
    let skipped = 0;
    for (const [name, points] of Object.entries(map.points)) {
      if (points.length === 0) continue;
      // Art is for what a player recognises by shape. A prototype whose own
      // footprint is a single tile is a pixel at any zoom a whole base fits in,
      // and its rectangle says as much as its picture would; a machine two
      // tiles on a side is recognisable and worth the weight. The rule is the
      // prototype's own selection box rather than a list of names.
      const shape = ctx.shapes.get(name);
      // Rails are left as their rectangles: a rail's picture IS its direction,
      // a save records none, and every curve drawn the north way round is a
      // track that is not there.
      if (points.length > ART_CAP || !shape || shape.w * shape.h < 4 || RAIL_TRACK.has(shape.type)) {
        skipped += points.length;
        continue;
      }
      // Every layer the game stacks, back to front, not the last one alone: a
      // lab's last layer is its floor patch and drawing only that drew a lab as
      // a grey slab. Shadows are left out, being drawn flat and dark under the
      // map's own marks, and so are tint masks, which this tool does not colour
      // and which read as a white ghost over the body. When the walk lands on a
      // fragment, under a quarter of the footprint, the prototype's largest
      // picture is used instead, which is how a silo gets its body rather than
      // its shadow; and with no picture at all, its icon at the footprint's size.
      const usable = (cs: SpriteCut[]): SpriteCut[] => {
        const body = cs.filter((c) => !c.shadow);
        const plain = body.filter((c) => !c.tint);
        return plain.length > 0 ? plain : body;
      };
      const walked = usable(spritesFor(input.data, { name }));
      const quarter = (shape.w * shape.h) / 4;
      let cuts = cutArea(walked) >= quarter ? walked : usable(largestPicture(input.data, name));
      if (cutArea(cuts) < quarter) {
        const icon = iconCut(input.data, name);
        const side = Math.min(shape.w, shape.h) * 0.8 * PIXELS_PER_TILE;
        // An icon declares no world scale, so it is set to fill most of the footprint.
        if (icon) cuts = [{ ...icon, scale: side / icon.w }];
      }
      if (cuts.length === 0) continue;
      // Embedded rather than linked, and this is not a preference. A page
      // opened from a file URL is its own opaque origin, so an SVG `image`
      // pointing at another file is cross-origin and the browser refuses it,
      // while an HTML `img` beside it loads the same file happily. Verified in
      // the browser rather than reasoned about: the icons rendered and the
      // sprites came back as broken-image glyphs until they were inlined.
      // The cell is in sheet pixels at a declared scale; a tile is 32 of them.
      // Each layer sits at its own declared shift from the entity's centre, so
      // the definition is drawn about the origin and each placement is the
      // entity's position alone.
      const images = cuts
        .map((cut) => {
          const uri = dataUriAt(cut, ART_PX_PER_TILE);
          if (!uri) return "";
          const w = (cut.w * cut.scale) / PIXELS_PER_TILE;
          const h = (cut.h * cut.scale) / PIXELS_PER_TILE;
          return `<image x="${round(cut.shiftX - w / 2)}" y="${round(cut.shiftY - h / 2)}" width="${round(w)}" height="${round(h)}" href="${uri}"/>`;
        })
        .join("");
      if (!images) continue;
      const id = `s-${name}`;
      // One definition per prototype and one reference per entity, so the art
      // is carried once however many of the machine are placed.
      defs.push(`<g id="${esc(id)}">${images}</g>`);
      for (const [x, y] of points) {
        pieces.push(`<use href="#${esc(id)}" x="${round(x)}" y="${round(y)}"/>`);
        drawn += 1;
      }
    }
    if (drawn > 0) {
      layers.push({
        id: "art",
        label: "The game's own art",
        colour: "#c8cdd6",
        mark: "fill",
        group: "base",
        on: true,
        drawn,
        census: drawn + skipped,
        missing: [],
        note:
          `${String(defs.length)} machines drawn as themselves, ${String(drawn)} of them, revealed when you zoom in` +
          (skipped > 0
            ? ` · ${String(skipped)} left as rectangles: a single tile is a pixel at this scale, and over ${String(ART_CAP)} of one prototype is a stall rather than a map`
            : "") +
          ` · a save records a position and not a direction, so each one is its north-facing frame`,
        body: `<defs>${defs.join("")}</defs>${pieces.join("")}`,
      });
    }
  }

  // What each machine is set to and what each container holds, drawn the way
  // the game's alt mode draws it: the recipe's icon on a dark disc over the
  // machine, its modules in a row along its bottom edge, and the icon of what
  // a chest or tank mostly holds. All three are in the save read already
  // (`machines` and `containers`), so this measures nothing new. It ships as
  // inert text like the art and shows at the same zoom, because six thousand
  // icons are a stall at the whole-base view and are unreadable there anyway.
  if (input.data && cutterAvailable()) {
    const data = input.data;
    const iconIds = new Map<string, string>();
    const iconDefs: string[] = [];
    // One definition per icon, one unit wide about the origin, so a placement
    // only says where and how big.
    const iconId = (name: string, disc: boolean): string | null => {
      const key = `${disc ? "r" : "i"}-${name}`;
      if (iconIds.has(key)) return iconIds.get(key) || null;
      const cut = iconCut(data, name);
      // An icon declares no world scale; at half scale its 64 pixels are one
      // tile, and resampled to the art's density it costs a quarter.
      const uri = cut ? dataUriAt({ ...cut, scale: (PIXELS_PER_TILE * 2) / Math.max(1, cut.w) / 2 }, ART_PX_PER_TILE) : null;
      iconIds.set(key, uri ? key : "");
      if (!uri) return null;
      iconDefs.push(
        `<g id="${esc(key)}">` +
          (disc ? `<circle r="0.62" fill="#000" fill-opacity="0.55"/>` : "") +
          `<image x="-0.5" y="-0.5" width="1" height="1" href="${uri}"/></g>`,
      );
      return key;
    };
    const place = (id: string, x: number, y: number, size: number): string =>
      `<use href="#${esc(id)}" transform="translate(${round(x)} ${round(y)}) scale(${size.toFixed(2)})"/>`;

    const marks: string[] = [];
    let set = 0;
    let moduled = 0;
    for (const m of map.machines ?? []) {
      const shape = ctx.shapes.get(m.name);
      const side = Math.min(shape?.w ?? 3, shape?.h ?? 3);
      if (typeof m.recipe === "string") {
        const id = iconId(m.recipe, true);
        if (id) {
          marks.push(place(id, m.x, m.y - side * 0.08, side * 0.42));
          set += 1;
        }
      }
      const mods = Object.entries(m.modules ?? {}).flatMap(([name, n]) => Array.from({ length: n }, () => name));
      if (mods.length > 0) {
        moduled += 1;
        const size = Math.min(0.62, (side * 0.9) / mods.length);
        const y = m.y + (shape?.h ?? 3) / 2 - size * 0.62;
        mods.forEach((name, i) => {
          const id = iconId(name, false);
          if (id) marks.push(place(id, m.x + (i - (mods.length - 1) / 2) * size, y, size));
        });
      }
    }
    // Belt items get a definition and no placement: the page places them, for
    // the tiles in view only, because twenty-eight thousand belt tiles drawn at
    // once are a stall and a belt icon is unreadable until close in.
    for (const b of input.belts ?? []) for (const lane of b.lanes.slice(0, 2)) if (lane.item) iconId(lane.item, false);
    let held = 0;
    for (const c of map.containers ?? []) {
      let top = c.fluid?.name ?? "";
      let n = 0;
      for (const [item, count] of Object.entries(c.items ?? {})) if (count > n) [top, n] = [item, count];
      if (!top) continue;
      const shape = ctx.shapes.get(c.name);
      const id = iconId(top, false);
      if (!id) continue;
      marks.push(place(id, c.x, c.y, Math.min(shape?.w ?? 1, shape?.h ?? 1) * 0.7));
      held += 1;
    }
    if (marks.length > 0 || iconDefs.length > 0) {
      layers.push({
        id: "alt",
        label: "Recipes, modules, belts, contents",
        colour: "#e8e8e8",
        mark: "fill",
        group: "base",
        on: true,
        drawn: set + held,
        census: (map.machines?.length ?? 0) + (map.containers?.length ?? 0),
        missing: [],
        note:
          `${String(set)} machines with a recipe, ${String(moduled)} with modules, ${String(held)} containers holding something, ` +
          `and what rides each belt lane closer still, ` +
          `shown when you zoom in, the way the game's alt mode shows them; a click lists them in full`,
        body: `<defs>${iconDefs.join("")}</defs>${marks.join("")}`,
      });
    }
  }

  // ---- Places -----------------------------------------------------------

  const bus = input.busAreas ?? [];
  layers.push({
    id: "bus",
    label: "Bus corridors",
    colour: "#e8a05a",
    mark: "box",
    group: "places",
    on: bus.length > 0,
    drawn: bus.length,
    census: bus.length,
    missing: [],
    // A refused layer says it was refused and why. An empty layer and a layer
    // that could not be trusted are not the same answer, and the reader has to
    // be able to tell them apart without reading this file.
    note: beltNote(bus.length, input.busSurvey),
    body: areaShapes(bus),
  });

  // MAP-4, the three layers that say what a thing IS and what it HOLDS rather
  // than only where it stands. Each one merges before it draws, because the
  // point of the map is that 2152 machines, 30847 belts and 1030 containers
  // arrive as about a hundred paths rather than as thirty thousand nodes.
  const blocks = input.recipeBlocks ?? [];
  if (blocks.length > 0) {
    // Labels only on blocks worth naming. A one-machine block is a real block
    // and gets drawn; labelling all 56 of them would bury the districts under
    // their own text, and the click panel names every one of them anyway.
    const named = blocks.filter((b) => b.machines >= NAMED_BLOCK_MACHINES);
    layers.push({
      id: "blocks",
      label: "What each block makes",
      colour: "#7fd18a",
      mark: "box",
      group: "places",
      on: true,
      drawn: blocks.length,
      census: blocks.reduce((n, b) => n + b.machines, 0),
      missing: [],
      note:
        `${String(blocks.length)} blocks over ${String(blocks.reduce((n, b) => n + b.machines, 0))} ` +
        `machines, ${String(named.length)} named on the map and all of them on a click`,
      body:
        areaShapes(blocks.filter((b) => b.machines < NAMED_BLOCK_MACHINES)) +
        areaShapes(named, "block"),
    });
  }

  const beltRuns = input.belts ?? [];
  if (beltRuns.length > 0) {
    const byItem = new Map<string, Array<[number, number]>>();
    let carrying = 0;
    for (const b of beltRuns) {
      // The dominant lane, because a belt with iron on one side and copper on
      // the other is an iron belt to a player deciding where to tap it, and a
      // two-colour tile is unreadable at any zoom the whole base fits in.
      let top = "";
      let n = 0;
      for (const lane of b.lanes) if (lane.count > n) [top, n] = [lane.item, lane.count];
      if (top === "") continue;
      carrying += 1;
      const list = byItem.get(top);
      if (list) list.push([b.x, b.y]);
      else byItem.set(top, [[b.x, b.y]]);
    }
    const ranked = [...byItem].sort((a, b) => b[1].length - a[1].length);
    layers.push({
      id: "payload",
      label: "What rides the belts",
      colour: "#d8b64a",
      mark: "square",
      group: "base",
      on: false,
      drawn: carrying,
      census: beltRuns.length,
      missing: [],
      note:
        `${String(carrying)} of ${String(beltRuns.length)} belt pieces carrying something, ` +
        `${String(ranked.length)} items: ` +
        ranked.slice(0, 5).map(([item, ps]) => `${item} ${String(ps.length)}`).join(", "),
      body: ranked.map(([item, ps]) => runsOf(ps, item)).join(""),
    });
  }

  const held = ctx.map.containers ?? [];
  if (held.length > 0) {
    const byItem = new Map<string, Array<[number, number]>>();
    let empty = 0;
    for (const c of held) {
      const items = Object.entries(c.items ?? {});
      if (items.length === 0) {
        empty += 1;
        continue;
      }
      let top = "";
      let n = 0;
      for (const [name, count] of items) if (count > n) [top, n] = [name, count];
      const list = byItem.get(top);
      if (list) list.push([c.x, c.y]);
      else byItem.set(top, [[c.x, c.y]]);
    }
    const ranked = [...byItem].sort((a, b) => b[1].length - a[1].length);
    layers.push({
      id: "held",
      label: "What the chests hold",
      colour: "#5fb0f0",
      mark: "square",
      group: "base",
      on: false,
      drawn: held.length - empty,
      census: held.length,
      missing: [],
      note:
        `${String(held.length - empty)} holding something, ${String(empty)} empty, ` +
        `${String(ranked.length)} different top items: ` +
        ranked.slice(0, 5).map(([item, ps]) => `${item} ${String(ps.length)}`).join(", "),
      body: ranked.map(([item, ps]) => runsOf(ps, item)).join(""),
    });
  }

  const advice = input.adviceAreas ?? [];
  layers.push({
    id: "advice",
    label: "What the advice points at",
    colour: "#f0c860",
    mark: "box",
    group: "places",
    on: true,
    drawn: advice.length,
    census: advice.length,
    missing: [],
    note: advice.length > 0 ? "click a line of advice to fly there" : "no advice on this save names a place",
    body: areaShapes(advice),
  });

  return { surface: map.name, cellTiles: cell, viewBox, layers, facts: factsOf(input, ctx) };
}

function factsOf(input: ModelInput, ctx: BuildContext): MapFacts {
  const { map } = input;
  const force = input.state.forces[input.force ?? "player"];
  const energy = force?.energy ?? {};
  const facts: MapFacts = { cell: map.cellTiles, chunks: {}, ore: {}, enemy: {}, protos: {}, machines: [], holds: [], icons: {}, belts: "", beltItems: [] };
  const itemIndex = new Map<string, number>();
  const idx = (item: string): number => {
    if (!item) return -1;
    let i = itemIndex.get(item);
    if (i === undefined) {
      i = facts.beltItems.length;
      itemIndex.set(item, i);
      facts.beltItems.push(item);
    }
    return i;
  };
  const packed: number[] = [];
  for (const b of input.belts ?? []) {
    const [l, r] = [b.lanes[0], b.lanes[1]];
    if (!l?.item && !r?.item) continue;
    packed.push(Math.floor(b.x), Math.floor(b.y), b.dir ?? 0, idx(l?.item ?? ""), l?.count ?? 0, idx(r?.item ?? ""), r?.count ?? 0);
  }
  facts.belts = Buffer.from(new Int16Array(packed).buffer).toString("base64");
  const named = new Set<string>(facts.beltItems);
  for (const m of map.machines ?? []) {
    const recipe = typeof m.recipe === "string" ? m.recipe : "";
    facts.machines.push([m.x, m.y, m.name, recipe, m.modules ?? 0]);
    if (recipe) named.add(recipe);
    for (const k of Object.keys(m.modules ?? {})) named.add(k);
  }
  for (const c of map.containers ?? []) {
    facts.holds.push([c.x, c.y, c.name, c.items ?? 0, c.fluid ? { name: c.fluid.name, amount: Math.round(c.fluid.amount) } : 0]);
    for (const k of Object.keys(c.items ?? {})) named.add(k);
    if (c.fluid) named.add(c.fluid.name);
  }
  for (const name of named) {
    const url = input.icons?.url(name);
    if (url) facts.icons[name] = url;
  }

  for (const c of map.cells) {
    const entry: MapFacts["chunks"][string] = { by: c.byType, total: c.total ?? 0 };
    if (c.pollution !== undefined) entry.pollution = Math.round(c.pollution);
    facts.chunks[`${String(c.cx)},${String(c.cy)}`] = entry;
  }
  for (const c of map.ore) {
    const rounded: Record<string, number> = {};
    for (const [name, amount] of Object.entries(c.res)) rounded[name] = Math.round(amount);
    facts.ore[`${String(c.cx)},${String(c.cy)}`] = rounded;
  }
  for (const e of map.enemy ?? []) {
    facts.enemy[`${String(e.cx)},${String(e.cy)}`] = [e.nests, e.worms];
  }

  const names = new Set([...Object.keys(map.points), ...Object.keys(ctx.census)]);
  for (const name of names) {
    const shape = ctx.shapes.get(name);
    const row: MapFacts["protos"][string] = {
      type: shape?.type ?? "",
      w: shape?.w ?? 1,
      h: shape?.h ?? 1,
    };
    const placed = ctx.census[name];
    if (placed !== undefined) row.count = placed;
    const icon = input.icons?.url(name);
    if (icon) row.icon = icon;
    const proto = input.data?.all(name).find((p) => "selection_box" in p) ?? null;
    const slots = Number(proto?.["inventory_size"] ?? 0);
    if (slots > 0) row.slots = slots;
    const volume = Number((proto?.["fluid_box"] as Record<string, unknown> | undefined)?.["volume"] ?? 0);
    if (volume > 0) row.volume = volume;
    const e = energy[name];
    if (e) {
      // The collector copies the engine's own resolved values per tick; a watt
      // is a joule per tick times the tick rate, which power.ts already states.
      if (e.usagePerTick !== undefined) row.usage = Math.round(e.usagePerTick * 60);
      if (e.drainPerTick !== undefined) row.drain = Math.round(e.drainPerTick * 60);
      if (e.buffer !== undefined) row.buffer = e.buffer;
    }
    facts.protos[name] = row;
  }
  return facts;
}
