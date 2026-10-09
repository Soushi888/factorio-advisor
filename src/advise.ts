import type { Data, TechProto } from "./proto.ts";
import type { RecipeIndex } from "./recipes.ts";
import { mapOf, patches, powerBlocks, type Patch, type PowerBlock } from "./map.ts";
import { effectiveGeneration, powerReport } from "./power.ts";
import { isBackedUp, occupancy, occupancyOf, occupancyPhrase, type Occupancy } from "./saturation.ts";
import { solve } from "./solve.ts";
import { flowOf, isLegacyFlows, machinesOf, pavingPerMinute, type GameState, type Rates } from "./state.ts";

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
  /**
   * How full the belts and chests carrying it are (C43).
   *
   * `deficitPerMinute` above is required minus spare, and spare on a backed-up
   * line is what its consumers take rather than what it could make, so the
   * deficit overstates the build by however idle the existing machines are.
   * Crude oil on game 4 reads 19.0/min spare and a 2986.9/min deficit while
   * 95% of it sits banked in its own tanks and its 43 refineries are 10% busy.
   */
  sinks: Occupancy;
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
  /**
   * Where on the map this line is about, and the layer that explains it.
   *
   * Present ONLY on advice whose own text names the coordinates, which is the
   * rule the C33 falsifier sets: a line that pans the map to a place it never
   * mentioned is a line the reader cannot check. Most advice is about a rate
   * rather than a place and carries nothing here.
   */
  focus?: { x: number; y: number; w: number; h: number; layer: string };
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
  /** Stages the census finds set to a recipe and producing nothing. */
  stalled: StalledStage[];
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

/**
 * Every item the chain for these products passes through, down to raw.
 *
 * Used to tell a stage that is broken from one that is parked: a stopped
 * battery line matters because batteries are on the way to a science pack the
 * player could research right now, and a stopped grenade line does not, because
 * nothing wants a grenade. The walk uses the index's own default recipe, which
 * is the same rule `bun run ratio` answers by, so the two cannot disagree.
 */
function chainItems(index: RecipeIndex, products: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...products];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (seen.has(item)) continue;
    seen.add(item);
    if (index.isRaw(item)) continue;
    const recipe = index.defaultFor(item);
    if (!recipe) continue;
    for (const ing of recipe.ingredients) stack.push(ing.name);
  }
  return seen;
}

/**
 * How thin a raw line's own slack has to be before an outpost is the answer.
 *
 * Two percent of what the base already eats, and it is a reading choice named
 * here rather than buried in a filter. The important half is what it is NOT
 * measured against: a hypothetical target. Ranking outposts by what a 38/min
 * sizing exercise would like put stone first while stone ran 32.9/min spare,
 * and ranking them by how much ore is left in the ground did the same for a
 * different reason. A line's slack against its OWN consumption is a fact about
 * tonight: copper 0.30%, coal 1.43%, stone 6.17%, iron ore 16.56%.
 */
const OUTPOST_SLACK = 0.02;

/**
 * How close two pack rates have to be before naming a winner is noise.
 *
 * One a minute, and it is a reading choice about this instrument rather than a
 * game fact. The rates are the engine's own one-hour rolling average and they
 * drift by a fraction of a percent between reads; on 2026-09-21 the leader
 * changed twice in two hours on gaps under 0.5/min.
 */
const PACK_NOISE_PER_MINUTE = 1;

/**
 * How much of the shortfall must already exist elsewhere before the advice says
 * move rather than build.
 *
 * Nine tenths, named here. Below that the move only covers part of the gap and
 * the honest instruction is still to build, with the spare capacity mentioned
 * so he can do both. A base with 166 engines' worth of idle boiler and 163
 * engines starving does not need to be told to build anything.
 */
const MOVE_RATHER_THAN_BUILD = 0.9;

