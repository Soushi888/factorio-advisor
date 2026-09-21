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
import type { Data, Proto } from "./proto.ts";
import { footprintOf } from "./layout.ts";

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
  production: ["assembling-machine", "furnace", "rocket-silo"],
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
function footprints(groups: Array<{ points: Array<[number, number]>; w: number; h: number }>): string {
  const d: string[] = [];
  for (const g of groups) {
    const hw = g.w / 2;
    const hh = g.h / 2;
    for (const [x, y] of g.points) {
      d.push(`M${round(x - hw)} ${round(y - hh)}h${round(g.w)}v${round(g.h)}h${round(-g.w)}z`);
    }
  }
  if (d.length === 0) return "";
  return `<path class="fp" d="${d.join("")}"/>`;
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

/** A label the page keeps at a readable size, with a halo so it survives anything under it. */
function label(x: number, y: number, text: string): string {
  return `<text class="lbl" x="${round(x)}" y="${round(y)}">${esc(text)}</text>`;
}

function areaShapes(areas: Area[], withLabels = false): string {
  return areas
    .map((a) => {
      const text = withLabels ? label(a.x + a.w / 2, a.y - 3, a.label) : "";
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

/** One chunk rectangle, at an opacity the caller has already decided. */
function chunkRect(cx: number, cy: number, cell: number, opacity: number, title?: string): string {
  return (
    `<rect x="${String(cx * cell)}" y="${String(cy * cell)}" ` +
    `width="${String(cell)}" height="${String(cell)}" opacity="${opacity.toFixed(2)}">` +
    (title ? `<title>${esc(title)}</title>` : "") +
    `</rect>`
  );
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
  const groups: Array<{ points: Array<[number, number]>; w: number; h: number }> = [];
  const missing: Array<{ name: string; count: number }> = [];
  let drawn = 0;
  let census = 0;
  let guessed = 0;

  for (const [name, points] of Object.entries(ctx.map.points)) {
    const shape = ctx.shapes.get(name);
    if (!shape || !want.has(shape.type)) continue;
    groups.push({ points, w: shape.w, h: shape.h });
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
    body: footprints(groups),
    note: notes.join(" · "),
  };
}

export interface ModelInput {
  state: GameState;
  map: SurfaceMap;
  /** The prototype snapshot, for footprints and types. */
  data?: Data | null;
  /** The bus corridors, when a belt survey has been read for this save. */
  busAreas?: Area[];
  /** The places the advice points at. */
  adviceAreas?: Area[];
  /** Power blocks and ore fields, already derived by `advise.ts`. */
  powerAreas?: Area[];
  oreAreas?: Area[];
  force?: string;
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
      body: terrain.map((t) => chunkRect(t.cx, t.cy, cell, 0.1)).join(""),
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
      body: oreBody.join("") + areaShapes(input.oreAreas ?? [], true),
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
      body: enemy
        .map((e) => {
          // Sized by how much is in the chunk, centred on it, never filling it:
          // the count is real and the position is the chunk, which is as
          // precise as this measurement gets.
          const r = (cell / 2) * Math.min(1, 0.3 + 0.7 * Math.sqrt((e.nests + e.worms) / Math.max(1, max)));
          const cx = e.cx * cell + cell / 2;
          const cy = e.cy * cell + cell / 2;
          return (
            `<rect x="${round(cx - r)}" y="${round(cy - r)}" width="${round(r * 2)}" ` +
            `height="${round(r * 2)}" opacity="0.62"><title>${String(e.nests)} nests, ` +
            `${String(e.worms)} worms</title></rect>`
          );
        })
        .join(""),
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
      body: polluted
        .map((c) =>
          chunkRect(
            c.cx,
            c.cy,
            cell,
            Math.min(0.55, 0.08 + 0.47 * Math.sqrt((c.pollution ?? 0) / max)),
            `pollution ${String(Math.round(c.pollution ?? 0))}`,
          ),
        )
        .join(""),
    });
  }

  // ---- The base ---------------------------------------------------------
  //
  // Ordered so the things a player looks for end up on top of the things that
  // merely cover ground: belts and rails under machines, machines under
  // turrets and labs.

  layers.push(entityLayer("rail", "Rail network", "#9aa3b0", "square", "base", DOMAINS.rail, ctx, true));
  layers.push(entityLayer("belts", "Belts and inserters", "#d8b64a", "square", "base", DOMAINS.belts, ctx, true));
  layers.push(entityLayer("pipes", "Pipes and tanks", "#4ab0c0", "square", "base", DOMAINS.pipes, ctx, true));
  layers.push(entityLayer("walls", "Walls", "#9a7f6a", "square", "base", DOMAINS.walls, ctx, true));
  layers.push(entityLayer("power", "Power", "#e8c25a", "dot", "base", DOMAINS.power, ctx, true));
  const powerLayer = layers[layers.length - 1];
  if (powerLayer && input.powerAreas && input.powerAreas.length > 0) {
    powerLayer.body += areaShapes(input.powerAreas, true);
  }
  layers.push(entityLayer("mining", "Drills and pumpjacks", "#f0d060", "dot", "base", DOMAINS.mining, ctx, true));
  layers.push(
    entityLayer("production", "Assembly, chemistry, furnaces", "#5fd98a", "square", "base", DOMAINS.production, ctx, true),
  );
  layers.push(entityLayer("logistics", "Roboports and chests", "#5fb0f0", "square", "base", DOMAINS.logistics, ctx, true));
  layers.push(entityLayer("defence", "Turrets and radar", "#e8615a", "dot", "base", DOMAINS.defence, ctx, true));
  layers.push(entityLayer("science", "Labs", "#b88ae8", "square", "base", DOMAINS.science, ctx, true));

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
      s.at.map(([x, y]) => label(x, y - 2, cleanStopName(s.name))),
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
    note:
      bus.length > 0
        ? `${String(bus.length)} clusters of parallel belt runs`
        : "no belt survey read for this save yet: bun run bus",
    body: areaShapes(bus),
  });

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

  return { surface: map.name, cellTiles: cell, viewBox, layers };
}
