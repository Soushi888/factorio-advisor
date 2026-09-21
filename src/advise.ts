import type { Data, TechProto } from "./proto.ts";
import type { RecipeIndex } from "./recipes.ts";
import { mapOf, patches, powerBlocks, type Patch, type PowerBlock } from "./map.ts";
import { effectiveGeneration, powerReport } from "./power.ts";
import { solve } from "./solve.ts";
import { flowOf, isLegacyFlows, type GameState, type Rates } from "./state.ts";

/**
 * The advisor's synthesis: what the save says about where the base stands, and
 * what the snapshot says it would take to move it.
 *
 * Every other command answers a question that was asked. This one answers the
 * question a player actually has at 2 a.m., which is "what is holding me back
 * and how big is the fix". That makes it the one command most able to lie, so
 * it is built to three rules:
 *
 * 1. Nothing here is a game fact that the snapshot or the save did not state.
 *    Lab capacity comes from the researched technology's own `unit.time` and
 *    the force's own lab speed modifier; requirements come from the same solver
 *    `ratio` uses; rates are the engine's one-hour averages.
 * 2. Every piece of advice carries the number that produced it, so it can be
 *    argued with. An advisor that says "build more smelters" without saying how
 *    many and why is a horoscope.
 * 3. The gap between what a line MAKES and what the base USES is the whole
 *    diagnosis, so both rates are read and the difference is named headroom.
 *    Comparing a requirement against total production would call a saturated
 *    line healthy.
 *
 * This file computes; `cli.ts` formats. It imports nothing from `bridge/`.
 */

/** A science pack, as the save reports it. */
export interface PackLine {
  name: string;
  /** True when the save has ever made one, which is the only proof it has a line. */
  everMade: boolean;
  rates: Rates;
}

export interface LabReport {
  /** Labs that accept every pack the basis technology needs. */
  labs: number;
  labSpeed: number;
  /** Packs of each required kind one lab eats per minute at this tech's unit time. */
  perLabPerMinute: number;
  capacityPerMinute: number;
  /** What the labs actually ate, the slowest required pack. */
  actualPerMinute: number;
  utilisation: number;
  /** The technology whose unit time set the pace, named so the figure can be checked. */
  basis: string;
  unitSeconds: number;
}

export interface Requirement {
  item: string;
  /** What the extra science would need, per minute. */
  requiredPerMinute: number;
  producedPerMinute: number;
  consumedPerMinute: number;
  headroomPerMinute: number;
  /** Required minus headroom, floored at zero: new capacity to build. */
  deficitPerMinute: number;
  /** Machines the solver sizes for this step across every pack chain. */
  machines: number;
  /** True when the item is an ore, a fluid from a tile, or otherwise unmade. */
  raw: boolean;
}

export interface TargetReport {
  /** The target rate per pack, per minute. */
  spm: number;
  /** True when the target was derived rather than given. */
  derived: boolean;
  packs: Array<{ name: string; havePerMinute: number; addPerMinute: number }>;
  wattsAdded: number;
  machinesAdded: number;
  requirements: Requirement[];
  unresolved: string[];
  cycles: string[][];
}

/**
 * The grid, priced two ways.
 *
 * `deliveredWatts` is what the network statistics report actually flowed over
 * the last hour. It is not compared against drawn watts, because in an electric
 * network those two are the same number by conservation: what the grid supplies
 * is what the machines took, and a saturated grid reports a perfect balance
 * while machines brown out. The honest headroom is against what the generators
 * could deliver, which is `capacityWatts`, the same steam-limited, solar-averaged
 * figure `bun run power` draws its balance against.
 */
export interface GridReport {
  deliveredWatts: number;
  nameplateWatts: number;
  capacityWatts: number;
  /** Capacity minus what actually flowed. */
  spareWatts: number;
  /** Steam engines with no boiler behind them. */
  starvedEngines: number;
}

/** The part of the base a piece of advice is about. */
export type SectionId = "science" | "energy" | "defense" | "production" | "logistics" | "mining";

export interface Advice {
  /** What to do. */
  text: string;
  /** The measurement that produced it. */
  because: string;
  /** Which section of the dashboard it belongs under. */
  section: SectionId;
}

