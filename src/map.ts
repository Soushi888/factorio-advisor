import type { GameState, MapCell, OreCell, SurfaceMap } from "./state.ts";

/**
 * The base as geometry, and the places advice points at.
 *
 * Every other module in this project answers in rates and counts. This one
 * answers in coordinates, which is the difference between "build more boilers"
 * and "build them here". Nothing is drawn that the save did not report: a
 * square on the map is a chunk the collector counted entities in, an ore blob
 * is the summed remaining amount of the resource entities in that chunk, and a
 * dot is a placed entity's own position.
 *
 * Two deliberate absences. There is no terrain, because the collector reads
 * entities and resources, not tiles, and a map that drew water it had not
 * measured would be a picture rather than a report. And there is no path
 * finding or placement suggestion: the advisor says which chunk is short of
 * boilers, not where in the chunk to put them, because the save reports what is
 * placed, not what would fit.
 */

/** A rectangle in tile space, with what it is and why it is being pointed at. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** How the renderer should colour it. */
  tone: "warn" | "good" | "info";
}

/** A connected run of chunks holding steam engines, and what feeds them. */
export interface PowerBlock extends Area {
  engines: number;
  boilers: number;
  /** Engines the boilers in this block can feed, at the game's own ratio. */
  fed: number;
}

/** A connected run of chunks holding one resource. */
export interface Patch extends Area {
  resource: string;
  amount: number;
  chunks: number;
  /** Drills or pumpjacks standing on it. */
  extractors: number;
}

export function mapOf(state: GameState, surface = "nauvis"): SurfaceMap | null {
  const maps = state.map;
  if (!maps || maps.length === 0) return null;
  return maps.find((m) => m.name === surface) ?? maps[0] ?? null;
}

function key(cx: number, cy: number): string {
  return `${String(cx)}:${String(cy)}`;
}

/**
 * Connected chunks, four-way.
 *
 * Eight-way would merge two patches that touch only at a corner, which on an
 * ore field is usually two patches a belt apart rather than one.
 */
function clusters<T extends { cx: number; cy: number }>(cells: T[]): T[][] {
  const byKey = new Map<string, T>();
  for (const c of cells) byKey.set(key(c.cx, c.cy), c);
  const seen = new Set<string>();
  const out: T[][] = [];

  for (const cell of cells) {
    const start = key(cell.cx, cell.cy);
    if (seen.has(start)) continue;
    const group: T[] = [];
    const stack = [cell];
    seen.add(start);
    while (stack.length > 0) {
      const c = stack.pop()!;
      group.push(c);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const k = key(c.cx + dx, c.cy + dy);
        const n = byKey.get(k);
        if (n && !seen.has(k)) {
          seen.add(k);
          stack.push(n);
        }
      }
    }
    out.push(group);
  }
  return out;
}

function boundsOf(cells: Array<{ cx: number; cy: number }>, cellTiles: number): Omit<Area, "label" | "tone"> {
  const xs = cells.map((c) => c.cx);
  const ys = cells.map((c) => c.cy);
  const minX = Math.min(...xs) * cellTiles;
  const minY = Math.min(...ys) * cellTiles;
  return {
    x: minX,
    y: minY,
    w: (Math.max(...xs) + 1) * cellTiles - minX,
    h: (Math.max(...ys) + 1) * cellTiles - minY,
  };
}

function pointsIn(map: SurfaceMap, names: string[], area: Omit<Area, "label" | "tone">): number {
  let n = 0;
  for (const name of names) {
    for (const [x, y] of map.points[name] ?? []) {
      if (x >= area.x && x < area.x + area.w && y >= area.y && y < area.y + area.h) n += 1;
    }
  }
  return n;
}

/** Every prototype the census gave positions for whose type matches. */
export function pointsOfTypes(map: SurfaceMap, names: Iterable<string>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const name of names) out.push(...(map.points[name] ?? []));
  return out;
}

/**
 * Power blocks: connected chunks holding steam engines, with the boilers that
 * reach them counted in the same block.
 *
 * `enginesPerBoiler` is not a constant here. It is passed in from `power.ts`,
 * which derives it from boiler energy consumption against engine fluid usage,
 * so this file states no game fact of its own.
 */
export function powerBlocks(map: SurfaceMap, enginesPerBoiler: number): PowerBlock[] {
  const engineCells = map.cells.filter((c) => (c.byType["generator"] ?? 0) > 0);
  const out: PowerBlock[] = [];

  for (const group of clusters(engineCells)) {
    const box = boundsOf(group, map.cellTiles);
    // Boilers sit next to their engines but can land in a neighbouring chunk,
    // so the box is grown by one chunk before they are counted.
    const grown = {
      x: box.x - map.cellTiles,
      y: box.y - map.cellTiles,
      w: box.w + map.cellTiles * 2,
      h: box.h + map.cellTiles * 2,
    };
    const engines = pointsIn(map, ["steam-engine", "steam-turbine"], grown);
    const boilers = pointsIn(map, ["boiler", "heat-exchanger"], grown);
    if (engines === 0) continue;
    const fed = Math.min(engines, boilers * enginesPerBoiler);
    out.push({
      ...box,
      engines,
      boilers,
      fed,
      label: `${String(engines)} engines, ${String(boilers)} boilers`,
      tone: fed < engines ? "warn" : "good",
    });
  }
  return out.sort((a, b) => b.engines - b.fed - (a.engines - a.fed));
}

