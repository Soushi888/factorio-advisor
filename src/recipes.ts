import {
  DEFAULT_AMOUNT,
  DEFAULT_ENERGY_REQUIRED,
  DEFAULT_PROBABILITY,
  type Data,
  type Proto,
  type Raw,
} from "./proto.ts";

/**
 * Recipes, normalised. The dump omits any field equal to its engine default, so
 * a recipe like electronic-circuit carries no `energy_required` and its single
 * results entry carries no `probability`. Those four defaults are the only
 * numeric literals in this file, and they are declared in proto.ts.
 */

export interface Stack {
  kind: "item" | "fluid";
  name: string;
  /** Expected amount per craft, averaged over amount_min/max and probability. */
  amount: number;
  /** Present when the result is probabilistic, for reporting. */
  probability?: number;
  /** Productivity does not apply to this result. */
  ignoredByProductivity?: boolean;
}

export interface Recipe {
  name: string;
  category: string;
  /** Seconds at crafting speed 1. */
  time: number;
  ingredients: Stack[];
  results: Stack[];
  /** Unlocked from the start, rather than by a technology. */
  enabled: boolean;
  allowProductivity: boolean;
  mainProduct: string | null;
  proto: Proto;
}

function stack(entry: unknown, fallbackKind: "item" | "fluid" = "item"): Stack | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Raw;
  const name = e["name"];
  if (typeof name !== "string") return null;
  const kind = e["type"] === "fluid" ? "fluid" : e["type"] === "item" ? "item" : fallbackKind;

  let amount: number;
  const amt = e["amount"];
  const min = e["amount_min"];
  const max = e["amount_max"];
  if (typeof amt === "number") {
    amount = amt;
  } else if (typeof min === "number" && typeof max === "number") {
    amount = (min + max) / 2;
  } else {
    amount = DEFAULT_AMOUNT;
  }

  const extra = e["extra_count_fraction"];
  if (typeof extra === "number") amount += extra;

  const prob = typeof e["probability"] === "number" ? e["probability"] : DEFAULT_PROBABILITY;
  amount *= prob;

  const out: Stack = { kind, name, amount };
  if (prob !== DEFAULT_PROBABILITY) out.probability = prob;
  if (e["ignored_by_productivity"] !== undefined) {
    const ig = e["ignored_by_productivity"];
    if (typeof ig === "number" && ig > 0) out.ignoredByProductivity = true;
    if (ig === true) out.ignoredByProductivity = true;
  }
  return out;
}

export function normalise(proto: Proto): Recipe {
  const ingredients: Stack[] = [];
  const rawIngredients = proto["ingredients"];
  if (Array.isArray(rawIngredients)) {
    for (const i of rawIngredients) {
      const s = stack(i);
      if (s) ingredients.push(s);
    }
  }

  const results: Stack[] = [];
  const rawResults = proto["results"];
  if (Array.isArray(rawResults)) {
    for (const r of rawResults) {
      const s = stack(r);
      if (s) results.push(s);
    }
  } else if (typeof proto["result"] === "string") {
    // Pre-2.0 shape, kept so an older dump still parses.
    const count = proto["result_count"];
    results.push({
      kind: "item",
      name: proto["result"],
      amount: typeof count === "number" ? count : DEFAULT_AMOUNT,
    });
  }

  const time = typeof proto["energy_required"] === "number"
    ? proto["energy_required"]
    : DEFAULT_ENERGY_REQUIRED;

  const mp = proto["main_product"];
  const mainProduct = typeof mp === "string" && mp !== ""
    ? mp
    : results.length === 1
      ? results[0]!.name
      : null;

  return {
    name: proto.name,
    category: typeof proto["category"] === "string" ? proto["category"] : "crafting",
    time,
    ingredients,
    results,
    enabled: proto["enabled"] !== false,
    allowProductivity: proto["allow_productivity"] === true,
    mainProduct,
    proto,
  };
}

/**
 * Recipe categories that exist but are never a way to make something.
 *
 * `recycling` is 310 of the 659 recipes in Space Age. A recycler returns 25% of
 * what went in, so every recycling recipe "produces" its ingredients and would
 * otherwise flood the producer index: without this, the solver cheerfully
 * proposes making iron ore by recycling iron ore. `parameters` is the blueprint
 * parameter placeholder set and produces nothing real.
 */