export interface Advisory {
  save: string;
  tick: number;
  hoursPlayed: number;
  readAt: string;
  /** True when the state file predates the two-rate collector, so headroom is unknown. */
  legacy: boolean;
  packs: PackLine[];
  /** The packs the current research needs. */
  required: string[];
  /** The slowest of those, and the rate it imposes. */
  limiting: string | null;
  researchPerMinute: number | null;
  currentResearch: string | null;
  labs: LabReport | null;
  grid: GridReport | null;
  target: TargetReport | null;
  /** Packs a researchable technology needs that the base has never made. */
  missingPacks: Array<{ pack: string; gatedTechs: number }>;
  /** Power blocks, worst shortfall first. Empty when the save carries no map. */
  blocks: PowerBlock[];
  /** Ore fields, largest first. Empty when the save carries no map. */
  fields: Patch[];
  advice: Advice[];
}

function isSciencePack(data: Data, name: string): boolean {
  if (!name.endsWith("science-pack") && name !== "space-science-pack") return false;
  return data.item(name) !== null;
}

/** The pack names and per-unit amounts a technology's `unit` asks for. */
function unitPacks(tech: TechProto): { packs: Map<string, number>; seconds: number } {
  const packs = new Map<string, number>();
  const unit = tech.unit;
  if (!unit) return { packs, seconds: 0 };
  for (const ing of unit.ingredients ?? []) {
    if (!Array.isArray(ing)) continue;
    const [name, amount] = ing;
    if (typeof name !== "string") continue;
    packs.set(name, typeof amount === "number" ? amount : 1);
  }
  return { packs, seconds: typeof unit.time === "number" ? unit.time : 0 };
}

/** Labs whose declared inputs cover every pack in `packs`. */
function labsAccepting(data: Data, census: Record<string, number>, packs: Iterable<string>): number {
  const needed = [...packs];
  let n = 0;
  for (const [name, proto] of Object.entries(data.klass("lab"))) {
    const count = census[name] ?? 0;
    if (count === 0) continue;
    const inputs = proto["inputs"];
    if (!Array.isArray(inputs)) continue;
    const accepted = new Set(inputs.filter((x): x is string => typeof x === "string"));
    if (needed.every((p) => accepted.has(p))) n += count;
  }
  return n;
}

function gridOf(data: Data, state: GameState, force: string): GridReport | null {
  const el = state.forces[force]?.electric;
  if (!el) return null;
  // Already watts when the collector stored them: 34 radars at a 300 kW
  // nameplate land at 10.14 MW in this field, which `bun run power` prints
  // through `formatWatts` unscaled. Multiplying by the tick rate here once
  // reported a 6.7 GW grid.
  const deliveredWatts = Object.values(el.production).reduce((n, w) => n + w, 0);
  const eff = effectiveGeneration(powerReport(data, state, force));
  return {
    deliveredWatts,
    nameplateWatts: eff.nameplate,
    capacityWatts: eff.effective,
    spareWatts: eff.effective - deliveredWatts,
    starvedEngines: eff.starvedEngines,
  };
}

export interface AdviseOptions {
  force?: string;
  /** Target rate per science pack, per minute. Derived when absent. */
  spm?: number;
}

