import type { Advisory, SectionId } from "./advise.ts";
import { powerReport } from "./power.ts";
import type { Data } from "./proto.ts";
import { flowOf, type GameState, type SurfaceMap } from "./state.ts";
import { mapOf, patches, powerBlocks, type Patch } from "./map.ts";

/**
 * The base, cut into the parts a player actually thinks in.
 *
 * One long list of figures is a log, not a dashboard. Soushi asked for energy,
 * defence, science and the rest as sections, and the cut is not cosmetic: each
 * section owns its own numbers, its own advice, and its own view of the map, so
 * a recommendation and the place it applies to sit in the same card.
 *
 * Every figure names the state path it came from, the same contract the rest of
 * the page follows. A section with nothing measured is omitted rather than
 * padded, because an empty card claims a reading that was never taken.
 */

export interface Figure {
  value: string;
  label: string;
  /** Path inside the state file, for the page's provenance attributes. */
  field: string;
  tone?: "warn" | "good";
}

export interface Table {
  headers: string[];
  rows: string[][];
  /** Column indexes to right-align. */
  numeric: number[];
}

export interface SectionView {
  id: SectionId;
  title: string;
  /** The one sentence a glance should take away. */
  lead: string;
  figures: Figure[];
  table: Table | null;
  advice: Advisory["advice"];
  /**
   * What this part of the base can carry, with the number behind it.
   *
   * The Orient move, and the reason a section is worth reading once its
   * thumbnail is gone. A count says the base has labs; a corridor says the labs
   * could eat 243/min and are eating 18, which is the sentence that decides
   * whether tonight's job is more labs or more packs. A section with nothing
   * measured says so rather than rendering a confident zero.
   */
  carry: string | null;
  /** The map layer this section turns on when its header is clicked. */
  layer: string | null;
}

const TITLES: Record<SectionId, string> = {
  science: "Science",
  energy: "Energy",
  defense: "Defence",
  production: "Production",
  logistics: "Logistics",
  mining: "Mining",
};

function mw(w: number): string {
  return `${(w / 1e6).toFixed(1)} MW`;
}

function n(v: number, places = 1): string {
  return v.toFixed(places);
}

/** Entities of these types, summed over every chunk. */
function totalOfTypes(map: SurfaceMap | null, types: string[]): number {
  if (!map) return 0;
  let sum = 0;
  for (const cell of map.cells) {
    for (const t of types) sum += cell.byType[t] ?? 0;
  }
  return sum;
}


/** "2655 x 2617 tiles", so the picture has a scale. */
function extent(map: SurfaceMap | null): string {
  if (!map?.bounds) return "";
  const b = map.bounds;
  return `${String(Math.round(b.maxX - b.minX))} x ${String(Math.round(b.maxY - b.minY))} tiles`;
}

/**
 * How long the drilled patches last at the rate the base is eating them.
 *
 * The Orient move, ported: a corridor is only useful if it can say no. A patch
 * count says the base has ore; a runway says how many hours of play are left
 * before it does not, which is the figure that decides whether an outpost is
 * this evening's job or next month's. Ore under drills only, because ore nobody
 * is mining is not feeding anything.
 */
function runway(fields: Patch[], resource: string, perMinute: number): { minutes: number; amount: number } | null {
  if (perMinute <= 0) return null;
  const amount = fields
    .filter((p) => p.resource === resource && p.extractors > 0)
    .reduce((n, p) => n + p.amount, 0);
  if (amount <= 0) return null;
  return { minutes: amount / perMinute, amount };
}

/** "40 h" or "95 min", whichever reads as a decision. */
function hours(minutes: number): string {
  return minutes >= 120 ? `${(minutes / 60).toFixed(0)} h` : `${minutes.toFixed(0)} min`;
}