const NON_PRODUCTION_CATEGORIES = new Set(["recycling", "parameters"]);

export class RecipeIndex {
  readonly data: Data;
  readonly all: Map<string, Recipe>;
  /** product name -> recipes that produce it */
  private producers = new Map<string, Recipe[]>();
  /** product name -> recipes that consume it */
  private consumers = new Map<string, Recipe[]>();
  /** Products the world hands you: mined resources and fluids drawn off tiles. */
  readonly rawProducts: Set<string>;

  constructor(data: Data) {
    this.data = data;
    this.rawProducts = collectRawProducts(data);
    this.all = new Map();
    for (const proto of data.recipes().values()) {
      const r = normalise(proto);
      this.all.set(r.name, r);
      for (const res of r.results) {
        if (res.amount <= 0) continue;
        push(this.producers, res.name, r);
      }
      for (const ing of r.ingredients) {
        push(this.consumers, ing.name, r);
      }
    }
  }

  get(name: string): Recipe | null {
    return this.all.get(name) ?? null;
  }

  /** Every recipe that lists this product as an output, recycling included. */
  producersOf(product: string): Recipe[] {
    return this.producers.get(product) ?? [];
  }

  /** True when this recipe is a way to make something, not recycling or a stub. */
  isProduction(r: Recipe): boolean {
    return !NON_PRODUCTION_CATEGORIES.has(r.category);
  }

  /**
   * Recipes that genuinely yield this product, whether or not the snapshot also
   * declares the product raw.
   *
   * `productionCandidates` answers a question about the game: what could make
   * this, for a player free to go anywhere. This answers a narrower one about
   * the product itself: what yields it at all. The two differ on exactly the
   * products Space Age declares raw somewhere the player may never go, heavy oil
   * because Fulgora has an oil ocean and sulfuric acid because Vulcanus has a
   * geyser, and a base making both in buildings on Nauvis needs the second
   * question. Which of them is raw HERE is the caller's to decide, because the
   * census and the researched set are the only things that can answer it and
   * this index holds neither.
   */
  genuineProducersOf(product: string): Recipe[] {
    return this.producersOf(product).filter((r) => this.isProduction(r));
  }

  /** Recipes that genuinely consume this product, recycling excluded. */
  genuineConsumersOf(product: string): Recipe[] {
    return this.consumersOf(product).filter((r) => this.isProduction(r));
  }

  /** The recipes that are a genuine way to make this product. */
  productionCandidates(product: string): Recipe[] {
    if (this.rawProducts.has(product)) return [];
    return this.genuineProducersOf(product);
  }

  isRaw(product: string): boolean {
    return this.rawProducts.has(product) || this.productionCandidates(product).length === 0;
  }

  consumersOf(product: string): Recipe[] {
    return this.consumers.get(product) ?? [];
  }

  /**
   * The recipe this tool uses for a product when the player has not said which.
   *
   * Rule, stated so it can be argued with, in order: a recipe whose main product
   * is the target beats one that makes it as a byproduct; a shallower chain to
   * raw materials beats a deeper one; something available from the start beats
   * something gated behind a planet; fewer ingredients beats more. Callers
   * report the alternatives that lost, so the choice is arguable rather than
   * hidden.
   */
  defaultFor(product: string): Recipe | null {
    const candidates = this.productionCandidates(product);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;

    const scored = candidates.map((r) => ({
      r,
      main: r.mainProduct === product ? 0 : 1,
      depth: this.recipeDepth(r),
      tech: this.techDepth(r),
      ingredients: r.ingredients.length,
      name: r.name,
    }));
    scored.sort(
      (a, b) =>
        a.main - b.main ||
        a.depth - b.depth ||
        a.tech - b.tech ||
        a.ingredients - b.ingredients ||
        a.name.localeCompare(b.name),
    );
    return scored[0]!.r;
  }