/** Ore fields, largest first, with whether anything is standing on them. */
export function patches(map: SurfaceMap, extractorNames: string[]): Patch[] {
  const byResource = new Map<string, OreCell[]>();
  for (const cell of map.ore) {
    for (const name of Object.keys(cell.res)) {
      const list = byResource.get(name) ?? [];
      list.push(cell);
      byResource.set(name, list);
    }
  }

  const out: Patch[] = [];
  for (const [resource, cells] of byResource) {
    for (const group of clusters(cells)) {
      const box = boundsOf(group, map.cellTiles);
      const amount = group.reduce((n, c) => n + (c.res[resource] ?? 0), 0);
      const extractors = pointsIn(map, extractorNames, box);
      out.push({
        ...box,
        resource,
        amount,
        chunks: group.length,
        extractors,
        label: `${resource}, ${formatAmount(amount)}`,
        tone: extractors === 0 ? "good" : "info",
      });
    }
  }
  return out.sort((a, b) => b.amount - a.amount);
}

function formatAmount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}

// ------------------------------------------------------------------ rendering

export interface PointLayer {
  names: string[];
  /** A CSS colour, or a variable the page defines. */
  colour: string;
  radius?: number;
  title?: string;
}

export interface RenderOptions {
  /** Chunk squares under everything, so a layer has context. */
  base?: boolean;
  ore?: boolean;
  points?: PointLayer[];
  areas?: Area[];
  /** Longest side of the rendered box, in pixels. */
  size?: number;
}

const ORE_COLOURS: Record<string, string> = {
  "iron-ore": "#7a94b8",
  "copper-ore": "#c07a4a",
  coal: "#4a4a4a",
  stone: "#a99a78",
  "uranium-ore": "#5fbf80",
  "crude-oil": "#7a5fa8",
};

/**
 * One SVG, in tile coordinates.
 *
 * The viewBox is the base's own bounding box, so nothing here scales or
 * projects: a tile is a unit and the browser does the arithmetic. That keeps
 * every coordinate in the output traceable to a coordinate in the save, which
 * is the same discipline the rest of the tool follows with its numbers.
 */
export function renderMap(map: SurfaceMap, opts: RenderOptions = {}): string {
  const b = map.bounds;
  if (!b) return "";
  const pad = map.cellTiles;
  const x = b.minX - pad;
  const y = b.minY - pad;
  const w = b.maxX - b.minX + pad * 2;
  const h = b.maxY - b.minY + pad * 2;
  const size = opts.size ?? 320;
  const scale = size / Math.max(w, h);
  const parts: string[] = [];

  if (opts.base !== false) {
    const max = Math.max(1, ...map.cells.map((c) => c.total));
    parts.push(
      `<g class="m-base">` +
        map.cells
          .map((c) => cellRect(c, map.cellTiles, 0.18 + 0.55 * Math.sqrt(c.total / max)))
          .join("") +
        `</g>`,
    );
  }

  if (opts.ore) {
    parts.push(
      `<g class="m-ore">` +
        map.ore
          .map((c) => {
            const top = Object.entries(c.res).sort((p, q) => q[1] - p[1])[0];
            if (!top) return "";
            const colour = ORE_COLOURS[top[0]] ?? "#888";
            return (
              `<rect x="${String(c.cx * map.cellTiles)}" y="${String(c.cy * map.cellTiles)}" ` +
              `width="${String(map.cellTiles)}" height="${String(map.cellTiles)}" ` +
              `fill="${colour}" opacity="0.85"><title>${esc(top[0])}: ${formatAmount(top[1])}</title></rect>`
            );
          })
          .join("") +
        `</g>`,
    );
  }

  for (const layer of opts.points ?? []) {
    const pts = pointsOfTypes(map, layer.names);
    if (pts.length === 0) continue;
    const r = (layer.radius ?? 3) / scale;
    parts.push(
      `<g class="m-pts" fill="${layer.colour}">` +
        (layer.title ? `<title>${esc(layer.title)}</title>` : "") +
        pts
          .map(([px, py]) => `<circle cx="${px.toFixed(0)}" cy="${py.toFixed(0)}" r="${r.toFixed(1)}"/>`)
          .join("") +
        `</g>`,
    );
  }

  for (const area of opts.areas ?? []) {
    const stroke = area.tone === "warn" ? "#e0745a" : area.tone === "good" ? "#5fbf80" : "#888";
    parts.push(
      `<rect x="${String(area.x)}" y="${String(area.y)}" width="${String(area.w)}" height="${String(area.h)}" ` +
        `fill="${stroke}" fill-opacity="0.12" stroke="${stroke}" stroke-width="${(2.5 / scale).toFixed(1)}" ` +
        `stroke-dasharray="${(7 / scale).toFixed(1)} ${(5 / scale).toFixed(1)}">` +
        `<title>${esc(area.label)}</title></rect>`,
    );
  }

  return (
    `<svg class="map" viewBox="${x.toFixed(0)} ${y.toFixed(0)} ${w.toFixed(0)} ${h.toFixed(0)}" ` +
    `width="100%" preserveAspectRatio="xMidYMid meet" role="img">` +
    parts.join("") +
    `</svg>`
  );
}

function cellRect(c: MapCell, cellTiles: number, opacity: number): string {
  return (
    `<rect x="${String(c.cx * cellTiles)}" y="${String(c.cy * cellTiles)}" ` +
    `width="${String(cellTiles)}" height="${String(cellTiles)}" ` +
    `fill="currentColor" opacity="${opacity.toFixed(2)}"/>`
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}
