import { watts } from "./energy.ts";
import type { BeaconProto, CraftingMachine, Data, Effect, ModuleProto, Raw } from "./proto.ts";
import type { Recipe } from "./recipes.ts";

/**
 * Machines, modules and beacons.
 *
 * Everything numeric here is read from the snapshot except the effect clamps
 * below. Those are engine limits, not prototype fields: they do not appear
 * anywhere in data.raw, so they are declared once, named, and used nowhere else.
 */

/** Engine clamp: speed, consumption and pollution multipliers floor at 20%. */
const MULTIPLIER_FLOOR = 0.2;
/** Engine clamp: productivity bonus caps at +300%. */
const PRODUCTIVITY_CEILING = 3;
/** Engine default: an electric machine with no declared drain idles at usage/30. */
const DEFAULT_DRAIN_FRACTION = 1 / 30;

export interface ModuleLoadout {
  /** Modules socketed into the machine itself. */
  modules: ModuleProto[];
  /** Beacons in range, each with its own modules. */
  beacons: Array<{ beacon: BeaconProto; modules: ModuleProto[] }>;
}

export const EMPTY_LOADOUT: ModuleLoadout = { modules: [], beacons: [] };

export interface EffectTotals {
  speed: number;
  productivity: number;
  consumption: number;
  pollution: number;
  quality: number;
}

/**
 * Sum module effects, then add what the beacons transmit.
 *
 * A beacon transmits each of its modules at `distribution_effectivity`, scaled
 * by `profile[n-1]` where n is the number of beacons reaching the machine. The
 * profile array is the Space Age diminishing-returns curve and is read from the
 * beacon prototype, not assumed.
 */
export function totalEffects(loadout: ModuleLoadout): EffectTotals {
  const t: EffectTotals = {
    speed: 0,
    productivity: 0,
    consumption: 0,
    pollution: 0,
    quality: 0,
  };

  for (const m of loadout.modules) add(t, m.effect, 1);

  const n = loadout.beacons.length;
  for (const { beacon, modules } of loadout.beacons) {
    const profile = beacon.profile;
    let scale = beacon.distribution_effectivity;
    if (Array.isArray(profile) && profile.length > 0) {
      const idx = Math.min(n, profile.length) - 1;
      scale *= profile[idx] ?? profile[profile.length - 1]!;
    }
    for (const m of modules) add(t, m.effect, scale);
  }
  return t;
}

function add(t: EffectTotals, e: Effect | undefined, scale: number): void {
  if (!e) return;
  if (typeof e.speed === "number") t.speed += e.speed * scale;
  if (typeof e.productivity === "number") t.productivity += e.productivity * scale;
  if (typeof e.consumption === "number") t.consumption += e.consumption * scale;
  if (typeof e.pollution === "number") t.pollution += e.pollution * scale;
  if (typeof e.quality === "number") t.quality += e.quality * scale;
}

export interface Multipliers {
  speed: number;
  productivity: number;
  consumption: number;
  pollution: number;
  /** Raw quality bonus, in percentage points, before quality rolls. */
  quality: number;
}

/**
 * A machine's own built-in effects, declared on the prototype.
 *
 * Three Space Age machines carry productivity in the building itself rather than
 * in a module: `electromagnetic-plant`, `foundry` and `biochamber` each declare
 * `effect_receiver.base_effect.productivity = 0.5`. It is a prototype field, so
 * reading it is squarely inside ADR-3, and NOT reading it understated all three
 * by half in every command that priced them (B2, found by the pm asking what a
 * generated row would do in game rather than what it reported).
 */
export function baseEffect(machine?: CraftingMachine | null): EffectTotals {
  const zero: EffectTotals = { speed: 0, productivity: 0, consumption: 0, pollution: 0, quality: 0 };
  if (!machine) return zero;
  const receiver = machine["effect_receiver"];
  if (!receiver || typeof receiver !== "object") return zero;
  const base = (receiver as Raw)["base_effect"];
  if (!base || typeof base !== "object") return zero;
  const b = base as Raw;
  const n = (k: string): number => (typeof b[k] === "number" ? (b[k] as number) : 0);
  return {
    speed: n("speed"),
    productivity: n("productivity"),
    consumption: n("consumption"),
    pollution: n("pollution"),
    quality: n("quality"),
  };
}

export function multipliers(
  loadout: ModuleLoadout,
  recipe?: Recipe,
  machine?: CraftingMachine | null,
): Multipliers {
  const modules = totalEffects(loadout);
  const own = baseEffect(machine);
  const t: EffectTotals = {
    speed: modules.speed + own.speed,
    productivity: modules.productivity + own.productivity,
    consumption: modules.consumption + own.consumption,
    pollution: modules.pollution + own.pollution,
    quality: modules.quality + own.quality,
  };
  // A recipe that forbids productivity ignores every productivity effect.
  const prodAllowed = recipe ? recipe.allowProductivity : true;
  return {
    speed: Math.max(MULTIPLIER_FLOOR, 1 + t.speed),
    productivity: prodAllowed
      ? 1 + Math.min(PRODUCTIVITY_CEILING, Math.max(0, t.productivity))
      : 1,
    consumption: Math.max(MULTIPLIER_FLOOR, 1 + t.consumption),
    pollution: Math.max(MULTIPLIER_FLOOR, 1 + t.pollution),
    quality: Math.max(0, t.quality),
  };
}

