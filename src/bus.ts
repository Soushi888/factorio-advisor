/**
 * The bus (C26, C27).
 *
 * Every other module in this toolkit reasons about rates. This one reasons about
 * geometry, because a main bus is a geometric fact: a set of parallel belt runs
 * going the same way, each carrying one thing, long enough that machines can be
 * built beside it. Nothing in a state file says where anything is, so the belt
 * survey in `state.ts` is what makes this module possible at all.
 *
 * What it does NOT do is guess. A bus is reported where a cluster of parallel
 * same-direction runs exists and nowhere else; a lane's contents are the engine's
 * own reading of that lane; a saturation figure is the item's measured rate over
 * the declared throughput of the tier actually placed. Where the survey cannot
 * support a statement, the statement is not made.
 *
 * One engine fact shapes the whole file: a transport LINE is not a belt. The
 * engine merges a straight stretch into one line, and every belt in that stretch
 * reports that line's whole contents. So an item count is meaningless until it is
 * divided by the line's own `line_length`, which the survey records for exactly
 * this reason.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { beltItemsPerSecond, beltItemsPerTile } from "./belts.ts";
import { EAST, NORTH, SOUTH, WEST } from "./layout.ts";
import type { Data, Proto } from "./proto.ts";
import { flowOf, slugify, type GameState } from "./state.ts";

/**
 * The longest hole a run may carry and still be one run, in tiles.
 *
 * An underground belt's two ends are both in the survey; only the buried span is
 * missing. The longest vanilla underground reach is the turbo belt's, so the hole
 * it leaves is bounded by that prototype, and the value is read from the snapshot
 * rather than typed here: see `maxUndergroundGap`.
 */
function maxUndergroundGap(data: Data): number {
  let longest = 0;
  for (const proto of Object.values(data.klass("underground-belt"))) {
    const reach = (proto as Proto)["max_distance"];
    if (typeof reach === "number" && reach > longest) longest = reach;
  }
  // The two ends occupy tiles of their own, so the hole between them is one less
  // than the reach. A survey that found no underground prototype falls back to
  // demanding contiguity, which is the conservative answer, not a guess.
  return longest > 0 ? longest - 1 : 1;
}

/** A run must be at least this long to be a bus lane rather than a connection. */
const MIN_LANE_TILES = 40;
/** Lanes further apart than this are two structures, not one bus. */
const MAX_LANE_SPACING = 3;
/** A bus is at least this many parallel lanes. Fewer is a pair of belts. */
const MIN_BUS_LANES = 4;
/** A lane this full is held up by what is downstream of it. */
const BACKED_UP = 0.75;
/** A lane this empty is held up by what is upstream of it. */
const STARVED = 0.15;

export interface SurveyLane {
  item: string;
  count: number;
  distinct: number;
  span: number;
}

export interface SurveyBelt {
  name: string;
  type: string;
  x: number;
  y: number;
  dir: number;
  ug: string | null;
  lanes: SurveyLane[];
}

export interface Survey {
  tick: number;
  surface: string;
  belts: SurveyBelt[];
}

/** The survey as the collector wrote it: short keys, lanes as tuples. */
interface RawBelt {
  n: string;
  t: string;
  x: number;
  y: number;
  d: number;
  u?: string | null;
  l?: Array<[string, number, number, number?]>;
}

export function surveyPath(save: string): string {
  return join(DATA_DIR, "state", `${slugify(save.replace(/\.zip$/i, ""))}-belts.json`);
}

export function readSurvey(save: string): Survey[] | null {
  const path = surveyPath(save);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    tick: number;
    surfaces: Array<{ name: string; belts: RawBelt[] }>;
  };
  return raw.surfaces.map((s) => ({
    tick: raw.tick,
    surface: s.name,
    belts: (s.belts ?? []).map((b) => ({
      name: b.n,
      type: b.t,
      x: b.x,
      y: b.y,
      dir: b.d,
      ug: b.u ?? null,
      lanes: (b.l ?? []).map((l) => ({
        item: l[0] ?? "",
        count: l[1] ?? 0,
        distinct: l[2] ?? 0,
        span: l[3] ?? 0,
      })),
    })),
  }));
}

type Axis = "vertical" | "horizontal";

function axisOf(dir: number): Axis | null {
  if (dir === NORTH || dir === SOUTH) return "vertical";
  if (dir === EAST || dir === WEST) return "horizontal";
  return null;
}

