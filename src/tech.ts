import type { Data, Raw, TechProto } from "./proto.ts";

/**
 * The technology tree.
 *
 * A technology's cost is `unit.count` repetitions of `unit.ingredients`, each
 * repetition taking `unit.time` seconds in a lab of speed 1. Infinite
 * technologies carry `count_formula` instead of a count; those are reported as
 * formulas rather than folded into a total, because the level is a live game
 * fact this tool cannot see.
 */

export interface TechCost {
  /** Science pack name -> number of packs. */
  packs: Map<string, number>;
  /** Lab-seconds at speed 1, before lab speed and productivity. */
  labSeconds: number;
  /** Set when the technology is infinite and has no fixed count. */
  formula: string | null;
  /**
   * Set when the technology costs no science at all and is unlocked by doing
   * something instead: crafting an item, mining a resource, reaching orbit.
   */
  trigger: string | null;
}

/** Render a `research_trigger` as the action it asks for. */
function triggerOf(tech: TechProto): string | null {
  const t = tech["research_trigger"];
  if (!t || typeof t !== "object") return null;
  const r = t as Raw;
  const kind = typeof r["type"] === "string" ? r["type"] : "trigger";
  const parts: string[] = [];
  for (const key of ["item", "entity", "fluid", "recipe", "count"]) {
    const v = r[key];
    if (v !== undefined && v !== null && typeof v !== "object") parts.push(String(v));
  }
  return parts.length > 0 ? `${kind}: ${parts.join(" x")}` : kind;
}

export function costOf(tech: TechProto): TechCost {
  const packs = new Map<string, number>();
  const unit = tech.unit;
  if (!unit) return { packs, labSeconds: 0, formula: null, trigger: triggerOf(tech) };

  const formula = typeof unit.count_formula === "string" ? unit.count_formula : null;
  const count = typeof unit.count === "number" ? unit.count : 0;

  for (const ing of unit.ingredients ?? []) {
    if (!Array.isArray(ing)) continue;
    const [name, amount] = ing;
    if (typeof name !== "string") continue;
    const n = typeof amount === "number" ? amount : 1;
    packs.set(name, (packs.get(name) ?? 0) + n * count);
  }
  return { packs, labSeconds: count * (unit.time ?? 0), formula, trigger: triggerOf(tech) };
}

/** Every prerequisite of a technology, in an order you could research them in. */
export function researchPath(data: Data, target: string): TechProto[] {
  const techs = data.technologies();
  const root = techs.get(target);
  if (!root) throw new Error(`Unknown technology: ${target}`);

  const out: TechProto[] = [];
  const state = new Map<string, 0 | 1 | 2>();

  const walk = (name: string): void => {
    if (state.get(name) === 2) return;
    if (state.get(name) === 1) return; // defensive: the vanilla tree is acyclic
    state.set(name, 1);
    const t = techs.get(name);
    if (t) {
      for (const p of t.prerequisites ?? []) walk(p);
      state.set(name, 2);
      out.push(t);
    } else {
      state.set(name, 2);
    }
  };

  walk(target);
  return out;
}

export interface PathTotals {
  packs: Map<string, number>;
  labSeconds: number;
  /** Technologies on the path whose cost is a formula, not a count. */
  infinite: string[];
  /** Technologies unlocked by an action rather than by science. */
  triggered: string[];
}

export function totalCost(path: TechProto[]): PathTotals {
  const packs = new Map<string, number>();
  let labSeconds = 0;
  const infinite: string[] = [];
  const triggered: string[] = [];
  for (const t of path) {
    const c = costOf(t);
    if (c.formula) infinite.push(t.name);
    if (c.trigger && c.packs.size === 0) triggered.push(t.name);
    for (const [k, v] of c.packs) packs.set(k, (packs.get(k) ?? 0) + v);
    labSeconds += c.labSeconds;
  }
  return { packs, labSeconds, infinite, triggered };
}

export interface Unlock {
  kind: string;
  detail: string;
}

export function unlocksOf(tech: TechProto): Unlock[] {
  const out: Unlock[] = [];
  for (const e of tech.effects ?? []) {
    if (!e || typeof e !== "object") continue;
    const eff = e as Raw;
    const kind = typeof eff["type"] === "string" ? eff["type"] : "effect";
    if (kind === "unlock-recipe") {
      out.push({ kind, detail: String(eff["recipe"] ?? "?") });
      continue;
    }
    // Everything else: report the modifier and its magnitude as declared.
    const parts: string[] = [];
    for (const [k, v] of Object.entries(eff)) {
      if (k === "type") continue;
      if (typeof v === "object") continue;
      parts.push(`${k}=${String(v)}`);
    }
    out.push({ kind, detail: parts.join(" ") });
  }
  return out;
}

/** Technologies that directly require this one. */
export function dependents(data: Data, name: string): string[] {
  const out: string[] = [];
  for (const t of data.technologies().values()) {
    if ((t.prerequisites ?? []).includes(name)) out.push(t.name);
  }
  return out.sort();
}

/** The labs that can research a given set of science packs. */
export function labsFor(data: Data, packs: Iterable<string>): string[] {
  const wanted = [...packs];
  const out: string[] = [];
  for (const [name, proto] of Object.entries(data.klass("lab"))) {
    const inputs = (proto as Raw)["inputs"];
    if (!Array.isArray(inputs)) continue;
    if (wanted.every((p) => inputs.includes(p))) out.push(name);
  }
  return out.sort();
}
