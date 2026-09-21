import { EMPTY_LOADOUT, machinesFor, multipliers, runOne } from "./machines.ts";
import type { CraftingMachine, Data } from "./proto.ts";
import type { Recipe, RecipeIndex } from "./recipes.ts";
import { flowOf, isLegacyFlows, type GameState } from "./state.ts";

/**
 * What is holding the factory back, read two independent ways.
 *
 * The question "where is my bottleneck" has two honest answers and they are not
 * the same measurement, so this module computes both and never blends them.
 *
 * 1. **Machine-class utilisation.** How much of a class's time the base's own
 *    output implies it spent crafting. The census says how many of each machine
 *    are placed; the production statistics say how much came out; the prototype
 *    says how fast one machine makes it. Divide and you get how many machines'
 *    worth of work the class actually did. A class near 1 is the wall itself and
 *    more of them raises output. A class near 0.2 is starved, and building more
 *    of it does nothing, because the wall is upstream.
 *
 * 2. **Item tightness.** What a line makes minus what the base eats, against its
 *    own demand. A line eating everything it makes has nothing left for the next
 *    thing built on it, however healthy its absolute rate looks.
 *
 * The first reading is about capital, the second about flow, and a base is
 * usually short of exactly one of them at a time. That is why they are ranked
 * separately rather than folded into one score: a single number would hide which
 * of the two it came from, and the fix is different in each case.
 *
 * Every figure here comes from the snapshot or from the engine's report on a copy
 * of the save. What cannot be read is named in `limits` rather than estimated:
 * a save read reports no module loadouts at all, so a class running speed modules
 * reads over 100% busy and this module says so rather than inventing a factor.
 *
 * This file computes; `cli.ts` formats.
 */

/**
 * Reporting cut-offs for the WORDING of a finding, not game facts.
 *
 * They decide when a sentence calls a class a wall or calls it starved. The
 * measured fraction is printed on every row either way, so a reader who thinks
 * the cut is in the wrong place can see the number and disagree with it. No
 * arithmetic anywhere in this file depends on them.
 */
const BUSY_FRACTION = 0.8;
const STARVED_FRACTION = 0.5;
/** Below this demand an item's headroom ratio is noise, so it is not ranked. */
const MIN_DEMAND_PER_MINUTE = 1;
/** How many tightness rows earn a written finding. */
const TIGHTNESS_FINDINGS = 5;

/** One recipe's contribution to a machine class's busy time. */
export interface ChargedRecipe {
  recipe: string;
  /** Machine-equivalents of work this recipe's output implies. */
  busyEquivalent: number;
  /** The product or ingredient whose measured rate set the charge. */
  product: string;
  producedPerMinute: number;
  /** What one machine of this class makes, or eats, of that per minute. */
  perMachinePerMinute: number;
  /** Crafts a minute the whole base ran of this recipe, across every class. */
  craftsPerMinute: number;
  /** How that rate was fixed: a measurement, or the default rule as a fallback. */
  pin: PinRule;
  /**
   * Why this recipe was attributed to this class.
   *
   * `default` is the recipe index's own default rule. `census` means the default
   * recipe needs a machine class this base has none of, so the choice fell to the
   * best recipe among those a class in the census can actually run.
   */
  rule: "default" | "census";
  /** Every census class that could have run it, this one included. */
  pool: string[];
  /** This class's share of the pool's crafting capacity, which set the split. */
  share: number;
}

export interface ClassUtilisation {
  /** The machine prototype, as the census names it. */
  machine: string;
  /** How many are placed, from the census. */
  count: number;
  /** Machine-equivalents of work charged to the class. */
  busyEquivalent: number;
  /** busyEquivalent / count. */
  fraction: number;
  /** What the time was charged by, biggest first. */
  charged: ChargedRecipe[];
}

export interface ItemTightness {
  name: string;
  kind: "item" | "fluid";
  madePerMinute: number;
  usedPerMinute: number;
  /** Made minus used: what is left for anything new. */
  sparePerMinute: number;
  /** Spare against demand. 0 means the line eats exactly what it makes. */
  headroomRatio: number;
}