export function advise(
  data: Data,
  index: RecipeIndex,
  state: GameState,
  researchableTechs: TechProto[],
  opts: AdviseOptions = {},
): Advisory {
  const forceName = opts.force ?? "player";
  const force = state.forces[forceName];
  if (!force) {
    const names = Object.keys(state.forces).join(", ");
    throw new Error(`No force called "${forceName}" in this save. Forces: ${names}.`);
  }
  const legacy = isLegacyFlows(state, forceName);
  // Fluids live in their own map. Reading only the item map once reported
  // "3453/min of crude-oil needed, 0 spare (0 made, 0 used)" on a base running
  // 43 refineries: every fluid gap was the lookup missing, not the base.
  const rateOf = (name: string): Rates =>
    flowOf(force.production.item[name] ?? force.production.fluid[name]);

  // ---- the packs ---------------------------------------------------------
  const packs: PackLine[] = [];
  for (const name of data.items().keys()) {
    if (!isSciencePack(data, name)) continue;
    const rates = rateOf(name);
    packs.push({ name, everMade: rates.produced > 0, rates });
  }
  packs.sort((a, b) => b.rates.producedPerMinute - a.rates.producedPerMinute || a.name.localeCompare(b.name));

  // ---- the research pace -------------------------------------------------
  const currentName = force.technologies.current;
  const current = currentName ? data.technology(currentName) : null;
  const basis = current ?? researchableTechs[0] ?? null;
  const { packs: required, seconds } = basis ? unitPacks(basis) : { packs: new Map<string, number>(), seconds: 0 };

  let limiting: string | null = null;
  let researchPerMinute: number | null = null;
  for (const pack of required.keys()) {
    const r = rateOf(pack);
    const made = legacy ? r.consumedPerMinute : r.producedPerMinute;
    if (researchPerMinute === null || made < researchPerMinute) {
      researchPerMinute = made;
      limiting = pack;
    }
  }

  // ---- the labs ----------------------------------------------------------
  const labSpeed = 1 + (force.research?.labSpeedModifier ?? 0);
  let labs: LabReport | null = null;
  if (basis && seconds > 0 && required.size > 0) {
    const count = labsAccepting(data, force.machines, required.keys());
    const perLabPerMinute = (60 / (seconds / labSpeed)) * Math.max(...required.values());
    const capacity = count * perLabPerMinute;
    // What the labs actually ate: the pack they consumed least of is the pace.
    let actual = Infinity;
    for (const pack of required.keys()) {
      actual = Math.min(actual, rateOf(pack).consumedPerMinute);
    }
    if (!Number.isFinite(actual)) actual = 0;
    labs = {
      labs: count,
      labSpeed,
      perLabPerMinute,
      capacityPerMinute: capacity,
      actualPerMinute: actual,
      utilisation: capacity > 0 ? actual / capacity : 0,
      basis: basis.name,
      unitSeconds: seconds,
    };
  }

  // ---- the target --------------------------------------------------------
  const currentRate = (p: PackLine): number =>
    legacy ? p.rates.consumedPerMinute : p.rates.producedPerMinute;
  // A line that ran in the last hour, not one that ever ran. `military-science-pack`
  // has 8762 made across 88 hours and nothing in the window; targeting it would
  // charge the whole refactor for a line he stopped using.
  const active = packs.filter((p) => p.everMade && currentRate(p) > 0);
  const derived = opts.spm === undefined;
  const best = active.reduce((n, p) => Math.max(n, currentRate(p)), 0);
  // A default nobody typed still has to be explained: twice what the slowest
  // active line makes now, which is the smallest target that is a real change.
  const spm = opts.spm ?? Math.max(1, Math.round(best * 2));

  let target: TargetReport | null = null;
  if (active.length > 0 && spm > 0) {
    const need = new Map<string, { perMinute: number; machines: number; raw: boolean }>();
    const add = (item: string, perMinute: number, machines: number, raw: boolean): void => {
      const e = need.get(item);
      if (e) {
        e.perMinute += perMinute;
        e.machines += machines;
      } else {
        need.set(item, { perMinute, machines, raw });
      }
    };
    const unresolved = new Set<string>();
    const cycles: string[][] = [];
    let watts = 0;
    let machines = 0;
    const packTargets: TargetReport["packs"] = [];

    for (const pack of active) {
      const have = currentRate(pack);
      const delta = Math.max(0, spm - have);
      packTargets.push({ name: pack.name, havePerMinute: have, addPerMinute: delta });
      if (delta <= 0) continue;
      const sol = solve(data, index, pack.name, delta / 60);
      watts += sol.totalWatts;
      machines += sol.totalMachines;
      for (const step of sol.steps) {
        add(step.product, step.ratePerSecond * 60, step.machineCount, false);
      }
      for (const [item, perSecond] of sol.raw) add(item, perSecond * 60, 0, true);
      for (const u of sol.unresolved) unresolved.add(u);
      cycles.push(...sol.cycles);
    }

    const requirements: Requirement[] = [];
    for (const [item, e] of need) {
      const r = rateOf(item);
      const headroom = r.headroomPerMinute;
      requirements.push({
        item,
        requiredPerMinute: e.perMinute,
        producedPerMinute: r.producedPerMinute,
        consumedPerMinute: r.consumedPerMinute,
        headroomPerMinute: headroom,
        deficitPerMinute: Math.max(0, e.perMinute - Math.max(0, headroom)),
        machines: e.machines,
        raw: e.raw,
      });
    }
    requirements.sort((a, b) => b.deficitPerMinute - a.deficitPerMinute);

    target = {
      spm,
      derived,
      packs: packTargets,
      wattsAdded: watts,
      machinesAdded: machines,
      requirements,
      unresolved: [...unresolved],
      cycles,
    };
  }

  // ---- packs a researchable technology wants and the base never made ------
  const missing = new Map<string, number>();
  for (const tech of researchableTechs) {
    for (const pack of unitPacks(tech).packs.keys()) {
      if (rateOf(pack).produced > 0) continue;
      missing.set(pack, (missing.get(pack) ?? 0) + 1);
    }
  }
  const missingPacks = [...missing]
    .map(([pack, gatedTechs]) => ({ pack, gatedTechs }))
    .sort((a, b) => b.gatedTechs - a.gatedTechs);

  const grid = gridOf(data, state, forceName);

  // ---- geometry ----------------------------------------------------------
  // Only a state file written by the map-aware collector has any of this, and
  // an older one simply gets no advice that names a place rather than a wrong
  // one.
  const surfaceMap = mapOf(state);
  const steam = powerReport(data, state, forceName).steam;
  const blocks = surfaceMap && steam ? powerBlocks(surfaceMap, steam.ratio) : [];
  const fields = surfaceMap
    ? patches(surfaceMap, ["electric-mining-drill", "burner-mining-drill", "big-mining-drill", "pumpjack"])
    : [];
  const shortResources = ["iron-ore", "copper-ore", "coal", "stone"].filter((r) => {
    const wanted = target?.requirements.find((x) => x.item === r);
    return rateOf(r).headroomPerMinute < 0 || (wanted?.deficitPerMinute ?? 0) > 0;
  });

  return {
    save: state.save.name,
    tick: state.save.tick,
    hoursPlayed: state.save.hoursPlayed,
    readAt: state.save.readAt,
    legacy,
    packs,
    required: [...required.keys()],
    limiting,
    researchPerMinute,
    currentResearch: currentName,
    labs,
    grid,
    target,
    missingPacks,
    blocks,
    fields,
    advice: buildAdvice({
      legacy,
      packs,
      required: [...required.keys()],
      limiting,
      researchPerMinute,
      labs,
      grid,
      target,
      missingPacks,
      blocks,
      fields,
      shortResources,
    }),
  };
}