/** A recipe a census of machines is set to, and what those machines are doing. */
export interface StalledStage {
  recipe: string;
  /** The product the recipe's own default output names. */
  product: string;
  machines: number;
  /** Something consumes the product, or a researchable pack chain wants it. */
  wanted: boolean;
  /** The first ingredient of this recipe that nothing is producing. */
  missingInput: string | null;
}

export interface AdviseOptions {
  force?: string;
  /** Target rate per science pack, per minute. Derived when absent. */
  spm?: number;
  /**
   * The previous report's state, when there is one.
   *
   * Only used to measure paving, which is the one consumption the game's own
   * statistics do not record. Absent is normal and the advisor simply says it
   * cannot measure paving rather than assuming there is none.
   */
  previous?: GameState | null;
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
  // Paving is a consumption the statistics do not record (MAP-2). Without this
  // correction refined concrete reads as 155.7/min of spare on a base laying
  // 130 tiles a minute with 100 in its chests, and every line that ranks by
  // spare inherits it.
  const paving = pavingPerMinute(state, opts.previous ?? null);
  const rateOf = (name: string): Rates => {
    const raw = flowOf(force.production.item[name] ?? force.production.fluid[name]);
    const laid = paving?.[name];
    if (laid === undefined || laid <= 0) return raw;
    return {
      ...raw,
      consumedPerMinute: raw.consumedPerMinute + laid,
      headroomPerMinute: raw.headroomPerMinute - laid,
    };
  };

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
  // A default nobody typed still has to be explained: twice what the best
  // active line makes now, which is the smallest target that is a real change.
  const spm = opts.spm ?? Math.max(1, Math.round(best * 2));

  const sinks = occupancy(state, data);

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
        sinks: occupancyOf(sinks, item),
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
  // ---- what the census says is standing still ----------------------------
  //
  // The biggest fact about this base and the advisor did not read it: 494 of
  // its 2152 crafting machines are set to a recipe and producing nothing. The
  // section could say "you have never made a utility science pack" and not say
  // that 47 battery machines and 48 robot frame machines are the reason.
  const stalled: StalledStage[] = [];
  if (surfaceMap) {
    const byRecipe = new Map<string, number>();
    for (const m of machinesOf(surfaceMap)) {
      if (typeof m.recipe !== "string") continue;
      byRecipe.set(m.recipe, (byRecipe.get(m.recipe) ?? 0) + 1);
    }
    // What a researchable technology's packs need, all the way down. A stopped
    // stage on this path is a broken chain; one off it is a line he parked.
    const wantedChain = chainItems(index, [...required.keys(), ...missingPacks.map((m) => m.pack)]);
    for (const [recipeName, machines] of byRecipe) {
      const recipe = index.get(recipeName);
      const product = recipe?.mainProduct ?? recipe?.results[0]?.name ?? null;
      if (!recipe || product === null) continue;
      if (rateOf(product).producedPerMinute > 0) continue;
      // A stage whose ingredients nothing produces has a first missing input,
      // and naming it is the difference between "this is stopped" and "this is
      // stopped because nothing upstream is running".
      const missingInput =
        recipe.ingredients.find((i) => rateOf(i.name).producedPerMinute <= 0)?.name ?? null;
      stalled.push({
        recipe: recipeName,
        product,
        machines,
        wanted: rateOf(product).consumedPerMinute > 0 || wantedChain.has(product),
        missingInput,
      });
    }
    stalled.sort((a, b) => b.machines - a.machines);
  }