/** A product with an output rate that could not be charged to any class. */
export interface Unattributed {
  product: string;
  producedPerMinute: number;
  /** The recipe that would make it, when there is one. */
  recipe: string | null;
  /** Classes that could run that recipe, none of which the census has. */
  couldRun: string[];
  /**
   * Recipes that also make it, that this base has the machines for, and that it
   * has researched.
   *
   * Only ever non-empty on a `raw` row, and when it is, the row is worth reading
   * twice: Space Age declares resources and tile fluids from planets Soushi has
   * not reached, so heavy oil reads as raw because an oil ocean exists on
   * Fulgora and sulfuric acid because a geyser exists on Vulcanus, while on
   * Nauvis he makes both in buildings that are charged nothing here. Barrelling
   * recipes turn up in this list too and mean nothing, which is why the recipes
   * are named rather than summarised into a verdict.
   */
  alsoMadeBy: string[];
  /** The census has a class that could run the recipe named. */
  machinePlaced: boolean;
  /** The force has researched the recipe named. */
  recipeResearched: boolean;
  reason: "raw" | "not-runnable";
}

export interface Finding {
  /**
   * `diagnosis` is the one-sentence reading of the whole base and comes first
   * when it appears at all. It is derived from the two readings against each
   * other, never written for a base: it says the machines are the wall only
   * when a class is actually at it, says the input is the wall only when no
   * class is and the tightest line is something no recipe here makes, and
   * appears not at all when neither holds.
   */
  kind: "utilisation" | "tightness" | "diagnosis";
  /** What it means for the factory. */
  text: string;
  /** The measurement that produced it. */
  because: string;
  /** The machine class or the item the finding is about. */
  subject: string;
}

export interface BottleneckReport {
  force: string;
  /** True when the state file predates the two-rate collector: nothing below is usable. */
  legacy: boolean;
  /** Machine classes the census has, busiest first. */
  utilisation: ClassUtilisation[];
  /** Items and fluids with real demand, tightest first. */
  tightness: ItemTightness[];
  /** How many items and fluids were considered before the demand cut. */
  tightnessConsidered: number;
  minDemandPerMinute: number;
  unattributed: Unattributed[];
  findings: Finding[];
  /** What this reading cannot see, stated rather than estimated. */
  limits: string[];
}

/**
 * Every machine class the census actually has that can run this recipe.
 *
 * Restricting to the census is the whole point: the solver would pick an
 * assembling machine 3 for a base that has none, and charging its speed would
 * make a class of assembling machine 2 read as half as busy as it is.
 *
 * The pool is a list rather than a single winner because a base usually runs
 * several. This save has 17 steel furnaces and 513 electric furnaces on the one
 * smelting category, and charging the fastest one everything put the steel
 * furnaces at 709% busy while the electric furnaces read zero: an answer that is
 * wrong about both classes. A save read reports no recipe per machine, so which
 * furnace smelted what is not knowable, and the split is stated instead of
 * guessed. See `shares`.
 */
function poolFor(data: Data, census: Map<string, number>, recipe: Recipe): CraftingMachine[] {
  return machinesFor(data, recipe).filter(
    (m) => m.type !== "character" && (census.get(m.name) ?? 0) > 0,
  );
}

/**
 * How a recipe's work divides among the classes that could have done it.
 *
 * By crafting capacity, which is count times crafting speed: two classes of the
 * same speed split it by how many are placed, and a faster class takes more of
 * it per machine. It is a modelling choice, not a measurement, and it is the
 * only one available that treats every placed machine alike. Its consequence is
 * visible and intended: classes sharing a recipe report the same busy fraction,
 * because nothing in the save distinguishes them.
 */
function shares(pool: CraftingMachine[], census: Map<string, number>): Map<string, number> {
  const capacity = new Map<string, number>();
  let total = 0;
  for (const m of pool) {
    const c = (census.get(m.name) ?? 0) * m.crafting_speed;
    capacity.set(m.name, c);
    total += c;
  }
  const out = new Map<string, number>();
  for (const [name, c] of capacity) out.set(name, total > 0 ? c / total : 0);
  return out;
}

/**
 * Whether the force could have run this recipe at all.
 *
 * An unresearched recipe made nothing, however well it fits the product. Without
 * this, 121514/min of steam from 115 boilers was charged to the chemical plants
 * through `acid-neutralisation`, a Vulcanus recipe behind `calcite-processing`,
 * which this save has not researched. Found by hand-checking the chemical plant
 * row against the raw JSON, 2026-09-21.
 */
