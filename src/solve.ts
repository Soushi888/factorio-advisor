import type { CraftingMachine, Data } from "./proto.ts";
import type { Recipe } from "./recipes.ts";
import type { RecipeIndex } from "./recipes.ts";
import {
  EMPTY_LOADOUT,
  bestMachineFor,
  fitModules,
  runOne,
  type MachineRun,
  type ModuleLoadout,
} from "./machines.ts";

/**
 * Production chain solving.
 *
 * Depth first over the recipe graph to choose recipes, then a reverse
 * topological pass to size them. The second pass is what lets a byproduct
 * (light oil out of advanced oil processing) cancel demand for the same product
 * further down, instead of quietly building a second production line for it.
 *
 * Two things the solver refuses to fake: a cycle is reported rather than
 * unrolled, and a product with several recipes reports the ones it declined.
 */

export interface SolveOptions {
  /** product name -> recipe name, overriding the default choice. */
  recipeFor?: Map<string, string>;
  /** recipe category or machine name -> machine to use. */
  machine?: string;
  loadout?: ModuleLoadout;
  /** Products to treat as bought in, stopping expansion there. */
  raw?: Set<string>;
}

export interface Step {
  product: string;
  recipe: Recipe;
  machine: CraftingMachine | null;
  /** Required output of `product`, units per second. */
  ratePerSecond: number;
  /** Total crafts per second across every machine in this step. */
  craftsPerSecond: number;
  machineCount: number;
  /** Per-machine figures, null when nothing can run this category. */
  run: MachineRun | null;
  rejectedModules: string[];
  depth: number;
}

export interface Choice {
  product: string;
  chosen: string;
  alternatives: string[];
}

export interface Solution {
  target: string;
  ratePerSecond: number;
  steps: Step[];
  /** Inputs the chain does not make: ores, crude oil, water. */
  raw: Map<string, number>;
  /** Overproduction the chain does not consume. */
  surplus: Map<string, number>;
  totalWatts: number;
  totalDrainWatts: number;
  pollutionPerMinute: number;
  totalMachines: number;
  cycles: string[][];
  choices: Choice[];
  /** Products with no recipe that are not plausibly raw. */
  unresolved: string[];
}

interface Node {
  product: string;
  recipe: Recipe;
  deps: string[];
}