export function sections(data: Data, state: GameState, advisory: Advisory): SectionView[] {
  const force = state.forces["player"];
  const map = mapOf(state);
  const item = (name: string) => flowOf(force?.production.item[name]);
  const adviceFor = (id: SectionId) => advisory.advice.filter((x) => x.section === id);
  const count = (...types: string[]) => totalOfTypes(map, types);

  const steamChain = force ? powerReport(data, state, "player").steam : null;
  const blocks = map && steamChain ? powerBlocks(map, steamChain.ratio) : [];
  const fields = map
    ? patches(map, ["electric-mining-drill", "burner-mining-drill", "big-mining-drill", "pumpjack"])
    : [];
  const out: SectionView[] = [];

  // ---- science -----------------------------------------------------------
  const labs = advisory.labs;
  out.push({
    id: "science",
    title: TITLES.science,
    lead:
      advisory.researchPerMinute !== null && advisory.limiting
        ? `${n(advisory.researchPerMinute)} packs a minute, held there by ${advisory.limiting}.`
        : "Nothing is being researched.",
    figures: [
      ...(advisory.researchPerMinute !== null
        ? [{ value: `${n(advisory.researchPerMinute)}/min`, label: "science rate", field: "forces.player.production.item" }]
        : []),
      ...(labs
        ? [
            {
              value: `${n(labs.utilisation * 100)}%`,
              label: `${String(labs.labs)} labs, ${n(labs.capacityPerMinute, 0)}/min capacity`,
              field: "forces.player.machines.lab",
              tone: labs.utilisation < 0.6 ? ("warn" as const) : ("good" as const),
            },
          ]
        : []),
      {
        value: advisory.currentResearch ?? "idle",
        label: "researching",
        field: "forces.player.technologies.current",
      },
    ],
    table: {
      headers: ["pack", "made/min", "used/min", "spare"],
      numeric: [1, 2, 3],
      rows: advisory.packs
        .filter((p) => p.everMade)
        .map((p) => [
          p.name.replace(/-science-pack$/, "") + (p.name === advisory.limiting ? " · slowest" : ""),
          n(p.rates.producedPerMinute),
          n(p.rates.consumedPerMinute),
          n(p.rates.headroomPerMinute),
        ]),
    },
    advice: adviceFor("science"),
    carry: labs
      ? `${n(labs.capacityPerMinute, 0)} packs a minute through ${String(labs.labs)} labs, and ${n(labs.actualPerMinute)} is going through them.`
      : null,
    layer: "labs",
  });

  // ---- energy ------------------------------------------------------------
  const grid = advisory.grid;
  const unfed = blocks.filter((b) => b.fed < b.engines);
  out.push({
    id: "energy",
    title: TITLES.energy,
    lead: grid
      ? `${mw(grid.deliveredWatts)} flowing against ${mw(grid.capacityWatts)} the generators can deliver.`
      : "No grid figures in this save.",
    figures: grid
      ? [
          { value: mw(grid.deliveredWatts), label: "flowing now", field: "forces.player.electric.production" },
          { value: mw(grid.capacityWatts), label: "can deliver", field: "forces.player.machines" },
          {
            value: mw(grid.spareWatts),
            label: "spare",
            field: "forces.player.machines",
            tone: grid.spareWatts < 0 ? "warn" : "good",
          },
          ...(grid.starvedEngines > 0
            ? [
                {
                  value: String(grid.starvedEngines),
                  label: "engines with no boiler",
                  field: "forces.player.machines.steam-engine",
                  tone: "warn" as const,
                },
              ]
            : []),
        ]
      : [],
    table: {
      headers: ["what", "placed"],
      numeric: [1],
      rows: [
        ["solar panel", String(count("solar-panel"))],
        ["accumulator", String(count("accumulator"))],
        ["steam engine", String(count("generator"))],
        ["boiler", String(count("boiler"))],
      ].filter((r) => r[1] !== "0"),
    },
    advice: adviceFor("energy"),
    carry: grid
      ? `${mw(grid.capacityWatts)} of delivery, ${mw(grid.deliveredWatts)} of it flowing, and ${mw(grid.nameplateWatts - grid.capacityWatts)} standing idle behind engines with no boiler.`
      : null,
    layer: "power",
  });

  // ---- defence -----------------------------------------------------------
  const surface = state.save.surfaceState?.[0];
  const ammo = item("firearm-magazine");
  const piercing = item("piercing-rounds-magazine");
  out.push({
    id: "defense",
    title: TITLES.defense,
    lead:
      surface?.evolution != null
        ? `Evolution ${n(surface.evolution * 100)}% against ${String(count("ammo-turret", "electric-turret", "fluid-turret"))} turrets and ${String(count("wall"))} wall segments.`
        : `${String(count("ammo-turret", "electric-turret", "fluid-turret"))} turrets placed.`,
    figures: [
      ...(surface?.evolution != null
        ? [
            {
              value: `${n(surface.evolution * 100)}%`,
              label: "evolution",
              field: "save.surfaceState[0].evolution",
              tone: surface.evolution > 0.8 ? ("warn" as const) : ("good" as const),
            },
          ]
        : []),
      ...(surface?.pollution != null
        ? [{ value: n(surface.pollution, 0), label: "pollution", field: "save.surfaceState[0].pollution" }]
        : []),
      { value: String(count("wall")), label: "wall segments", field: "map[0].cells[].byType.wall" },
      {
        value: n(piercing.producedPerMinute + ammo.producedPerMinute),
        label: "ammo made/min",
        field: "forces.player.production.item.piercing-rounds-magazine",
        tone: piercing.producedPerMinute + ammo.producedPerMinute > 0 ? "good" : "warn",
      },
    ],
    table: {
      headers: ["what", "placed"],
      numeric: [1],
      rows: [
        ["gun turret", String(count("ammo-turret"))],
        ["laser turret", String(count("electric-turret"))],
        ["flamethrower turret", String(count("fluid-turret"))],
        ["gate", String(count("gate"))],
        ["radar", String(count("radar"))],
      ].filter((r) => r[1] !== "0"),
    },
    advice: adviceFor("defense"),
    carry: `${String(count("ammo-turret", "electric-turret", "fluid-turret"))} turrets and ${String(count("wall"))} wall segments against an evolution of ${surface?.evolution != null ? n(surface.evolution * 100) : "?"}%, fed by ${n(piercing.producedPerMinute + ammo.producedPerMinute)} rounds a minute.`,
    layer: "defence",
  });

  // ---- production --------------------------------------------------------
  const target = advisory.target;
  out.push({
    id: "production",
    title: TITLES.production,
    lead: target
      ? `${String(target.machinesAdded)} machines and ${mw(target.wattsAdded)} to reach ${n(target.spm, 0)}/min of every pack.`
      : `${String(count("assembling-machine", "furnace"))} machines placed.`,
    figures: [
      { value: String(count("assembling-machine")), label: "assemblers, plants, refineries", field: "forces.player.machines" },
      { value: String(count("furnace")), label: "furnaces", field: "forces.player.machines" },
      ...(target
        ? [
            { value: String(target.machinesAdded), label: `machines to add for ${n(target.spm, 0)}/min`, field: "forces.player.production.item" },
            { value: mw(target.wattsAdded), label: "new draw", field: "forces.player.production.item" },
          ]
        : []),
    ],
    table: target
      ? {
          headers: ["item", "needs/min", "spare", "build for"],
          numeric: [1, 2, 3],
          rows: target.requirements
            .filter((x) => x.deficitPerMinute > 0 && !x.raw)
            .slice(0, 10)
            .map((x) => [x.item, n(x.requiredPerMinute), n(x.headroomPerMinute), n(x.deficitPerMinute)]),
        }
      : null,
    advice: adviceFor("production"),
    carry: target
      ? `${String(count("assembling-machine", "furnace"))} machines standing, and ${String(target.machinesAdded)} more wanted to reach ${n(target.spm, 0)}/min of every pack.`
      : null,
    layer: "production",
  });

  // ---- logistics ---------------------------------------------------------
  out.push({
    id: "logistics",
    title: TITLES.logistics,
    lead: `${String(count("transport-belt", "underground-belt", "splitter"))} belt pieces, ${String(count("roboport"))} roboports, ${String(count("locomotive"))} locomotives.`,
    figures: [
      { value: String(count("roboport")), label: "roboports", field: "forces.player.machines.roboport" },
      { value: String(count("logistic-robot", "construction-robot")), label: "robots out", field: "map[0].cells[].byType" },
      { value: String(count("locomotive")), label: "locomotives", field: "map[0].cells[].byType.locomotive" },
      { value: String(count("train-stop")), label: "train stops", field: "map[0].cells[].byType.train-stop" },
    ],
    table: {
      headers: ["what", "placed"],
      numeric: [1],
      rows: [
        ["belts", String(count("transport-belt"))],
        ["undergrounds", String(count("underground-belt"))],
        ["splitters", String(count("splitter"))],
        ["rail", String(count("straight-rail", "curved-rail-a", "curved-rail-b", "half-diagonal-rail"))],
        ["inserters", String(count("inserter"))],
      ].filter((r) => r[1] !== "0"),
    },
    advice: adviceFor("logistics"),
    carry: `${String(count("transport-belt", "underground-belt", "splitter"))} belt pieces and ${String(count("roboport"))} roboports moving it, with ${String(count("locomotive"))} locomotives across ${String(count("train-stop"))} stops.`,
    layer: "logistics",
  });

  // ---- mining ------------------------------------------------------------
  const untouched = fields.filter((p) => p.extractors === 0);
  // Every resource the save charted, never a typed list: uranium and crude oil
  // fell off a hardcoded four and Soushi noticed the uranium missing from the
  // table before the code did.
  const resources = [...new Set(fields.map((p) => p.resource))].sort();
  const runways = resources
    .map((r) => ({ resource: r, ...(runway(fields, r, item(r).consumedPerMinute) ?? { minutes: 0, amount: 0 }) }))
    .filter((r) => r.minutes > 0)
    .sort((a, b) => a.minutes - b.minutes);
  const shortestRunway = runways[0] ?? null;
  out.push({
    id: "mining",
    title: TITLES.mining,
    lead: shortestRunway
      ? `${shortestRunway.resource} runs out in ${hours(shortestRunway.minutes)} of play at the current draw, and it is the first to go.`
      : fields.length > 0
        ? `${String(fields.length)} ore fields charted, ${String(untouched.length)} with nothing standing on them.`
        : `${String(count("mining-drill"))} drills placed.`,
    figures: [
      { value: String(count("mining-drill")), label: "drills and pumpjacks", field: "forces.player.machines" },
      {
        value: n(item("iron-ore").headroomPerMinute),
        label: "iron ore spare/min",
        field: "forces.player.production.item.iron-ore",
        tone: item("iron-ore").headroomPerMinute < 0 ? "warn" : "good",
      },
      {
        value: n(item("copper-ore").headroomPerMinute),
        label: "copper ore spare/min",
        field: "forces.player.production.item.copper-ore",
        tone: item("copper-ore").headroomPerMinute < 0 ? "warn" : "good",
      },
      { value: String(untouched.length), label: "fields with no drill", field: "map[0].ore" },
      ...runways.map((r) => ({
        value: hours(r.minutes),
        label: `${r.resource.replace(/-ore$/, "")} left under drills`,
        field: `map[0].ore`,
        tone: r.minutes < 60 * 20 ? ("warn" as const) : ("good" as const),
      })),
    ],
    table:
      fields.length > 0
        ? {
            headers: ["field", "remaining", "chunks", "drills"],
            numeric: [1, 2, 3],
            // The biggest field of each resource first, so a resource he has
            // charted can never be absent from the table just because another
            // resource owns the top ten rows, then the next largest until the
            // table is full.
            rows: [
              ...resources
                .map((r) => fields.find((p) => p.resource === r))
                .filter((p): p is Patch => p !== undefined),
              ...fields.filter(
                (p) => !resources.some((r) => fields.find((q) => q.resource === r) === p),
              ),
            ]
              .slice(0, 14)
              .map((p) => [
                `${p.resource} at ${String(Math.round(p.x))}, ${String(Math.round(p.y))}`,
                p.amount >= 1e6 ? `${(p.amount / 1e6).toFixed(1)}M` : `${(p.amount / 1e3).toFixed(0)}k`,
                String(p.chunks),
                String(p.extractors),
              ]),
          }
        : null,
    advice: adviceFor("mining"),
    carry: shortestRunway
      ? `${hours(shortestRunway.minutes)} of ${shortestRunway.resource} left under the drills, and ${String(untouched.length)} charted fields with nothing standing on them.`
      : null,
    layer: "mining",
  });

  return out.filter((s) => s.figures.length > 0 || s.advice.length > 0);
}