/** Tile centres sit on halves. A splitter's position sits between two of them. */
function tileCentre(v: number): number {
  return Math.floor(v) + 0.5;
}

interface Placement {
  fixed: number;
  moving: number;
  belt: SurveyBelt;
}

/**
 * Where a belt entity sits, in run coordinates.
 *
 * A splitter is two tiles wide across the flow, so it belongs to two runs: that
 * is the whole point of a splitter and the reason a bus can be tapped without
 * cutting it. Everything else occupies one tile.
 */
function placementsOf(belt: SurveyBelt, axis: Axis): Placement[] {
  const across = axis === "vertical" ? belt.x : belt.y;
  const along = axis === "vertical" ? belt.y : belt.x;
  if (belt.type !== "splitter") {
    return [{ fixed: tileCentre(across), moving: tileCentre(along), belt }];
  }
  return [
    { fixed: tileCentre(across - 0.5), moving: tileCentre(along), belt },
    { fixed: tileCentre(across + 0.5), moving: tileCentre(along), belt },
  ];
}

export interface LaneStat {
  /** Items seen on this lane, weighted by the belts reporting them. */
  items: Map<string, number>;
  /** Sum of per-belt lane densities, and how many belts contributed one. */
  density: number;
  sampled: number;
  /** Belts whose lane reported more than one item at once. */
  contaminated: number;
}

export interface Run {
  axis: Axis;
  dir: number;
  /** x for a vertical run, y for a horizontal one. */
  fixed: number;
  from: number;
  to: number;
  length: number;
  belts: number;
  splitters: number;
  undergrounds: number;
  /** Belt prototype to tile count, so a tier change inside a run is visible. */
  tiers: Map<string, number>;
  lanes: LaneStat[];
}

/** Belt-like entity classes, in the order a name should be resolved against. */
const BELT_CLASSES = ["transport-belt", "underground-belt", "splitter", "loader", "loader-1x1"];

/**
 * The entity prototype behind a surveyed belt's name.
 *
 * The name also belongs to an item prototype, which carries no `speed`, so the
 * entity classes are preferred explicitly rather than taking the first hit.
 */
function beltProto(data: Data, name: string): Proto | null {
  return data.find(name, BELT_CLASSES);
}

/**
 * Group the survey into straight runs.
 *
 * A run is a maximal stretch of belt on one line, going one way, broken only by
 * holes an underground belt could account for. Two runs on the same line facing
 * opposite ways stay two runs, because that is two lanes of a bus, not one.
 */
export function buildRuns(survey: Survey, data: Data): Run[] {
  const gapLimit = maxUndergroundGap(data);
  const groups = new Map<string, Placement[]>();

  for (const belt of survey.belts) {
    const axis = axisOf(belt.dir);
    if (!axis) continue;
    for (const p of placementsOf(belt, axis)) {
      const key = `${axis}|${p.fixed}|${belt.dir}`;
      const list = groups.get(key);
      if (list) list.push(p);
      else groups.set(key, [p]);
    }
  }

  const runs: Run[] = [];
  for (const [key, placements] of groups) {
    const [axisPart, , dirPart] = key.split("|");
    const axis = axisPart as Axis;
    const dir = Number(dirPart);
    placements.sort((a, b) => a.moving - b.moving);

    let current: Placement[] = [];
    const flush = (): void => {
      if (current.length === 0) return;
      const run = summarise(current, axis, dir);
      if (run) runs.push(run);
      current = [];
    };
    for (const p of placements) {
      const last = current[current.length - 1];
      if (last && p.moving - last.moving > gapLimit + 1) flush();
      current.push(p);
    }
    flush();
  }
  return runs;
}