export function solve(
  data: Data,
  index: RecipeIndex,
  target: string,
  ratePerSecond: number,
  opts: SolveOptions = {},
): Solution {
  const stopAt = opts.raw ?? new Set<string>();
  const chosen = new Map<string, Node>();
  const cycles: string[][] = [];
  const choices: Choice[] = [];
  const raws = new Set<string>();
  const depth = new Map<string, number>();

  const pickRecipe = (product: string): Recipe | null => {
    const override = opts.recipeFor?.get(product);
    if (override) {
      const r = index.get(override);
      if (!r) throw new Error(`Unknown recipe: ${override}`);
      if (!r.results.some((x) => x.name === product)) {
        throw new Error(`Recipe ${override} does not produce ${product}`);
      }
      return r;
    }
    return index.defaultFor(product);
  };

  // Pass one: choose a recipe per product, cutting cycles.
  const onStack: string[] = [];
  const inStack = new Set<string>();

  const visit = (product: string, d: number): void => {
    depth.set(product, Math.max(depth.get(product) ?? 0, d));
    if (stopAt.has(product)) {
      raws.add(product);
      return;
    }
    if (inStack.has(product)) {
      const start = onStack.indexOf(product);
      cycles.push([...onStack.slice(start), product]);
      raws.add(product);
      return;
    }
    if (chosen.has(product) || raws.has(product)) return;
    // Mined ore, pumped water and anything nothing can make: the chain stops.
    if (index.isRaw(product) && !opts.recipeFor?.has(product)) {
      raws.add(product);
      return;
    }

    const recipe = pickRecipe(product);
    if (!recipe) {
      raws.add(product);
      return;
    }

    const alternatives = index
      .productionCandidates(product)
      .map((r) => r.name)
      .filter((n) => n !== recipe.name);
    if (alternatives.length > 0) {
      choices.push({ product, chosen: recipe.name, alternatives });
    }

    onStack.push(product);
    inStack.add(product);
    const deps = recipe.ingredients.map((i) => i.name);
    chosen.set(product, { product, recipe, deps });
    for (const dep of deps) visit(dep, d + 1);
    onStack.pop();
    inStack.delete(product);
  };

  visit(target, 0);

  // Pass two: reverse topological order, so a product is sized only after every
  // consumer of it has registered its demand.
  const order = topoOrder(target, chosen);

  const demand = new Map<string, number>([[target, ratePerSecond]]);
  const surplus = new Map<string, number>();
  const rawTotals = new Map<string, number>();
  const steps: Step[] = [];

  for (const product of order) {
    const node = chosen.get(product);
    const wanted = (demand.get(product) ?? 0) - (surplus.get(product) ?? 0);
    if (!node) {
      if (wanted > 0) rawTotals.set(product, (rawTotals.get(product) ?? 0) + wanted);
      if (wanted > 0) surplus.delete(product);
      else if (wanted < 0) surplus.set(product, -wanted);
      continue;
    }
    if (wanted <= 1e-12) {
      // Fully covered by byproducts already. Keep the leftover visible.
      surplus.set(product, -wanted);
      continue;
    }
    surplus.delete(product);

    const recipe = node.recipe;
    const machine = resolveMachine(data, recipe, opts.machine);
    const loadout = opts.loadout ?? EMPTY_LOADOUT;

    let run: MachineRun | null = null;
    let rejected: string[] = [];
    if (machine) {
      const { fitted, rejected: rej } = fitModules(machine, loadout.modules);
      rejected = rej;
      run = runOne(data, recipe, machine, { modules: fitted, beacons: loadout.beacons });
    }

    // Productivity applies to the recipe, so crafts needed shrink with it.
    const prod = run ? run.mult.productivity : 1;
    const perCraft = recipe.results
      .filter((r) => r.name === product)
      .reduce((s, r) => s + r.amount * (r.ignoredByProductivity ? 1 : prod), 0);
    if (perCraft <= 0) continue;

    const craftsPerSecond = wanted / perCraft;
    const machineCount = run && run.craftsPerSecond > 0
      ? craftsPerSecond / run.craftsPerSecond
      : 0;

    for (const ing of recipe.ingredients) {
      demand.set(ing.name, (demand.get(ing.name) ?? 0) + ing.amount * craftsPerSecond);
    }
    for (const res of recipe.results) {
      if (res.name === product) continue;
      const factor = res.ignoredByProductivity ? 1 : prod;
      const made = res.amount * factor * craftsPerSecond;
      surplus.set(res.name, (surplus.get(res.name) ?? 0) + made);
    }

    steps.push({
      product,
      recipe,
      machine,
      ratePerSecond: wanted,
      craftsPerSecond,
      machineCount,
      run,
      rejectedModules: rejected,
      depth: depth.get(product) ?? 0,
    });
  }

  let totalWatts = 0;
  let totalDrainWatts = 0;
  let pollutionPerMinute = 0;
  let totalMachines = 0;
  for (const s of steps) {
    if (!s.run) continue;
    const whole = Math.ceil(s.machineCount - 1e-9);
    totalMachines += whole;
    // Active draw scales with utilisation; the idle drain does not.
    totalWatts += s.run.activeWatts * s.machineCount;
    totalDrainWatts += s.run.drainWatts * whole;
    pollutionPerMinute += s.run.pollutionPerMinute * s.machineCount;
  }

  const unresolved: string[] = [];
  for (const name of rawTotals.keys()) {
    if (!data.isProduct(name)) unresolved.push(name);
  }

  // Drop surpluses that were fully consumed.
  for (const [k, v] of [...surplus]) {
    if (v <= 1e-9) surplus.delete(k);
  }

  return {
    target,
    ratePerSecond,
    steps,
    raw: rawTotals,
    surplus,
    totalWatts,
    totalDrainWatts,
    pollutionPerMinute,
    totalMachines,
    cycles,
    choices,
    unresolved,
  };
}

/** Consumers before producers, so demand is complete before a step is sized. */
function topoOrder(target: string, chosen: Map<string, Node>): string[] {
  const out: string[] = [];
  const state = new Map<string, 0 | 1 | 2>();

  const walk = (product: string): void => {
    const s = state.get(product);
    if (s === 2) return;
    if (s === 1) return; // cycle already recorded in pass one
    state.set(product, 1);
    const node = chosen.get(product);
    if (node) {
      for (const dep of node.deps) walk(dep);
    }
    state.set(product, 2);
    out.push(product);
  };

  walk(target);
  // Post-order puts dependencies first; reverse it so consumers come first.
  return out.reverse();
}

function resolveMachine(
  data: Data,
  recipe: Recipe,
  preferred: string | undefined,
): CraftingMachine | null {
  if (preferred) {
    const named = data
      .craftingMachines()
      .find((m) => m.name === preferred && m.crafting_categories.includes(recipe.category));
    if (named) return named;
    // A named machine that cannot run this category falls back to the best one,
    // which is how a mixed chain (smelting plus assembly) stays solvable.
  }
  return bestMachineFor(data, recipe);
}

/** Accept "45", "45/s", "90/m", "5400/h". Returns units per second. */
export function parseRate(spec: string): number {
  const m = /^\s*([\d.]+)\s*(?:\/\s*([smh]))?\s*$/i.exec(spec);
  if (!m) throw new Error(`Cannot read rate: ${spec}. Try 45, 90/m or 5400/h.`);
  const n = Number(m[1]);
  if (!Number.isFinite(n)) throw new Error(`Cannot read rate: ${spec}`);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "s") return n;
  if (unit === "m") return n / 60;
  return n / 3600;
}