function runnable(index: RecipeIndex, researched: Set<string>, r: Recipe): boolean {
  return r.enabled || index.unlockedBy(r.name).some((t) => researched.has(t));
}

/** How a recipe's craft rate was fixed, which is the provenance of its charge. */
export type PinRule = "only-producer" | "only-consumer" | "residual";

/** One recipe the base is running, at the rate its own measurements imply. */
interface RecipeRun {
  recipe: Recipe;
  pool: CraftingMachine[];
  craftsPerMinute: number;
  /** Capacity-weighted productivity of the pool, from declared machine effects. */
  productivity: number;
  pin: PinRule;
  /** The product or ingredient whose measured rate fixed the craft rate. */
  by: string;
  byRate: number;
  byKind: "made" | "used";
}

interface Candidate {
  recipe: Recipe;
  pool: CraftingMachine[];
  productivity: number;
}

function amountOut(r: Recipe, product: string): number {
  let n = 0;
  for (const x of r.results) if (x.name === product) n += x.amount;
  return n;
}

function amountIn(r: Recipe, product: string): number {
  let n = 0;
  for (const x of r.ingredients) if (x.name === product) n += x.amount;
  return n;
}

/**
 * The pool's productivity, weighted the same way its work is.
 *
 * Module productivity is invisible in a save, so this is only what the machines
 * declare in their own prototypes, which for the foundry, the electromagnetic
 * plant and the biochamber is half again. It matters here because a craft rate
 * inferred from output has to divide that back out, or a foundry's own bonus
 * reads as extra crafts.
 */
function poolProductivity(
  r: Recipe,
  pool: CraftingMachine[],
  census: Map<string, number>,
): number {
  let weight = 0;
  let total = 0;
  for (const m of pool) {
    const w = (census.get(m.name) ?? 0) * m.crafting_speed;
    weight += w;
    total += w * multipliers(EMPTY_LOADOUT, r, m).productivity;
  }
  return weight > 0 ? total / weight : 1;
}

/**
 * Which recipes the base is running, and how fast.
 *
 * The old reading charged a product's whole output to one recipe chosen by the
 * index's default rule, which is a rule about what a player COULD build, not
 * about what this base did. On Soushi's save that charged every gram of
 * petroleum gas to basic oil processing, which he barely runs, and overstated
 * his refineries by a quarter. It also charged heavy oil and sulfuric acid to
 * nobody, because Space Age declares both raw on planets he has never visited.
 *
 * So the mix is solved from the base's own numbers instead, by three facts that
 * are measurements rather than preferences:
 *
 *   - **A craft yields every result and eats every ingredient.** A recipe with a
 *     result nothing produced, or an ingredient nothing consumed, did not run.
 *     That is what rules out barrelling, which otherwise "makes" 25000/min of
 *     water, and it needs no list of recipe names to do it.
 *   - **A product made by exactly one surviving recipe pins that recipe.** Heavy
 *     oil is made only by advanced oil processing here, so the advanced rate is
 *     fixed by the heavy oil rate, and with it the light oil and petroleum that
 *     the same crafts had to produce.
 *   - **An ingredient eaten by exactly one surviving recipe pins it too.** Once
 *     advanced processing is pinned, the crude it did not eat can only have gone
 *     to basic processing, which fixes that rate in turn.
 *
 * Each pin subtracts what it explains, so the next one is decided on what is
 * left, and the pass repeats until nothing more can be fixed. Whatever is still
 * open takes its product's residual through the default rule, so nothing is
 * silently dropped, and every charge carries the rule and the measurement that
 * produced it.
 *
 * The falsifier is independent and the probe uses it: both refinery recipes eat
 * 100 crude per five seconds, so busy refineries are crude used over 1200 no
 * matter what the mix is. The solve has to land there and does.
 */