interface AdviceInput {
  legacy: boolean;
  packs: PackLine[];
  required: string[];
  limiting: string | null;
  researchPerMinute: number | null;
  labs: LabReport | null;
  grid: GridReport | null;
  target: TargetReport | null;
  missingPacks: Array<{ pack: string; gatedTechs: number }>;
  blocks: PowerBlock[];
  fields: Patch[];
  shortResources: string[];
}

/**
 * The ordered advice.
 *
 * Each rule fires on a measured threshold and carries the measurement with it.
 * A rule that cannot state its number does not belong here, which is why there
 * is no rule about base layout, belt weaving or where to put the mall: the save
 * does not report position, so the advisor has nothing to say about it and says
 * nothing rather than repeating what every guide already says.
 */
function buildAdvice(a: AdviceInput): Advice[] {
  const out: Advice[] = [];
  const mw = (w: number): string => `${(w / 1e6).toFixed(1)} MW`;
  const n = (v: number, p = 1): string => v.toFixed(p);
  const ore = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}k`);

  if (a.legacy) {
    out.push({
      section: "production",
      text: "Re-read the save before trusting the headroom figures.",
      because:
        "This state file predates the two-rate collector, so it carries consumption only. " +
        "Production per minute reads as zero and headroom is unknown.",
    });
  }

  if (a.labs && a.labs.utilisation < 0.6 && a.labs.labs > 0) {
    out.push({
      section: "science",
      text: "Do not build more labs. Feed the ones you have.",
      because:
        `${a.labs.labs} labs at ${n(a.labs.labSpeed, 2)}x could eat ` +
        `${n(a.labs.capacityPerMinute)} packs/min on ${a.labs.basis} ` +
        `(${n(a.labs.unitSeconds, 0)} s per unit), and they ate ${n(a.labs.actualPerMinute)}. ` +
        `That is ${(a.labs.utilisation * 100).toFixed(1)}% of what the labs can take.`,
    });
  }

  if (a.limiting && a.researchPerMinute !== null) {
    // Compared against the other packs the same research needs. Comparing
    // against every pack ever made once reported "the next slowest makes 0/min"
    // by picking a line that had been off for eighty hours.
    const others = a.required
      .filter((p) => p !== a.limiting)
      .map((p) => a.packs.find((x) => x.name === p))
      .filter((p): p is PackLine => p !== undefined)
      .map((p) => (a.legacy ? p.rates.consumedPerMinute : p.rates.producedPerMinute));
    const nextUp = others.length > 0 ? Math.min(...others) : null;
    out.push({
      section: "science",
      text: `Science runs at ${n(a.researchPerMinute)}/min, and ${a.limiting} is what sets it.`,
      because:
        nextUp !== null
          ? `It is the slowest pack the current research needs; the next slowest makes ${n(nextUp)}/min.`
          : "It is the slowest pack the current research needs.",
    });
  }

  for (const m of a.missingPacks) {
    out.push({
      section: "science",
      text: `You have never made a ${m.pack}.`,
      because: `${m.gatedTechs} of the technologies you could start right now need it.`,
    });
  }

  if (a.grid && a.grid.starvedEngines > 0) {
    out.push({
      section: "energy",
      text: `${a.grid.starvedEngines} steam engines have no boiler behind them.`,
      because:
        `Nameplate generation is ${mw(a.grid.nameplateWatts)} and only ` +
        `${mw(a.grid.capacityWatts)} can actually be delivered. Boilers are the ` +
        `cheapest megawatts on the map: the engines are already built.`,
    });
  }

  // The same advice with a place on it. `advise` knows rates; the map knows
  // where, and an advisor that can say where is worth more than one that
  // cannot.
  const worstBlock = a.blocks.filter((b) => b.fed < b.engines)[0];
  if (worstBlock) {
    out.push({
      section: "energy",
      text: `Start with the power block at ${String(Math.round(worstBlock.x))}, ${String(Math.round(worstBlock.y))}.`,
      because:
        `${String(worstBlock.engines)} engines there against ${String(worstBlock.boilers)} boilers, ` +
        `which feed ${String(Math.floor(worstBlock.fed))} of them. It is the biggest single shortfall on the map.`,
    });
  }

  for (const resource of a.shortResources) {
    const working = a.fields.filter((p) => p.resource === resource && p.extractors > 0)[0];
    const free = a.fields.filter((p) => p.resource === resource && p.extractors === 0)[0];
    if (!free) continue;
    out.push({
      section: "mining",
      text: `Put the next ${resource} outpost at ${String(Math.round(free.x))}, ${String(Math.round(free.y))}.`,
      because:
        `${ore(free.amount)} there with nothing standing on it` +
        (working
          ? `, against ${ore(working.amount)} left under the ${String(working.extractors)} drills at ` +
            `${String(Math.round(working.x))}, ${String(Math.round(working.y))}.`
          : `, and it is the largest ${resource} field charted.`),
    });
  }

  if (a.target) {
    const top = a.target.requirements.filter((r) => r.deficitPerMinute > 0).slice(0, 5);
    if (top.length > 0) {
      const worst = top[0]!;
      out.push({
        section: "production",
        text:
          `Reaching ${n(a.target.spm, 0)}/min per pack means building for ` +
          `${n(worst.deficitPerMinute)} more ${worst.item} a minute first.`,
        because:
          `The chain wants ${n(worst.requiredPerMinute)}/min of it and the base has ` +
          `${n(worst.headroomPerMinute)}/min spare ` +
          `(${n(worst.producedPerMinute)} made, ${n(worst.consumedPerMinute)} used).`,
      });
      const rawGaps = top.filter((r) => r.raw);
      if (rawGaps.length > 0) {
        out.push({
          section: "mining",
          text: `The raw end is the real work: ${rawGaps.map((r) => r.item).join(", ")}.`,
          because: rawGaps
            .map((r) => `${r.item} +${n(r.deficitPerMinute)}/min`)
            .join(", "),
        });
      }
    }
    if (a.grid) {
      const added = a.target.wattsAdded;
      if (added > a.grid.spareWatts) {
        out.push({
          section: "energy",
          text: `Grow the grid before the science: the new machines want ${mw(added)}.`,
          because:
            `Generators can deliver ${mw(a.grid.capacityWatts)} once solar is averaged and ` +
            `unfed engines are subtracted, and ${mw(a.grid.deliveredWatts)} already flows, ` +
            `so ${mw(a.grid.spareWatts)} is spare.`,
        });
      }
    }
    if (a.target.machinesAdded > 0) {
      out.push({
        section: "production",
        text: `The whole addition is about ${a.target.machinesAdded} machines.`,
        because: "Sized by the same solver `bun run ratio` uses, rounded up per step.",
      });
    }
  }

  return out;
}
