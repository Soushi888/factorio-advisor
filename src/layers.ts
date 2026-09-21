/**
 * The layer model for the one map (C33).
 *
 * `map.ts` bakes a whole map into one SVG string, which is the right shape for a
 * thumbnail and the wrong one for a map you can switch parts of on and off. This
 * builds the same geometry as a list of layers instead, each with its own body,
 * its own count and its own mark, so the page can toggle a `<g>` rather than
 * re-render.
 *
 * The honesty problem this file exists to solve: the census counts every machine
 * the force owns, and the collector keeps exact positions only for prototypes
 * under its point limit. So a layer can know that there are 1130 assembling
 * machine 2s and be able to draw none of them. Every layer therefore reports
 * three numbers, not one: how many it DREW, how many the census says exist, and
 * which prototypes it could not place. A legend that showed only the first would
 * be a map quietly disagreeing with the dashboard beside it.
 */

import type { GameState, SurfaceMap } from "./state.ts";
import { pointsOfTypes, type Area } from "./map.ts";

/** A mark, so no layer is told apart by colour alone. */
export type Mark = "dot" | "square" | "diamond" | "ring" | "box";

export interface MapLayer {
  id: string;
  label: string;
  colour: string;
  mark: Mark;
  /** On when the page opens. */
  on: boolean;
  /** Entities actually drawn. */
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
  "iron-ore": "#7a94b8",
  "copper-ore": "#c07a4a",
  coal: "#4a4a4a",
  stone: "#a99a78",
  "uranium-ore": "#5fbf80",
  "crude-oil": "#7a5fa8",
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/**
 * One prototype group's points, drawn with its mark.
 *
 * The radius is in tile units because the whole map is, so a dot is a real size
 * on the ground rather than a screen size that lies at one zoom and not another.
 */
function marks(points: Array<[number, number]>, mark: Mark, r: number): string {
  if (points.length === 0) return "";
  if (mark === "square") {
    return points
      .map(
        ([x, y]) =>
          `<rect x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" ` +
          `width="${(r * 2).toFixed(1)}" height="${(r * 2).toFixed(1)}"/>`,
      )
      .join("");
  }
  if (mark === "diamond") {
    return points
      .map(
        ([x, y]) =>
          `<path d="M${x.toFixed(1)} ${(y - r).toFixed(1)}L${(x + r).toFixed(1)} ${y.toFixed(1)}` +
          `L${x.toFixed(1)} ${(y + r).toFixed(1)}L${(x - r).toFixed(1)} ${y.toFixed(1)}Z"/>`,
      )
      .join("");
  }
  if (mark === "ring") {
    return points
      .map(
        ([x, y]) =>
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" ` +
          `fill="none" stroke="currentColor" stroke-width="${(r / 2).toFixed(2)}"/>`,
      )
      .join("");
  }
  return points
    .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>`)
    .join("");
}

function areaShapes(areas: Area[]): string {
  return areas
    .map(
      (a) =>
        `<g class="area ${a.tone}" data-x="${a.x.toFixed(0)}" data-y="${a.y.toFixed(0)}" ` +
        `data-w="${a.w.toFixed(0)}" data-h="${a.h.toFixed(0)}">` +
        `<rect x="${a.x.toFixed(0)}" y="${a.y.toFixed(0)}" ` +
        `width="${a.w.toFixed(0)}" height="${a.h.toFixed(0)}"/>` +
        `<title>${esc(a.label)}</title></g>`,
    )
    .join("");
}

/** A layer built from prototype names, counting what it could not place. */
function pointLayer(
  id: string,
  label: string,
  colour: string,
  mark: Mark,
  radius: number,
  names: string[],
  map: SurfaceMap,
  census: Record<string, number>,
  on: boolean,
): MapLayer {
  const points = pointsOfTypes(map, names);
  const missing: Array<{ name: string; count: number }> = [];
  const uncounted: string[] = [];
  let total = 0;

  for (const name of names) {
    const counted = census[name] ?? 0;
    const placed = map.points[name]?.length ?? 0;

    // The census counts only prototypes that declare an energy source, which a
    // train stop, a wagon and a flamethrower turret do not. Measured on game 4:
    // train-stop 32, cargo-wagon 26, fluid-wagon 12 all carry positions and no
    // census row, and summing the two populations as though they were one is
    // how a legend comes to read "645 of 575". Where the census is silent, the
    // positions are the only count there is, and the layer says so.
    const known = counted > 0 ? counted : placed;
    if (counted === 0 && placed > 0) uncounted.push(name);
    total += known;
    if (known > placed) missing.push({ name, count: known - placed });
  }
  missing.sort((a, b) => b.count - a.count);

  const notes: string[] = [];
  if (missing.length > 0) {
    notes.push(
      `${String(missing.reduce((n, m) => n + m.count, 0))} without positions ` +
        `(${missing.map((m) => m.name).join(", ")})`,
    );
  }
  if (uncounted.length > 0) {
    notes.push(`counted from positions, not the census: ${uncounted.join(", ")}`);
  }

  return {
    id,
    label,
    colour,
    mark,
    on,
    drawn: points.length,
    census: total,
    missing,
    body: marks(points, mark, radius),
    note: notes.join(" · "),
  };
}

export interface ModelInput {
  state: GameState;
  map: SurfaceMap;
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
  const b = map.bounds;
  const pad = map.cellTiles;
  const viewBox = b
    ? {
        x: b.minX - pad,
        y: b.minY - pad,
        w: b.maxX - b.minX + pad * 2,
        h: b.maxY - b.minY + pad * 2,
      }
    : { x: 0, y: 0, w: 1, h: 1 };

  const layers: MapLayer[] = [];

  // The base itself: chunk density, so every other layer has ground under it.
  layers.push({
    id: "base",
    label: "The base",
    colour: "#5a6270",
    mark: "box",
    on: true,
    drawn: map.cells.length,
    census: map.cells.length,
    missing: [],
    note: `${String(map.cells.length)} chunks holding something`,
    body: map.cells
      .map((c) => {
        const o = Math.min(0.55, 0.08 + Math.log10(1 + (c.total ?? 0)) * 0.14);
        return (
          `<rect x="${String(c.cx * map.cellTiles)}" y="${String(c.cy * map.cellTiles)}" ` +
          `width="${String(map.cellTiles)}" height="${String(map.cellTiles)}" ` +
          `fill="currentColor" opacity="${o.toFixed(2)}"><title>chunk ${String(c.cx)}, ${String(c.cy)}: ` +
          `${String(c.total ?? 0)} entities</title></rect>`
        );
      })
      .join(""),
  });

  // Ore, by resource, from the chunks the collector bucketed it into.
  const oreBody: string[] = [];
  let oreCells = 0;
  for (const cell of map.ore) {
    let best = "";
    let bestAmount = 0;
    for (const [name, amount] of Object.entries(cell.res)) {
      if (amount > bestAmount) [best, bestAmount] = [name, amount];
    }
    if (!best) continue;
    oreCells += 1;
    oreBody.push(
      `<rect x="${String(cell.cx * map.cellTiles)}" y="${String(cell.cy * map.cellTiles)}" ` +
        `width="${String(map.cellTiles)}" height="${String(map.cellTiles)}" ` +
        `fill="${ORE_COLOURS[best] ?? "#888"}" opacity="0.5">` +
        `<title>${esc(best)}, chunk ${String(cell.cx)}, ${String(cell.cy)}</title></rect>`,
    );
  }
  layers.push({
    id: "ore",
    label: "Ore",
    colour: "#a99a78",
    mark: "box",
    on: true,
    drawn: oreCells,
    census: oreCells,
    missing: [],
    note: `${String(oreCells)} chunks carrying ore or oil`,
    body: oreBody.join("") + areaShapes(input.oreAreas ?? []),
  });

  layers.push(
    pointLayer(
      "smelting",
      "Furnaces",
      "#c07a4a",
      "square",
      2,
      ["electric-furnace", "steel-furnace", "stone-furnace"],
      map,
      census,
      false,
    ),
  );
  layers.push(
    pointLayer(
      "production",
      "Assembly and chemistry",
      "#5fbf80",
      "diamond",
      2.5,
      [
        "assembling-machine-1",
        "assembling-machine-2",
        "assembling-machine-3",
        "chemical-plant",
        "oil-refinery",
        "electromagnetic-plant",
        "foundry",
        "biochamber",
      ],
      map,
      census,
      false,
    ),
  );
  layers.push(
    pointLayer(
      "power",
      "Power",
      "#e0b45a",
      "dot",
      2,
      ["steam-engine", "boiler", "solar-panel", "accumulator", "nuclear-reactor", "steam-turbine"],
      map,
      census,
      false,
    ),
  );
  const powerLayer = layers[layers.length - 1];
  if (powerLayer && input.powerAreas && input.powerAreas.length > 0) {
    powerLayer.body += areaShapes(input.powerAreas);
  }

  layers.push(
    pointLayer(
      "defence",
      "Defence",
      "#e0745a",
      "dot",
      1.8,
      ["gun-turret", "laser-turret", "flamethrower-turret", "artillery-turret", "radar"],
      map,
      census,
      false,
    ),
  );
  layers.push(
    pointLayer(
      "logistics",
      "Logistics",
      "#5fa8e0",
      "ring",
      3,
      ["roboport", "train-stop", "locomotive", "cargo-wagon", "fluid-wagon"],
      map,
      census,
      false,
    ),
  );
  layers.push(
    pointLayer(
      "science",
      "Labs",
      "#7a5fa8",
      "diamond",
      3,
      ["lab", "biolab"],
      map,
      census,
      false,
    ),
  );

  const bus = input.busAreas ?? [];
  layers.push({
    id: "bus",
    label: "Bus corridors",
    colour: "#e0745a",
    mark: "box",
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
    colour: "#e0b45a",
    mark: "box",
    on: true,
    drawn: advice.length,
    census: advice.length,
    missing: [],
    note: advice.length > 0 ? "" : "no advice on this save names a place",
    body: areaShapes(advice),
  });

  return { surface: map.name, cellTiles: map.cellTiles, viewBox, layers };
}