  // ---- which outposts actually matter ------------------------------------
  //
  // Ranked by what the base is short of, never by what the patches look like.
  // Ranking by depletion recommended a stone outpost while stone ran 32.9/min
  // spare and copper ran 1.6, and copper was listed third.
  // Slack alone cannot say a resource is short (C43). On a base whose sinks are
  // full every line reads at zero slack, because a stopped line produces
  // exactly what is taken from it: copper ore read 0.02% slack here while 99%
  // of the lanes and chests carrying it were full, and the advice was to go lay
  // a copper outpost. A resource with nowhere to put what it already mines is
  // not short of ore, whatever its slack says, so it is dropped rather than
  // ranked, and `wanted` keeps a genuine target requirement in the list.
  const shortResources = ["iron-ore", "copper-ore", "coal", "stone"]
    .map((r) => {
      const rates = rateOf(r);
      const used = rates.consumedPerMinute;
      return {
        resource: r,
        spare: rates.headroomPerMinute,
        used,
        slack: used > 0 ? rates.headroomPerMinute / used : Infinity,
        wanted: target?.requirements.find((x) => x.item === r)?.deficitPerMinute ?? 0,
        sinks: occupancyOf(sinks, r),
      };
    })
    .filter((r) => r.slack < OUTPOST_SLACK)
    // No escape hatch for a target's own deficit, and that was the first thing
    // tried. A deficit is `required minus spare`, so on a backed-up base every
    // resource has one and the hatch let all four through unchanged. If a
    // target wants more of something whose sinks are full, the work is drawing
    // it, not mining it, and the raw-end line below still names the gap.
    .filter((r) => !isBackedUp(r.sinks))
    .sort((a, b) => a.slack - b.slack);

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
    stalled,
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
      enginesPerBoiler: steam?.ratio ?? null,
      fields,
      shortResources,
      stalled,
      pavingMeasured: paving !== null,
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
  /** Engines one boiler feeds, from power.ts's own derivation. Null when unknown. */
  enginesPerBoiler: number | null;
  fields: Patch[];
  shortResources: Array<{
    resource: string;
    spare: number;
    used: number;
    slack: number;
    wanted: number;
    /** How full the belts and chests carrying it are (C43). */
    sinks: Occupancy;
  }>;
  stalled: StalledStage[];
  /** False when no previous read was available, so paving could not be measured. */
  pavingMeasured: boolean;
}

/**
 * The ordered advice.
 *
 * Each rule fires on a measured threshold and carries the measurement with it.
 * A rule that cannot state its number does not belong here, which is why there
 * is no rule about base layout, belt weaving or where to put the mall: no
 * measurement says what a good one is, so the advisor says nothing rather than
 * repeating what every guide already says. Where a rule does name a place, the
 * place comes from the clusters in `map.ts` and is stated as an area.
 */
/**
 * A rectangle as tiles a player can find, never as a bare point.
 *
 * "x -286.5 is not precise enough, what area/tiles are you talking about?"
 * (Soushi, 2026-09-21, mid-game). Every rectangle this module points at already
 * carries its extent, and printing only its corner threw that away: a patch is
 * hundreds of tiles across and its top-left corner is usually ore-free ground.
 * Corner to corner, with the size, is what a player can put on the map.
 */
