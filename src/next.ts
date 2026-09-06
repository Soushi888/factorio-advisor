import type { Data, TechProto } from "./proto.ts";
import type { RecipeIndex } from "./recipes.ts";
import type { GameState } from "./state.ts";
import { costOf, researchPath, type TechCost } from "./tech.ts";

/**
 * What to research next, given what a save says has already been researched.
 *
 * Everything here is a set operation between the technology graph in the
 * snapshot and the researched set in `data/state/<save>.json`. Nothing is
 * hardcoded and nothing is inferred: a technology is available exactly when it
 * is not researched and every one of its prerequisites is.
 *
 * The one honest complication is that a save and a snapshot can disagree. A save
 * made on an older version, or with mods, can carry technology names the vanilla
 * snapshot has never heard of. Those are reported rather than dropped, because a
 * silently shorter list would be a wrong answer that looks like a right one.
 */

export interface Candidate {
  tech: TechProto;
  cost: TechCost;
  /** Recipes this technology unlocks, by name. */
  unlocksRecipes: string[];
  /** How many technologies become newly available once this one is done. */
  opens: number;
}

export interface Researchable {
  available: Candidate[];
  /** Researched names in the save that this snapshot does not declare. */
  unknownToSnapshot: string[];
  researchedCount: number;
  totalCount: number;
}

function researchedSetOf(state: GameState, forceName: string): Set<string> {
  const force = state.forces[forceName];
  if (!force) {
    const names = Object.keys(state.forces).join(", ");
    throw new Error(`No force called "${forceName}" in that state file. Forces: ${names}.`);
  }
  return new Set(force.technologies.researched);
}

function recipesUnlockedBy(tech: TechProto): string[] {
  const out: string[] = [];
  for (const e of tech.effects ?? []) {
    if (!e || typeof e !== "object") continue;
    const eff = e as Record<string, unknown>;
    if (eff["type"] === "unlock-recipe" && typeof eff["recipe"] === "string") {
      out.push(eff["recipe"]);
    }
  }
  return out;
}

/** Technologies whose prerequisites are all researched, and which are not. */
export function researchable(
  data: Data,
  state: GameState,
  forceName: string,
): Researchable {
  const researched = researchedSetOf(state, forceName);
  const techs = data.technologies();

  const unknownToSnapshot = [...researched].filter((n) => !techs.has(n)).sort();

  const available: Candidate[] = [];
  for (const tech of techs.values()) {
    if (researched.has(tech.name)) continue;
    const prereqs = tech.prerequisites ?? [];
    if (!prereqs.every((p) => researched.has(p))) continue;
    available.push({
      tech,
      cost: costOf(tech),
      unlocksRecipes: recipesUnlockedBy(tech),
      opens: 0,
    });
  }

  // How many technologies each candidate would newly unblock. A cheap tech that
  // opens six others is usually the better next pick than an expensive dead end,
  // so the number is reported rather than folded into a ranking.
  const availableNames = new Set(available.map((c) => c.tech.name));
  for (const c of available) {
    let opens = 0;
    for (const t of techs.values()) {
      if (researched.has(t.name) || availableNames.has(t.name)) continue;
      const prereqs = t.prerequisites ?? [];
      if (!prereqs.includes(c.tech.name)) continue;
      if (prereqs.every((p) => p === c.tech.name || researched.has(p))) opens += 1;
    }
    c.opens = opens;
  }

  available.sort(
    (a, b) =>
      a.cost.labSeconds - b.cost.labSeconds ||
      b.opens - a.opens ||
      a.tech.name.localeCompare(b.tech.name),
  );

  return {
    available,
    unknownToSnapshot,
    researchedCount: researched.size,
    totalCount: techs.size,
  };
}

export interface PathFromHere {
  target: string;
  /** The prerequisite closure with everything already researched removed. */
  remaining: TechProto[];
  /** True when the target itself is already researched. */
  alreadyDone: boolean;
}

/** The research path from where this save actually is to a target technology. */
export function pathFromHere(
  data: Data,
  state: GameState,
  forceName: string,
  target: string,
): PathFromHere {
  const researched = researchedSetOf(state, forceName);
  const full = researchPath(data, target);
  return {
    target,
    remaining: full.filter((t) => !researched.has(t.name)),
    alreadyDone: researched.has(target),
  };
}

/**
 * Which technology gates an item, from this save's point of view.
 *
 * An item can be unlocked by several technologies through several recipes. The
 * one that matters is whichever leaves the least still to research, so that is
 * what is chosen, and every alternative is returned alongside it rather than
 * hidden.
 */
export interface Gate {
  /** The technology chosen: the one with the shortest remaining path. */
  best: string | null;
  /** Every technology that would unlock the item, with its remaining count. */
  options: Array<{ tech: string; remaining: number; viaRecipe: string }>;
  /** Set when the item needs no research at all. */
  availableFromStart: boolean;
}

export function gateFor(
  data: Data,
  index: RecipeIndex,
  state: GameState,
  forceName: string,
  product: string,
): Gate {
  const recipes = index.productionCandidates(product);
  if (recipes.length === 0) {
    return { best: null, options: [], availableFromStart: true };
  }

  const options: Gate["options"] = [];
  let availableFromStart = false;
  for (const recipe of recipes) {
    const techs = index.unlockedBy(recipe.name);
    if (recipe.enabled && techs.length === 0) {
      availableFromStart = true;
      continue;
    }
    for (const tech of techs) {
      let remaining: number;
      try {
        remaining = pathFromHere(data, state, forceName, tech).remaining.length;
      } catch {
        continue; // A technology the snapshot does not declare.
      }
      options.push({ tech, remaining, viaRecipe: recipe.name });
    }
  }

  options.sort((a, b) => a.remaining - b.remaining || a.tech.localeCompare(b.tech));
  return {
    best: options[0]?.tech ?? null,
    options,
    availableFromStart,
  };
}