function summarise(placements: Placement[], axis: Axis, dir: number): Run | null {
  const first = placements[0];
  const last = placements[placements.length - 1];
  if (!first || !last) return null;

  const tiers = new Map<string, number>();
  const lanes: LaneStat[] = [];
  let splitters = 0;
  let undergrounds = 0;

  for (const p of placements) {
    const belt = p.belt;
    if (belt.type === "splitter") splitters += 1;
    if (belt.type === "underground-belt") undergrounds += 1;
    tiers.set(belt.name, (tiers.get(belt.name) ?? 0) + 1);

    // A splitter's eight lines do not map onto a lane pair, and a lane's identity
    // is what this module is after, so only plain belt lanes are read for items.
    if (belt.type !== "transport-belt") continue;
    for (const [i, lane] of belt.lanes.entries()) {
      let stat = lanes[i];
      if (!stat) {
        stat = { items: new Map(), density: 0, sampled: 0, contaminated: 0 };
        lanes[i] = stat;
      }
      if (lane.item) stat.items.set(lane.item, (stat.items.get(lane.item) ?? 0) + 1);
      if (lane.distinct > 1) stat.contaminated += 1;
      // A full lane holds the belt's per-tile capacity, over the tiles the line
      // spans, divided by the lanes the engine reported on this entity. The span
      // and the lane count are measurements; the per-tile figure is derived in
      // belts.ts from the spacing and lane constants declared there.
      const laneCount = belt.lanes.length || 1;
      const capacity = (lane.span * beltItemsPerTile()) / laneCount;
      if (capacity > 0) {
        stat.density += lane.count / capacity;
        stat.sampled += 1;
      }
    }
  }

  return {
    axis,
    dir,
    fixed: first.fixed,
    from: first.moving,
    to: last.moving,
    length: last.moving - first.moving + 1,
    belts: placements.length,
    splitters,
    undergrounds,
    tiers,
    lanes,
  };
}

export interface BusLane {
  run: Run;
  /** The item this lane carries, or null when it carries nothing legible. */
  item: string | null;
  /** The slowest belt prototype in the run: what actually caps it. */
  slowestTier: string;
  slowestItemsPerSecond: number;
  /** Tiles of the run running on something slower than its best tier. */
  pinchTiles: number;
  /** 0 to 1, the share of the lane's capacity that is occupied. */
  density: number;
  contaminated: number;
}

export interface Bus {
  axis: Axis;
  dir: number;
  from: number;
  to: number;
  /** Fixed coordinates of the first and last lane. */
  spanFrom: number;
  spanTo: number;
  lanes: BusLane[];
}

/** Overlap of two spans as a fraction of the shorter one. */
function overlap(a: Run, b: Run): number {
  const lo = Math.max(a.from, b.from);
  const hi = Math.min(a.to, b.to);
  const shared = hi - lo;
  const shorter = Math.min(a.length, b.length);
  return shorter > 0 ? Math.max(0, shared) / shorter : 0;
}

/**
 * Find the buses.
 *
 * A bus is a cluster of long parallel runs on the same axis, close together and
 * overlapping along their length. Direction is deliberately NOT part of the key:
 * a real bus often runs a return lane the other way, and splitting on direction
 * would report two half buses where one is built.
 */
export function findBuses(runs: Run[], data: Data): Bus[] {
  const candidates = runs.filter((r) => r.length >= MIN_LANE_TILES);
  const byAxis = new Map<Axis, Run[]>();
  for (const run of candidates) {
    const list = byAxis.get(run.axis);
    if (list) list.push(run);
    else byAxis.set(run.axis, [run]);
  }

  const buses: Bus[] = [];
  for (const [axis, list] of byAxis) {
    list.sort((a, b) => a.fixed - b.fixed || a.from - b.from);
    let cluster: Run[] = [];
    const flush = (): void => {
      const lanes = cluster.filter((r) => {
        // A lane belongs to the bus only if it runs alongside the others.
        return cluster.some((other) => other !== r && overlap(r, other) >= 0.5);
      });
      const columns = new Set(lanes.map((r) => r.fixed));
      if (columns.size >= MIN_BUS_LANES) buses.push(assemble(axis, lanes, data));
      cluster = [];
    };
    for (const run of list) {
      const last = cluster[cluster.length - 1];
      if (last && run.fixed - last.fixed > MAX_LANE_SPACING) flush();
      cluster.push(run);
    }
    flush();
  }
  return buses.sort((a, b) => b.lanes.length - a.lanes.length);
}

function assemble(axis: Axis, runs: Run[], data: Data): Bus {
  const lanes = runs.map((run) => describeLane(run, data));
  const from = Math.min(...runs.map((r) => r.from));
  const to = Math.max(...runs.map((r) => r.to));
  const dirCount = new Map<number, number>();
  for (const r of runs) dirCount.set(r.dir, (dirCount.get(r.dir) ?? 0) + r.length);
  let dir = runs[0]?.dir ?? NORTH;
  let best = -1;
  for (const [d, n] of dirCount) if (n > best) [dir, best] = [d, n];
  return {
    axis,
    dir,
    from,
    to,
    spanFrom: Math.min(...runs.map((r) => r.fixed)),
    spanTo: Math.max(...runs.map((r) => r.fixed)),
    lanes,
  };
}

