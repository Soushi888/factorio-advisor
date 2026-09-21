import { machinesFor, runOne } from "./machines.ts";
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
  /** The product whose rate set the charge. */
  product: string;
  producedPerMinute: number;
  /** What one machine of this class makes of that product, per minute. */
  perMachinePerMinute: number;
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
  kind: "utilisation" | "tightness";
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

interface Attribution {
  recipe: Recipe;
  pool: CraftingMachine[];
  rule: "default" | "census";
}

/**
 * Which recipe and which class to charge a product's output to.
 *
 * First the index's own default rule, which is the same one `ratio` reports.
 * When the class that rule implies is not in the census, the base is plainly
 * making the product some other way, so the choice falls to the candidates a
 * census class can run, ordered by the same terms the default rule uses that are
 * reachable from outside the index: main product first, then how deep in the
 * tech tree, then ingredient count, then name.
 */
function attribute(
  data: Data,
  index: RecipeIndex,
  census: Map<string, number>,
  researched: Set<string>,
  product: string,
): Attribution | { recipe: Recipe | null } {
  const def = index.defaultFor(product);
  if (!def) return { recipe: null };

  const direct = poolFor(data, census, def);
  if (direct.length > 0 && runnable(index, researched, def)) {
    return { recipe: def, pool: direct, rule: "default" };
  }

  const covered = index
    .productionCandidates(product)
    .filter((r) => runnable(index, researched, r))
    .map((r) => ({ r, m: poolFor(data, census, r) }))
    .filter((x) => x.m.length > 0)
    .sort(
      (a, b) =>
        (a.r.mainProduct === product ? 0 : 1) - (b.r.mainProduct === product ? 0 : 1) ||
        index.techDepth(a.r) - index.techDepth(b.r) ||
        a.r.ingredients.length - b.r.ingredients.length ||
        a.r.name.localeCompare(b.r.name),
    );

  const first = covered[0];
  if (!first) return { recipe: def };
  return { recipe: first.r, pool: first.m, rule: "census" };
}

function isAttributed(x: Attribution | { recipe: Recipe | null }): x is Attribution {
  return "pool" in x;
}

/** One recipe, the classes that could run it, and every product the base reports. */
interface Group {
  recipe: Recipe;
  pool: CraftingMachine[];
  rule: "default" | "census";
  /** product -> made per minute, for the products this recipe yields. */
  products: Map<string, number>;
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

  const groups = new Map<string, Group>();
  const unattributed: Unattributed[] = [];

  for (const [product, m] of made) {
    const a = attribute(data, index, census, researched, product);
    if (!isAttributed(a)) {
      unattributed.push({
        product,
        producedPerMinute: m.perMinute,
        recipe: a.recipe?.name ?? null,
        couldRun: a.recipe ? machinesFor(data, a.recipe).map((x) => x.name) : [],
        alsoMadeBy: a.recipe
          ? []
          : index
              .producersOf(product)
              .filter(
                (r) => poolFor(data, census, r).length > 0 && runnable(index, researched, r),
              )
              .map((r) => r.name),
        machinePlaced: a.recipe ? poolFor(data, census, a.recipe).length > 0 : false,
        recipeResearched: a.recipe ? runnable(index, researched, a.recipe) : false,
        reason: a.recipe ? "not-runnable" : "raw",
      });
      continue;
    }
    const g = groups.get(a.recipe.name) ?? {
      recipe: a.recipe,
      pool: a.pool,
      rule: a.rule,
      products: new Map<string, number>(),
    };
    g.products.set(product, m.perMinute);
    groups.set(a.recipe.name, g);
  }

  const chargedByClass = new Map<string, ChargedRecipe[]>();
  for (const g of groups.values()) {
    const split = shares(g.pool, census);
    const names = g.pool.map((m) => m.name);

    for (const machine of g.pool) {
      const share = split.get(machine.name) ?? 0;
      if (share <= 0) continue;

      // One machine of this class, running this recipe with no modules. The
      // machine's own declared effects are applied because they are prototype
      // fields: a foundry carries +50% productivity in the building itself.
      const run = runOne(data, g.recipe, machine);

      // A craft yields every result at once, so the products of one recipe are
      // not separate work. The binding one is the largest implied machine count,
      // not the sum: summing would charge one refinery craft three times, once
      // per fluid it comes out of.
      let best: ChargedRecipe | null = null;
      for (const [product, perMinute] of g.products) {
        const perMachine = (run.outputPerSecond.get(product) ?? 0) * 60;
        if (perMachine <= 0) continue;
        const busy = (perMinute / perMachine) * share;
        if (!best || busy > best.busyEquivalent) {
          best = {
            recipe: g.recipe.name,
            busyEquivalent: busy,
            product,
            producedPerMinute: perMinute,
            perMachinePerMinute: perMachine,
            rule: g.rule,
            pool: names,
            share,
          };
        }
      }
      if (!best) continue;
      const list = chargedByClass.get(machine.name) ?? [];
      list.push(best);
      chargedByClass.set(machine.name, list);
    }
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
  ranked.sort((a, b) => a.headroomRatio - b.headroomRatio || b.usedPerMinute - a.usedPerMinute);

  // ---- The sentences ------------------------------------------------------

  const findings: Finding[] = [];
  for (const u of utilisation) {
    const pct = `${(u.fraction * 100).toFixed(0)}%`;
    const top = u.charged[0];
    const on = top ? `, mostly on ${top.recipe}` : ", on nothing this reading could attribute";
    if (u.fraction >= BUSY_FRACTION) {
      findings.push({
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
      findings.push({
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

  for (const t of ranked.slice(0, TIGHTNESS_FINDINGS)) {
    const made1 = t.madePerMinute.toFixed(1);
    const used1 = t.usedPerMinute.toFixed(1);
    if (t.sparePerMinute < 0) {
      findings.push({
        kind: "tightness",
        subject: t.name,
        text:
          `${t.name} is running ${Math.abs(t.sparePerMinute).toFixed(1)}/min behind its own ` +
          `demand, so the base is drawing down what it stored rather than keeping up.`,
        because: `${made1}/min made against ${used1}/min used, over the last hour.`,
      });
    } else {
      findings.push({
        kind: "tightness",
        subject: t.name,
        text:
          `${t.name} has ${t.sparePerMinute.toFixed(1)}/min spare, which is ` +
          `${(t.headroomRatio * 100).toFixed(0)}% of what the base already eats: ` +
          `nothing new can be built on it without more of the line.`,
        because: `${made1}/min made against ${used1}/min used, over the last hour.`,
      });
    }
  }

  const limits = [
    "The census counts prototypes, not loadouts. A save read reports no modules, so a class running speed modules reads over 100% busy and one running productivity modules reads busier than its machines really are. Neither is corrected, because nothing in the save says which machine holds what.",
    "A machine's own declared effects ARE applied: the foundry, the electromagnetic plant and the biochamber carry productivity in the prototype itself, and that is a snapshot field rather than a guess.",
    "Work is charged through each product's default recipe, or the best one a class in the census can run when the default needs a machine this base has none of. Where the real line runs a different recipe, the charge is off by whatever the two differ by, so every row names the recipe it charged.",
    "Where several classes could have run a recipe, the work is split between them by crafting capacity, which is count times crafting speed. A save read says nothing about which machine ran which recipe, so classes sharing a recipe report the same busy fraction. That is the honest answer, not a coincidence: 17 steel furnaces and 513 electric furnaces on one smelting category cannot be told apart from a save.",
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