function solveMix(
  data: Data,
  index: RecipeIndex,
  census: Map<string, number>,
  researched: Set<string>,
  flows: Map<string, { kind: "item" | "fluid"; made: number; used: number }>,
): { runs: RecipeRun[]; makeable: Set<string> } {
  const made = (n: string): number => flows.get(n)?.made ?? 0;
  const used = (n: string): number => flows.get(n)?.used ?? 0;
  const isFluid = (n: string): boolean => flows.get(n)?.kind === "fluid";

  const survivors: Candidate[] = [];
  for (const r of index.all.values()) {
    if (!index.isProduction(r)) continue;
    if (!runnable(index, researched, r)) continue;
    if (r.results.length === 0) continue;
    const pool = poolFor(data, census, r);
    if (pool.length === 0) continue;
    if (r.results.some((x) => made(x.name) <= 0)) continue;
    if (r.ingredients.some((x) => used(x.name) <= 0)) continue;
    survivors.push({ recipe: r, pool, productivity: poolProductivity(r, pool, census) });
  }

  const makeable = new Set<string>();
  for (const c of survivors) for (const x of c.recipe.results) makeable.add(x.name);

  const runs: RecipeRun[] = [];
  const producedByRuns = (p: string): number =>
    runs.reduce((n, run) => n + run.craftsPerMinute * amountOut(run.recipe, p) * run.productivity, 0);
  const consumedByRuns = (p: string): number =>
    runs.reduce((n, run) => n + run.craftsPerMinute * amountIn(run.recipe, p), 0);

  let open = [...survivors];

  /**
   * How many times a recipe can have run, from its own measurements.
   *
   * Every measured quantity it touches is a ceiling: a craft yields each result
   * and eats each ingredient, so the recipe cannot have run more times than the
   * tightest of them allows, counting only what recipes already fixed have not
   * already explained. The tightest one is the answer, and it is named in the
   * charge so the figure can be checked against the save.
   *
   * **Only fluid ingredients count, and that is the load-bearing distinction.**
   * An item's consumption is not a statement about recipes: it counts fuel
   * burned, entities built, hand-crafting, and it says nothing about what came
   * out of a chest. Coal reads as consumed at 988/min on a base whose plastic
   * line eats a fraction of that, the rest going into boilers, furnaces and
   * locomotives. Worse, over an hour the items need not balance at all: this
   * save consumed 1721/min of iron plate while the recipes running on it needed
   * about 2056, because it is drawing the difference out of chests, and bounding
   * by that pool charged the steel line at 203 crafts a minute where its own
   * output says 286. A fluid has none of those escapes. It is not burned here,
   * not built, not hand-crafted and not kept in a chest, so what was consumed is
   * what recipes consumed, and where it is buffered in a tank or voided the
   * figure only goes up, which loosens the bound rather than tightening it
   * wrongly. Both faults were found by reading the table after the probe passed.
   */
  const boundOf = (
    c: Candidate,
  ): { crafts: number; by: string; byRate: number; byKind: "made" | "used" } | null => {
    let best: { crafts: number; by: string; byRate: number; byKind: "made" | "used" } | null = null;
    for (const res of c.recipe.results) {
      const per = res.amount * c.productivity;
      if (per <= 0) continue;
      const residual = Math.max(0, made(res.name) - producedByRuns(res.name));
      const crafts = residual / per;
      if (!best || crafts < best.crafts) {
        best = { crafts, by: res.name, byRate: residual, byKind: "made" };
      }
    }
    for (const ing of c.recipe.ingredients) {
      if (ing.amount <= 0 || !isFluid(ing.name)) continue;
      const residual = Math.max(0, used(ing.name) - consumedByRuns(ing.name));
      const crafts = residual / ing.amount;
      if (!best || crafts < best.crafts) {
        best = { crafts, by: ing.name, byRate: residual, byKind: "used" };
      }
    }
    return best;
  };

  /**
   * Whether the base's numbers single this recipe out, and how.
   *
   * Being the only surviving maker of a product, or the only surviving eater of
   * an ingredient, is what makes a rate attributable at all. It decides which
   * recipe to fix next; `boundOf` decides at what rate.
   */
  const pinRuleFor = (c: Candidate): PinRule | null => {
    for (const res of c.recipe.results) {
      if (open.filter((x) => amountOut(x.recipe, res.name) > 0).length !== 1) continue;
      if (made(res.name) - producedByRuns(res.name) > 0) return "only-producer";
    }
    for (const ing of c.recipe.ingredients) {
      if (!isFluid(ing.name)) continue;
      if (open.filter((x) => amountIn(x.recipe, ing.name) > 0).length !== 1) continue;
      if (used(ing.name) - consumedByRuns(ing.name) > 0) return "only-consumer";
    }
    return null;
  };

  for (;;) {
    let progress = false;
    for (const c of open) {
      const pin = pinRuleFor(c);
      if (!pin) continue;
      const bound = boundOf(c);
      open = open.filter((x) => x !== c);
      progress = true;
      if (bound && bound.crafts > 0) {
        runs.push({
          recipe: c.recipe,
          pool: c.pool,
          productivity: c.productivity,
          craftsPerMinute: bound.crafts,
          pin,
          by: bound.by,
          byRate: bound.byRate,
          byKind: bound.byKind,
        });
      }
      break;
    }
    if (!progress) break;
  }

  // What the propagation could not fix: several open recipes still share every
  // product and every ingredient, so the base's numbers do not tell them apart.
  // Their products' leftovers go through the index's default rule, which is a
  // preference rather than a measurement, and the charge says so.
  const chosenFor = new Set<string>();
  for (const product of makeable) {
    if (made(product) - producedByRuns(product) <= 0) continue;
    const candidates = open.filter((x) => amountOut(x.recipe, product) > 0);
    if (candidates.length === 0) continue;
    chosenFor.add(pickDefault(index, candidates, product).recipe.name);
  }
  for (const c of open) {
    if (!chosenFor.has(c.recipe.name)) continue;
    const bound = boundOf(c);
    if (!bound || bound.crafts <= 0) continue;
    runs.push({
      recipe: c.recipe,
      pool: c.pool,
      productivity: c.productivity,
      craftsPerMinute: bound.crafts,
      pin: "residual",
      by: bound.by,
      byRate: bound.byRate,
      byKind: bound.byKind,
    });
  }

  return { runs, makeable };
}