function describeLane(run: Run, data: Data): BusLane {
  const totals = new Map<string, number>();
  let density = 0;
  let sampled = 0;
  let contaminated = 0;
  for (const lane of run.lanes) {
    for (const [item, n] of lane.items) totals.set(item, (totals.get(item) ?? 0) + n);
    density += lane.density;
    sampled += lane.sampled;
    contaminated += lane.contaminated;
  }
  let item: string | null = null;
  let best = 0;
  for (const [name, n] of totals) if (n > best) [item, best] = [name, n];

  let slowestTier = "";
  let slowest = Infinity;
  let fastest = 0;
  for (const name of run.tiers.keys()) {
    const proto = beltProto(data, name);
    const rate = proto ? beltItemsPerSecond(proto) : 0;
    if (rate > 0 && rate < slowest) [slowest, slowestTier] = [rate, name];
    if (rate > fastest) fastest = rate;
  }
  let pinchTiles = 0;
  if (slowest < fastest) {
    for (const [name, tiles] of run.tiers) {
      const proto = beltProto(data, name);
      const rate = proto ? beltItemsPerSecond(proto) : 0;
      if (rate > 0 && rate < fastest) pinchTiles += tiles;
    }
  }

  return {
    run,
    item,
    slowestTier,
    slowestItemsPerSecond: Number.isFinite(slowest) ? slowest : 0,
    pinchTiles,
    density: sampled > 0 ? density / sampled : 0,
    contaminated,
  };
}

export interface ItemVerdict {
  item: string;
  lanes: number;
  /** What those lanes can carry, per minute, at the tiers actually placed. A
   * lane is one side of a belt, so two lanes of the same item is one full belt. */
  capacityPerMinute: number;
  producedPerMinute: number;
  consumedPerMinute: number;
  /** Production over capacity. Above 1 means the belt is the ceiling. */
  saturation: number;
  density: number;
}

export interface Finding {
  text: string;
  because: string;
}

export interface BusReport {
  tick: number;
  surface: string;
  beltsSurveyed: number;
  runs: number;
  /** Belts sitting in a run too short to be a lane: the unstructured share. */
  looseBelts: number;
  buses: Bus[];
  items: ItemVerdict[];
  findings: Finding[];
}

export function judge(survey: Survey, state: GameState, data: Data): BusReport {
  const runs = buildRuns(survey, data);
  const buses = findBuses(runs, data);
  const inLane = runs
    .filter((r) => r.length >= MIN_LANE_TILES)
    .reduce((sum, r) => sum + r.belts, 0);

  const production = state.forces["player"]?.production.item ?? {};

  // A lane is one side of a belt, which is the unit that carries one item. A run
  // whose two sides carry different things contributes to both, at half the
  // belt's throughput each, so nothing is credited capacity it does not have.
  const perItem = new Map<string, { lanes: number; capacity: number; density: number }>();
  for (const bus of buses) {
    for (const busLane of bus.lanes) {
      const run = busLane.run;
      const laneCount = run.lanes.length || 1;
      const perLanePerMinute = (busLane.slowestItemsPerSecond / laneCount) * 60;
      for (const stat of run.lanes) {
        let item: string | null = null;
        let best = 0;
        for (const [name, n] of stat.items) if (n > best) [item, best] = [name, n];
        if (!item) continue;
        const entry = perItem.get(item) ?? { lanes: 0, capacity: 0, density: 0 };
        entry.lanes += 1;
        entry.capacity += perLanePerMinute;
        entry.density += stat.sampled > 0 ? stat.density / stat.sampled : 0;
        perItem.set(item, entry);
      }
    }
  }

  const items: ItemVerdict[] = [];
  for (const [item, entry] of perItem) {
    const rates = flowOf(production[item]);
    items.push({
      item,
      lanes: entry.lanes,
      capacityPerMinute: entry.capacity,
      producedPerMinute: rates.producedPerMinute,
      consumedPerMinute: rates.consumedPerMinute,
      saturation: entry.capacity > 0 ? rates.producedPerMinute / entry.capacity : 0,
      density: entry.lanes > 0 ? entry.density / entry.lanes : 0,
    });
  }
  items.sort((a, b) => b.saturation - a.saturation);

  return {
    tick: survey.tick,
    surface: survey.surface,
    beltsSurveyed: survey.belts.length,
    runs: runs.length,
    looseBelts: survey.belts.length - inLane,
    buses,
    items,
    findings: findingsOf(buses, items, survey, runs),
  };
}