  /**
   * How far into the tech tree a recipe sits: the size of the prerequisite
   * closure of the earliest technology that unlocks it, or 0 when it needs no
   * research. This is what separates plain copper cable from casting it out of
   * molten copper, which are the same depth in ingredients but a planet apart in
   * the tree. Without it the tie fell to alphabetical order, which is not a
   * reason to prefer anything.
   */
  private techDepthCache = new Map<string, number>();
  techDepth(r: Recipe): number {
    const hit = this.techDepthCache.get(r.name);
    if (hit !== undefined) return hit;
    const techs = this.unlockedBy(r.name);
    let best = r.enabled && techs.length === 0 ? 0 : Infinity;
    for (const t of techs) {
      const size = this.prereqClosureSize(t);
      if (size < best) best = size;
    }
    if (!Number.isFinite(best)) best = r.enabled ? 0 : Number.MAX_SAFE_INTEGER;
    this.techDepthCache.set(r.name, best);
    return best;
  }

  private prereqCache = new Map<string, number>();
  private prereqClosureSize(techName: string): number {
    const hit = this.prereqCache.get(techName);
    if (hit !== undefined) return hit;
    const techs = this.data.technologies();
    const seen = new Set<string>();
    const stack = [techName];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      const proto = techs.get(t);
      for (const p of proto?.prerequisites ?? []) stack.push(p);
    }
    this.prereqCache.set(techName, seen.size);
    return seen.size;
  }

  /**
   * How many crafting steps separate a product from raw materials, taking the
   * cheapest route. A product caught in a cycle reports Infinity, which pushes
   * every recipe that depends on it to the back of the queue rather than into
   * an endless walk.
   */
  private depthCache = new Map<string, number>();
  private depthVisiting = new Set<string>();

  productDepth(product: string): number {
    const hit = this.depthCache.get(product);
    if (hit !== undefined) return hit;
    if (this.depthVisiting.has(product)) return Infinity;
    if (this.rawProducts.has(product)) {
      this.depthCache.set(product, 0);
      return 0;
    }
    const candidates = this.productionCandidates(product);
    if (candidates.length === 0) {
      this.depthCache.set(product, 0);
      return 0;
    }

    this.depthVisiting.add(product);
    let best = Infinity;
    for (const r of candidates) {
      const d = this.recipeDepth(r);
      if (d < best) best = d;
    }
    this.depthVisiting.delete(product);
    // A product reachable only through a cycle is left uncached, so a later
    // call from outside the cycle can still resolve it.
    if (Number.isFinite(best)) this.depthCache.set(product, best);
    return best;
  }

  private recipeDepth(r: Recipe): number {
    let deepest = 0;
    for (const ing of r.ingredients) {
      const d = this.productDepth(ing.name);
      if (d > deepest) deepest = d;
      if (!Number.isFinite(deepest)) return Infinity;
    }
    return deepest + 1;
  }

  /** The technology that unlocks a recipe, if any. */
  unlockedBy(recipeName: string): string[] {
    const out: string[] = [];
    for (const tech of this.data.technologies().values()) {
      const effects = tech["effects"];
      if (!Array.isArray(effects)) continue;
      for (const e of effects) {
        if (!e || typeof e !== "object") continue;
        const eff = e as Raw;
        if (eff["type"] === "unlock-recipe" && eff["recipe"] === recipeName) {
          out.push(tech.name);
        }
      }
    }
    return out;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * What the world hands you without a recipe: whatever a `resource` prototype
 * yields when mined, and whatever fluid a tile carries for an offshore pump.
 * Both are read from the snapshot, so a new planet's resources arrive on their
 * own rather than needing a list here.
 */
function collectRawProducts(data: Data): Set<string> {
  const out = new Set<string>();

  for (const proto of Object.values(data.klass("resource"))) {
    const minable = (proto as Raw)["minable"];
    if (!minable || typeof minable !== "object") continue;
    const m = minable as Raw;
    if (typeof m["result"] === "string") out.add(m["result"]);
    const results = m["results"];
    if (Array.isArray(results)) {
      for (const r of results) {
        if (r && typeof r === "object" && typeof (r as Raw)["name"] === "string") {
          out.add((r as Raw)["name"] as string);
        }
      }
    }
  }

  for (const proto of Object.values(data.klass("tile"))) {
    const fluid = (proto as Raw)["fluid"];
    if (typeof fluid === "string") out.add(fluid);
  }

  return out;
}