/** Machines whose crafting categories include the recipe's category. */
export function machinesFor(data: Data, recipe: Recipe): CraftingMachine[] {
  return data
    .craftingMachines()
    .filter((m) => m.crafting_categories.includes(recipe.category))
    .sort((a, b) => a.crafting_speed - b.crafting_speed || a.name.localeCompare(b.name));
}

/** The fastest machine that can run this recipe, which is the sensible default. */
export function bestMachineFor(data: Data, recipe: Recipe): CraftingMachine | null {
  const list = machinesFor(data, recipe);
  if (list.length === 0) return null;
  // Prefer a real building over the player character, which also "crafts".
  const buildings = list.filter((m) => m.type !== "character");
  const pool = buildings.length > 0 ? buildings : list;
  return pool[pool.length - 1] ?? null;
}

export interface MachineRun {
  machine: CraftingMachine;
  recipe: Recipe;
  mult: Multipliers;
  /** Completed crafts per second in one machine. */
  craftsPerSecond: number;
  /** Product name -> units per second out of one machine. */
  outputPerSecond: Map<string, number>;
  /** Ingredient name -> units per second into one machine. */
  inputPerSecond: Map<string, number>;
  /** Active draw in watts, excluding idle drain. */
  activeWatts: number;
  /** Idle drain in watts. */
  drainWatts: number;
  /** Pollution per minute at full load. */
  pollutionPerMinute: number;
}

export function runOne(
  data: Data,
  recipe: Recipe,
  machine: CraftingMachine,
  loadout: ModuleLoadout = EMPTY_LOADOUT,
): MachineRun {
  const mult = multipliers(loadout, recipe, machine);
  const craftsPerSecond = (machine.crafting_speed * mult.speed) / recipe.time;

  const outputPerSecond = new Map<string, number>();
  for (const r of recipe.results) {
    const factor = r.ignoredByProductivity ? 1 : mult.productivity;
    outputPerSecond.set(
      r.name,
      (outputPerSecond.get(r.name) ?? 0) + r.amount * factor * craftsPerSecond,
    );
  }

  const inputPerSecond = new Map<string, number>();
  for (const i of recipe.ingredients) {
    inputPerSecond.set(i.name, (inputPerSecond.get(i.name) ?? 0) + i.amount * craftsPerSecond);
  }

  const usage = watts(machine.energy_usage);
  const src = machine.energy_source as Record<string, unknown> | undefined;
  const declaredDrain = src ? watts(src["drain"]) : 0;
  const drainWatts = declaredDrain > 0 ? declaredDrain : usage * DEFAULT_DRAIN_FRACTION;

  return {
    machine,
    recipe,
    mult,
    craftsPerSecond,
    outputPerSecond,
    inputPerSecond,
    activeWatts: usage * mult.consumption,
    drainWatts,
    pollutionPerMinute: data.machinePollution(machine) * mult.consumption * mult.pollution,
  };
}

/** Parse `--modules=speed-module-3x2,productivity-module-3` into prototypes. */
export function parseModules(data: Data, spec: string | undefined): ModuleProto[] {
  if (!spec) return [];
  const out: ModuleProto[] = [];
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const m = /^(.*?)(?:x(\d+))?$/.exec(trimmed);
    const name = (m?.[1] ?? trimmed).trim();
    const count = m?.[2] ? Number(m[2]) : 1;
    const proto = data.module(name);
    if (!proto) throw new Error(`Unknown module: ${name}`);
    for (let i = 0; i < count; i++) out.push(proto);
  }
  return out;
}

/** Trim a module list to what the machine can physically hold and accept. */
export function fitModules(
  machine: CraftingMachine,
  modules: ModuleProto[],
): { fitted: ModuleProto[]; rejected: string[] } {
  const slots = typeof machine.module_slots === "number" ? machine.module_slots : 0;
  const allowed = machine.allowed_effects;
  const rejected: string[] = [];
  const legal: ModuleProto[] = [];

  for (const m of modules) {
    if (Array.isArray(allowed) && m.effect) {
      const used = Object.entries(m.effect)
        .filter(([, v]) => typeof v === "number" && v !== 0)
        .map(([k]) => k);
      const bad = used.filter((k) => !allowed.includes(k));
      if (bad.length > 0) {
        rejected.push(`${m.name} (${machine.name} does not accept ${bad.join(", ")})`);
        continue;
      }
    }
    legal.push(m);
  }

  const fitted = legal.slice(0, slots);
  for (const m of legal.slice(slots)) {
    rejected.push(`${m.name} (${machine.name} has ${slots} module slots)`);
  }
  return { fitted, rejected };
}