function findingsOf(buses: Bus[], items: ItemVerdict[], survey: Survey, runs: Run[]): Finding[] {
  const out: Finding[] = [];

  if (buses.length === 0) {
    const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
    out.push({
      text: `No bus. Nothing on this surface is ${MIN_BUS_LANES} parallel lanes of ${MIN_LANE_TILES} tiles or more.`,
      because: `${survey.belts.length} belts surveyed, ${runs.length} straight runs, longest run ${longest.toFixed(0)} tiles.`,
    });
  } else {
    const widest = buses[0];
    if (widest) {
      out.push({
        text: `The widest bus is ${widest.lanes.length} lanes over ${Math.abs(widest.to - widest.from).toFixed(0)} tiles.`,
        because: `${widest.axis}, lanes from ${widest.spanFrom.toFixed(0)} to ${widest.spanTo.toFixed(0)}, running ${widest.from.toFixed(0)} to ${widest.to.toFixed(0)}.`,
      });
    }
  }

  for (const bus of buses) {
    for (const lane of bus.lanes) {
      if (lane.pinchTiles > 0) {
        out.push({
          text: `A lane carrying ${lane.item ?? "nothing legible"} drops to ${lane.slowestTier} for ${lane.pinchTiles} tiles.`,
          because: `The slow stretch caps the whole lane at ${(lane.slowestItemsPerSecond * 60).toFixed(0)}/min however fast the rest is.`,
        });
      }
      if (lane.contaminated > 0) {
        out.push({
          text: `A lane carrying ${lane.item ?? "nothing legible"} has ${lane.contaminated} belts holding more than one item.`,
          because: `A lane with two items in it delivers neither at its rate, because each blocks the other.`,
        });
      }
    }
  }

  for (const v of items) {
    if (v.saturation >= 1) {
      out.push({
        text: `${v.item} makes more than its lanes carry.`,
        because: `${v.producedPerMinute.toFixed(0)}/min produced against ${v.capacityPerMinute.toFixed(0)}/min of lane, ${v.lanes} lane(s) at the placed tier (a lane is one side of a belt).`,
      });
    }
    if (v.density >= BACKED_UP) {
      out.push({
        text: `The ${v.item} lanes are backed up (${(v.density * 100).toFixed(0)}% full).`,
        because: `A full lane means what is downstream of it is not taking it; adding upstream capacity changes nothing.`,
      });
    } else if (v.density <= STARVED && v.consumedPerMinute > 0) {
      out.push({
        text: `The ${v.item} lanes are starved (${(v.density * 100).toFixed(0)}% full).`,
        because: `${v.producedPerMinute.toFixed(0)}/min made against ${v.consumedPerMinute.toFixed(0)}/min used: the lane is empty because nothing is filling it.`,
      });
    }
  }

  return out;
}

/**
 * The command, kept in this module rather than in `cli.ts`.
 *
 * `cli.ts` is the toolkit's one entry point and it stays that way; this main is
 * here because the file was dirty under a concurrent session when the module
 * landed, and wiring it is a one-case change somebody else owns. Run it as
 * `bun src/bus.ts --save="game 4"` until then.
 */