/**
 * The index's default rule, applied to the candidates still open.
 *
 * Same terms the index uses, minus its chain-depth one, which is private to it:
 * a recipe whose main product is the target beats one making it as a byproduct,
 * then shallower in the tech tree, then fewer ingredients, then the name.
 */
function pickDefault(index: RecipeIndex, candidates: Candidate[], product: string): Candidate {
  const preferred = index.defaultFor(product);
  const exact = preferred ? candidates.find((c) => c.recipe.name === preferred.name) : undefined;
  if (exact) return exact;
  return [...candidates].sort(
    (a, b) =>
      (a.recipe.mainProduct === product ? 0 : 1) - (b.recipe.mainProduct === product ? 0 : 1) ||
      index.techDepth(a.recipe) - index.techDepth(b.recipe) ||
      a.recipe.ingredients.length - b.recipe.ingredients.length ||
      a.recipe.name.localeCompare(b.recipe.name),
  )[0]!;
}

export function bottlenecks(
  data: Data,
  index: RecipeIndex,
  state: GameState,
  force = "player",
): BottleneckReport {
  const f = state.forces[force];
  const legacy = isLegacyFlows(state, force);
  const empty: BottleneckReport = {
    force,
    legacy,
    utilisation: [],
    tightness: [],
    tightnessConsidered: 0,
    minDemandPerMinute: MIN_DEMAND_PER_MINUTE,
    unattributed: [],
    findings: [],
    limits: [],
  };
  if (!f) return empty;
  if (legacy) return empty;

  const census = new Map<string, number>(Object.entries(f.machines));
  const researched = new Set(f.technologies.researched);

  // Every product the base made, items and fluids together. Fluids are half the
  // oil and chemical end of a base and live in their own map; reading only
  // `production.item` once reported a base running 43 refineries as making no
  // crude oil at all.
  const made = new Map<string, { kind: "item" | "fluid"; perMinute: number }>();
  const flows = new Map<string, { kind: "item" | "fluid"; made: number; used: number }>();
  for (const kind of ["item", "fluid"] as const) {
    for (const [name, flow] of Object.entries(f.production[kind])) {
      const r = flowOf(flow);
      flows.set(name, { kind, made: r.producedPerMinute, used: r.consumedPerMinute });
      if (r.producedPerMinute > 0) made.set(name, { kind, perMinute: r.producedPerMinute });
    }
  }

  // ---- Reading 1: machine-class utilisation -------------------------------

  const { runs, makeable } = solveMix(data, index, census, researched, flows);

  const chargedByClass = new Map<string, ChargedRecipe[]>();
  for (const run of runs) {
    if (run.craftsPerMinute <= 0) continue;
    const split = shares(run.pool, census);
    const names = run.pool.map((m) => m.name);
    // Whether the index's default rule would have picked this recipe for any
    // product it makes. A row tagged otherwise is one the mix solve chose and
    // the old reading would have missed, which is exactly the interesting case.
    const isDefault = run.recipe.results.some(
      (x) => index.defaultFor(x.name)?.name === run.recipe.name,
    );

    for (const machine of run.pool) {
      const share = split.get(machine.name) ?? 0;
      if (share <= 0) continue;

      // One machine of this class running this recipe, with the machine's own
      // declared effects and no modules, because a save reports no loadouts.
      const one = runOne(data, run.recipe, machine);
      const craftsPerMachine = one.craftsPerSecond * 60;
      if (craftsPerMachine <= 0) continue;

      chargedByClass.set(machine.name, [
        ...(chargedByClass.get(machine.name) ?? []),
        {
          recipe: run.recipe.name,
          busyEquivalent: (run.craftsPerMinute / craftsPerMachine) * share,
          craftsPerMinute: run.craftsPerMinute,
          pin: run.pin,
          product: run.by,
          producedPerMinute: run.byRate,
          perMachinePerMinute:
            run.byKind === "made"
              ? (one.outputPerSecond.get(run.by) ?? 0) * 60
              : amountIn(run.recipe, run.by) * craftsPerMachine,
          rule: isDefault ? "default" : "census",
          pool: names,
          share,
        },
      ]);
    }
  }

  // What the base made that no machine class accounts for. After the mix solve
  // this is the mining and pumping end plus anything the base cannot make with
  // the machines and the research it has, which is a gap worth naming rather
  // than a number to invent.
  const unattributed: Unattributed[] = [];
  for (const [product, m] of made) {
    if (makeable.has(product)) continue;
    const producers = index.genuineProducersOf(product);
    const best = index.defaultFor(product) ?? producers[0] ?? null;
    unattributed.push({
      product,
      producedPerMinute: m.perMinute,
      recipe: producers.length > 0 ? (best?.name ?? producers[0]!.name) : null,
      couldRun: best ? machinesFor(data, best).map((x) => x.name) : [],
      alsoMadeBy: producers
        .filter((r) => poolFor(data, census, r).length > 0 && runnable(index, researched, r))
        .map((r) => r.name),
      machinePlaced: best ? poolFor(data, census, best).length > 0 : false,
      recipeResearched: best ? runnable(index, researched, best) : false,
      reason: producers.length === 0 || index.isRaw(product) ? "raw" : "not-runnable",
    });
  }

  const utilisation: ClassUtilisation[] = [];
  for (const machine of data.craftingMachines()) {
    const count = census.get(machine.name) ?? 0;
    // A class with nothing placed is left out entirely. Reporting it at zero
    // percent busy would rank machines he does not own above the ones he does.
    if (count <= 0) continue;
    const charged = (chargedByClass.get(machine.name) ?? []).sort(
      (a, b) => b.busyEquivalent - a.busyEquivalent,
    );
    const busyEquivalent = charged.reduce((s, c) => s + c.busyEquivalent, 0);
    utilisation.push({
      machine: machine.name,
      count,
      busyEquivalent,
      fraction: busyEquivalent / count,
      charged,
    });
  }
  utilisation.sort((a, b) => b.fraction - a.fraction || b.count - a.count);

  // ---- Reading 2: item tightness ------------------------------------------

  const ranked: ItemTightness[] = [];
  let considered = 0;
  for (const [name, r] of flows) {
    if (r.used <= 0) continue;
    considered++;
    if (r.used < MIN_DEMAND_PER_MINUTE) continue;
    const spare = r.made - r.used;
    ranked.push({
      name,
      kind: r.kind,
      madePerMinute: r.made,
      usedPerMinute: r.used,
      sparePerMinute: spare,
      headroomRatio: spare / r.used,
    });
  }
  // Order by the size of the hole, describe by the shape of it. A line short by
  // 2.6 items a minute is not holding the factory back however tight its ratio
  // is, so the deficits come first, biggest first. The ratio answers a different
  // question, whether a line is healthy, and stays as a column and in the
  // wording rather than setting the order (Soushi's PM, 2026-09-21).
  ranked.sort((a, b) => {
    const aShort = a.sparePerMinute < 0;
    const bShort = b.sparePerMinute < 0;
    if (aShort !== bShort) return aShort ? -1 : 1;
    if (aShort) return a.sparePerMinute - b.sparePerMinute;
    return a.headroomRatio - b.headroomRatio || b.usedPerMinute - a.usedPerMinute;
  });

  // ---- The sentences ------------------------------------------------------

  const utilisationFindings: Finding[] = [];
  for (const u of utilisation) {
    const pct = `${(u.fraction * 100).toFixed(0)}%`;
    const top = u.charged[0];
    const on = top ? `, mostly on ${top.recipe}` : ", on nothing this reading could attribute";
    if (u.fraction >= BUSY_FRACTION) {
      utilisationFindings.push({
        kind: "utilisation",
        subject: u.machine,
        text:
          `${u.count} ${u.machine} are ${pct} busy, so the class itself is the wall: ` +
          `more of them is what raises output.`,
        because:
          `Their output implies ${u.busyEquivalent.toFixed(1)} machines' worth of crafting ` +
          `against ${u.count} placed${on}.`,
      });
    } else if (u.fraction <= STARVED_FRACTION) {
      utilisationFindings.push({
        kind: "utilisation",
        subject: u.machine,
        text:
          `${u.count} ${u.machine} are only ${pct} busy, so they are waiting on input ` +
          `rather than short of machines: building more changes nothing.`,
        because:
          `Their output implies ${u.busyEquivalent.toFixed(1)} machines' worth of crafting ` +
          `against ${u.count} placed${on}.`,
      });
    }
  }

  // Same order as the table, because the dashboard reads these in order and a
  // page that leads with a different line than the command is a page and a
  // command disagreeing about what matters.
  const tightnessFindings: Finding[] = [];
  for (const t of ranked.slice(0, TIGHTNESS_FINDINGS)) {
    const evidence =
      `${t.madePerMinute.toFixed(1)}/min made against ${t.usedPerMinute.toFixed(1)}/min ` +
      `used, over the last hour.`;
    if (t.sparePerMinute < 0) {
      tightnessFindings.push({
        kind: "tightness",
        subject: t.name,
        text:
          `${t.name} is running ${Math.abs(t.sparePerMinute).toFixed(1)}/min behind its own ` +
          `demand, a shortfall of ${Math.abs(t.headroomRatio * 100).toFixed(1)}% against what ` +
          `the base eats, so it is drawing down what it stored rather than keeping up.`,
        because: evidence,
      });
    } else {
      tightnessFindings.push({
        kind: "tightness",
        subject: t.name,
        text:
          `${t.name} keeps up but leaves ${t.sparePerMinute.toFixed(1)}/min spare, ` +
          `${(t.headroomRatio * 100).toFixed(1)}% of what the base already eats, so nothing ` +
          `new can be built on it without more of the line.`,
        because: evidence,
      });
    }
  }

  // The whole base in one sentence, when the two readings agree on one.
  //
  // It is assembled from them rather than written: which branch fires depends on
  // whether any class reached BUSY_FRACTION and on whether the biggest hole is
  // in something no recipe here makes, so a base short of machines gets the
  // opposite sentence and a base that is neither gets none.
  const atWall = utilisation.filter((u) => u.fraction >= BUSY_FRACTION);
  const busiest = utilisation[0];
  const worst = ranked[0];
  let diagnosis: Finding | null = null;
  if (busiest && atWall.length > 0) {
    const first = atWall[0]!;
    const tight = worst
      ? ` The tightest line is ${worst.name} at ${worst.sparePerMinute.toFixed(1)}/min spare.`
      : "";
    diagnosis = {
      kind: "diagnosis",
      subject: first.machine,
      text:
        `${atWall.map((u) => `${u.count} ${u.machine}`).join(", ")} ` +
        `${atWall.length === 1 ? "is" : "are"} at or above ` +
        `${(BUSY_FRACTION * 100).toFixed(0)}% busy, so the factory is short of machines ` +
        `there rather than short of input: more of them is what raises output.`,
      because:
        `${first.busyEquivalent.toFixed(1)} machines' worth of crafting against ` +
        `${first.count} placed.${tight}`,
    };
  } else if (busiest && worst && worst.sparePerMinute < 0 && !makeable.has(worst.name)) {
    // Floor and add one, so the ceiling stated is always above the measurement
    // rather than equal to it.
    const under = Math.floor(busiest.fraction * 100) + 1;
    diagnosis = {
      kind: "diagnosis",
      subject: worst.name,
      text:
        `Every machine class is under ${under}% busy and ${worst.name} is ` +
        `${Math.abs(worst.sparePerMinute).toFixed(1)}/min behind demand, so the factory is ` +
        `short of ${worst.name} rather than short of machines.`,
      because:
        `Busiest class ${busiest.machine} at ${(busiest.fraction * 100).toFixed(1)}% of ` +
        `${busiest.count} placed; ${worst.name} made ${worst.madePerMinute.toFixed(1)}/min ` +
        `against ${worst.usedPerMinute.toFixed(1)}/min used, and no recipe here makes it.`,
    };
  }

  // A starved base and a saturated one want opposite sentences first: when a
  // class is at the wall the machines are the story, and when none is, the lines
  // are.
  const findings: Finding[] = diagnosis ? [diagnosis] : [];
  findings.push(
    ...(atWall.length > 0
      ? [...utilisationFindings, ...tightnessFindings]
      : [...tightnessFindings, ...utilisationFindings]),
  );

  const limits = [
    "The census counts prototypes, not loadouts. A save read reports no modules, so a class running speed modules reads over 100% busy and one running productivity modules reads busier than its machines really are. Neither is corrected, because nothing in the save says which machine holds what.",
    "A machine's own declared effects ARE applied: the foundry, the electromagnetic plant and the biochamber carry productivity in the prototype itself, and that is a snapshot field rather than a guess.",
    "Which recipes are running is solved from the base's own rates, not chosen by preference: a recipe with a result nothing produced or an ingredient nothing consumed did not run, a product made by only one surviving recipe fixes that recipe, and a fluid eaten by only one fixes it too. Every charge names the measurement that bound it. Where the numbers cannot tell two recipes apart, the leftover goes through the index's default rule and the row says so.",
    "A craft rate is bounded by the recipe's own output and by its fluid inputs, never by an item input. An item's consumption counts fuel burned, entities built and hand-crafting, and over an hour it need not balance at all, because a base short of ore is drawing the difference out of chests.",
    "Rawness is decided here rather than in the recipe index, because it is a property of a base: the index still reports heavy oil and sulfuric acid raw, since Space Age yields both on planets he has not reached, and `ratio` is right to answer that way for a player free to go anywhere. A product counts as raw HERE only when nothing he has placed, with the research he has, makes it.",
    "Where several classes could have run a recipe, the work is split between them by crafting capacity, which is count times crafting speed. A save read says nothing about which machine ran which recipe, so classes sharing a recipe report the same busy fraction. That is the honest answer, not a coincidence: 17 steel furnaces and 513 electric furnaces on one smelting category cannot be told apart from a save.",
    "A recipe whose byproduct nothing produced is dropped whole, so a product made alongside something the base voids is charged to nobody and shows up as a gap rather than as a wrong number.",
    "A product this base both mines and crafts would be over-charged, because production statistics do not say which of the two made a unit and this reading treats a product's whole output as a recipe's when only one recipe could have made it. Nothing on this save is in that position, since every mined product here has no runnable recipe at all, but a base that researches coal synthesis or steam condensation puts coal or water into it. The recipe's fluid inputs still cap the charge, so the error is bounded rather than open-ended, and it is a gap rather than a figure to trust.",
    "A machine placed but unpowered, unfed or idle still counts in the denominator. That is the point: it is what makes a starved class read low.",
    "Mining drills, labs, boilers and turrets are not crafting machines and are charged nothing here. `bun run advise` reports lab utilisation; the mining end shows up in the tightness table as an ore rate.",
    "Both readings are the engine's one-hour rolling averages as of the tick in the header, not what the base is doing right now.",
  ];

  return {
    force,
    legacy,
    utilisation,
    tightness: ranked,
    tightnessConsidered: considered,
    minDemandPerMinute: MIN_DEMAND_PER_MINUTE,
    unattributed: unattributed.sort((a, b) => b.producedPerMinute - a.producedPerMinute),
    findings,
    limits,
  };
}