function areaPhrase(area: { x: number; y: number; w: number; h: number }): string {
  const x1 = Math.round(area.x);
  const y1 = Math.round(area.y);
  return (
    `the ${String(Math.round(area.w))} by ${String(Math.round(area.h))} tile area from ` +
    `${String(x1)}, ${String(y1)} to ${String(x1 + Math.round(area.w))}, ` +
    `${String(y1 + Math.round(area.h))}`
  );
}

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
    // A winner named on a gap smaller than the reads differ by is noise
    // presented as a finding: production read 18.0 against logistic 18.4 at one
    // tick and chemical led two hours earlier. When the packs are level, the
    // levelness IS the finding, and it points at the labs rather than at a line.
    const spread = nextUp === null ? Infinity : nextUp - a.researchPerMinute;
    if (spread < PACK_NOISE_PER_MINUTE) {
      const all = [a.limiting, ...a.required.filter((p) => p !== a.limiting)];
      out.push({
        section: "science",
        text: `Science runs at ${n(a.researchPerMinute)}/min and no single pack sets it.`,
        because:
          `${String(all.length)} packs within ${n(spread, 2)}/min of each other ` +
          `(${all.join(", ")}). A gap that small moves between reads, so speeding one ` +
          `line up buys nothing until they stop being level.`,
      });
    } else {
      out.push({
        section: "science",
        text: `Science runs at ${n(a.researchPerMinute)}/min, and ${a.limiting} is what sets it.`,
        because: `It is the slowest pack the current research needs; the next slowest makes ${n(nextUp ?? 0)}/min.`,
      });
    }
  }

  for (const m of a.missingPacks) {
    // The pack line says WHAT is missing; the census says WHY, and saying only
    // the first is what made this section read as stale to somebody looking at
    // 47 battery machines standing still.
    const chain = a.stalled.filter((x) => x.wanted).slice(0, 3);
    out.push({
      section: "science",
      text: `You have never made a ${m.pack}.`,
      because:
        `${m.gatedTechs} of the technologies you could start right now need it.` +
        (chain.length > 0
          ? ` The census says the chain is stopped rather than missing: ` +
            chain
              .map(
                (x) =>
                  `${String(x.machines)} machines on ${x.recipe} producing nothing` +
                  (x.missingInput ? `, waiting on ${x.missingInput}` : ""),
              )
              .join("; ") +
            "."
          : ""),
    });
  }

  const wanted = a.stalled.filter((x) => x.wanted);
  const parked = a.stalled.filter((x) => !x.wanted);
  if (wanted.length > 0) {
    const machines = wanted.reduce((t, x) => t + x.machines, 0);
    const first = wanted[0]!;
    out.push({
      section: "production",
      text:
        `${String(machines)} machines across ${String(wanted.length)} stages are set to a recipe ` +
        `and producing nothing, and something wants what they make.`,
      because:
        `Worst is ${first.recipe}: ${String(first.machines)} machines` +
        (first.missingInput
          ? `, and the first input nothing is producing is ${first.missingInput}.`
          : `, with every input running, so the stall is downstream of the ingredients.`) +
        ` A stage whose product nothing consumes and no researchable pack wants is not counted here: ` +
        `${String(parked.length)} stages over ${String(parked.reduce((t, x) => t + x.machines, 0))} ` +
        `machines read as parked rather than broken.`,
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
    // Build against move, decided by the census rather than by default.
    //
    // The old line said "start with the block at 128, 736", which was the right
    // place and the wrong verb: it recommended building boilers while 122 of
    // them sat in another block feeding 78 engines. A base that already owns
    // the capacity does not need to be told to buy it, and only the census can
    // tell those two situations apart.
    const short = a.blocks
      .map((b) => ({ b, gap: b.engines - b.fed }))
      .filter((x) => x.gap > 0);
    const surplus = a.enginesPerBoiler === null
      ? []
      : a.blocks
          .map((b) => ({ b, over: b.boilers * a.enginesPerBoiler! - b.engines }))
          .filter((x) => x.over > 0)
          .sort((x, y) => y.over - x.over);
    const totalShort = short.reduce((n, x) => n + x.gap, 0);
    const spare = surplus.reduce((n, x) => n + x.over, 0);
    const donor = surplus[0];
    if (donor && spare >= totalShort * MOVE_RATHER_THAN_BUILD) {
      out.push({
        section: "energy",
        text: `Move boilers into ${areaPhrase(worstBlock)} rather than building them.`,
        because:
          `${String(donor.b.boilers)} boilers at ${String(Math.round(donor.b.x))}, ` +
          `${String(Math.round(donor.b.y))} can feed ${n(donor.b.boilers * a.enginesPerBoiler!, 0)} engines ` +
          `and only ${String(donor.b.engines)} stand there, so ${n(donor.over, 0)} engines' worth is doing ` +
          `nothing. Across the map ${n(totalShort, 0)} engines have no boiler behind them, ` +
          `worst at ${String(Math.round(worstBlock.x))}, ${String(Math.round(worstBlock.y))} where ` +
          `${String(worstBlock.engines)} engines have ${String(worstBlock.boilers)} boilers. ` +
          `The capacity is already built and it is in the wrong place.`,
        focus: { x: donor.b.x, y: donor.b.y, w: donor.b.w, h: donor.b.h, layer: "power" },
      });
    } else {
      out.push({
        section: "energy",
        text: `Start with the power block at ${String(Math.round(worstBlock.x))}, ${String(Math.round(worstBlock.y))}.`,
        because:
          `${String(worstBlock.engines)} engines there against ${String(worstBlock.boilers)} boilers, ` +
          `which feed ${String(Math.floor(worstBlock.fed))} of them. It is the biggest single shortfall on the map` +
          (spare > 0 ? `, and only ${n(spare, 0)} engines' worth of boiler sits spare elsewhere.` : "."),
        focus: { x: worstBlock.x, y: worstBlock.y, w: worstBlock.w, h: worstBlock.h, layer: "power" },
      });
    }
  }

  for (const short of a.shortResources) {
    const resource = short.resource;
    const working = a.fields.filter((p) => p.resource === resource && p.extractors > 0)[0];
    const free = a.fields.filter((p) => p.resource === resource && p.extractors === 0)[0];
    if (!free) continue;
    out.push({
      section: "mining",
      // The shortfall leads, because that is why this line exists. The patch is
      // where to put the answer, not the reason for it: ranking by how much ore
      // is left told him to lay a stone outpost while stone ran 32.9/min spare.
      text: `Put the next ${resource} outpost in ${areaPhrase(free)}.`,
      because:
        `${resource} runs ${n(short.spare)}/min spare on ${n(short.used)}/min used, ` +
        `which is ${(short.slack * 100).toFixed(2)}% slack: the line is at its ceiling now, ` +
        `before anything new is built. ` +
        (short.sinks.fullShare === null
          ? ""
          : `${occupancyPhrase(short.sinks)}, which is short of backed up, so what it mines ` +
            `still has somewhere to go. `) +
        `${ore(free.amount)} there with nothing standing on it` +
        (working
          ? `, against ${ore(working.amount)} left under the ${String(working.extractors)} drills at ` +
            `${String(Math.round(working.x))}, ${String(Math.round(working.y))}.`
          : `, and it is the largest ${resource} field charted.`),
      focus: { x: free.x, y: free.y, w: free.w, h: free.h, layer: "ore" },
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
          `(${n(worst.producedPerMinute)} made, ${n(worst.consumedPerMinute)} used).` +
          // The deficit is required minus spare, and on a backed-up line spare
          // is demand rather than capacity, so the figure is an upper bound and
          // says so rather than being quietly trusted (C43).
          (isBackedUp(worst.sinks)
            ? ` That spare is not a capacity: ${occupancyPhrase(worst.sinks)}, so the line is ` +
              `throttled to what is drawn from it and would give more the moment something ` +
              `drew more. Treat the figure as an upper bound and drain it before building it.`
            : ""),
      });
      const rawGaps = top.filter((r) => r.raw);
      if (rawGaps.length > 0) {
        out.push({
          section: "mining",
          // The target is named IN the line. Without it this read "the raw end
          // is the real work: iron-ore +1082.8/min" on a page that says
          // elsewhere iron ore has 221.8/min spare. Both numbers were right and
          // they answered different questions, and only one of them said which.
          text:
            `At ${n(a.target.spm, 0)} of each pack a minute, the raw end is the real work: ` +
            `${rawGaps.map((r) => r.item).join(", ")}.`,
          because:
            rawGaps
              .map(
                (r) =>
                  `${r.item} +${n(r.deficitPerMinute)}/min for that target, ` +
                  `${n(r.headroomPerMinute)}/min spare today`,
              )
              .join("; ") + ".",
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