function renderReport(report: BusReport, state: GameState): string {
  const lines: string[] = [];
  const s = state.snapshot;
  lines.push(
    `snapshot: Factorio ${s.gameVersion} build ${s.build} [${s.mods.map((m) => m.name).join(", ")}]`,
  );
  lines.push(
    `state: save "${state.save.name}" at tick ${state.save.tick} ` +
      `(${state.save.hoursPlayed.toFixed(1)} h played), surface ${report.surface}`,
  );

  lines.push(`\nThe belts\n=========`);
  lines.push(
    `  ${report.beltsSurveyed} belt entities, ${report.runs} straight runs, ` +
      `${report.looseBelts} of them in runs shorter than ${MIN_LANE_TILES} tiles ` +
      `(${((report.looseBelts / Math.max(1, report.beltsSurveyed)) * 100).toFixed(0)}% not in a lane).`,
  );

  if (report.buses.length === 0) {
    lines.push(`  No bus found: no cluster of ${MIN_BUS_LANES} parallel lanes.`);
  }
  for (const [i, bus] of report.buses.entries()) {
    const axis = bus.axis === "vertical" ? "north-south" : "east-west";
    lines.push(
      `\nBus ${i + 1}: ${bus.lanes.length} lanes, ${axis}, ` +
        `${Math.abs(bus.to - bus.from).toFixed(0)} tiles long\n` +
        `${"-".repeat(60)}`,
    );
    lines.push(`  lanes across ${bus.spanFrom.toFixed(0)} to ${bus.spanTo.toFixed(0)}, running ${bus.from.toFixed(0)} to ${bus.to.toFixed(0)}`);
    const rows = bus.lanes
      .slice()
      .sort((a, b) => a.run.fixed - b.run.fixed)
      .map((lane) => {
        const at = lane.run.fixed.toFixed(0).padStart(7);
        const item = (lane.item ?? "(empty)").padEnd(24);
        const len = lane.run.length.toFixed(0).padStart(6);
        const tier = lane.slowestTier.replace("transport-belt", "belt").padEnd(20);
        const full = `${(lane.density * 100).toFixed(0)}%`.padStart(6);
        const pinch = lane.pinchTiles > 0 ? `  ${lane.pinchTiles} slow tiles` : "";
        return `  ${at}  ${item}${len}  ${tier}${full}${pinch}`;
      });
    lines.push(`  ${"at".padStart(5)}  ${"carries".padEnd(24)}${"tiles".padStart(6)}  ${"slowest tier".padEnd(20)}${"full".padStart(6)}`);
    lines.push(...rows);
  }

  if (report.items.length > 0) {
    lines.push(`\nWhat the lanes carry against what you make\n${"=".repeat(41)}`);
    lines.push(
      `  ${"item".padEnd(24)}${"lanes".padStart(6)}${"carry/min".padStart(11)}` +
        `${"made/min".padStart(10)}${"used/min".padStart(10)}${"full".padStart(7)}`,
    );
    for (const v of report.items) {
      lines.push(
        `  ${v.item.padEnd(24)}${String(v.lanes).padStart(6)}` +
          `${v.capacityPerMinute.toFixed(0).padStart(11)}` +
          `${v.producedPerMinute.toFixed(0).padStart(10)}` +
          `${v.consumedPerMinute.toFixed(0).padStart(10)}` +
          `${`${(v.density * 100).toFixed(0)}%`.padStart(7)}`,
      );
    }
    lines.push(
      `\n  a lane is ONE SIDE of a belt: two lanes of the same item is one full belt.\n` +
        `  carry/min is those lanes at the tier actually placed, not the tier you could place.\n` +
        `  full is how much of the lane's own capacity is occupied, from the engine's\n` +
        `  own line contents: a full lane is held back downstream, an empty one upstream.`,
    );
  }

  if (report.findings.length > 0) {
    lines.push(`\nFindings\n========`);
    for (const [i, f] of report.findings.entries()) {
      lines.push(`\n  ${i + 1}. ${f.text}\n     ${f.because}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) flags.set(a.slice(2), "true");
    else flags.set(a.slice(2, eq), a.slice(eq + 1));
  }

  const { load } = await import("./proto.ts");
  const { newestSave, readState, readStateFile } = await import("./state.ts");
  const save = flags.get("save") ?? newestSave()?.name;
  if (!save) throw new Error("No save named and none found. Pass --save=<name>.");

  let state: GameState | null = null;
  if (flags.get("reuse") === "true") {
    state = readStateFile(save);
    if (!state) throw new Error(`No state file for "${save}". Run without --reuse first.`);
  } else {
    state = await readState({ save, belts: true });
  }

  const surveys = readSurvey(save);
  if (!surveys || surveys.length === 0) {
    throw new Error(
      `No belt survey for "${save}" at ${surveyPath(save)}.\n` +
        `Run without --reuse to collect one.`,
    );
  }

  const data = load();
  for (const survey of surveys) {
    if (survey.belts.length === 0) continue;
    console.log(`\n${renderReport(judge(survey, state, data), state)}\n`);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
