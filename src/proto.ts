import { readFileSync } from "node:fs";
import { SNAPSHOT_PATH } from "./paths.ts";
import { readManifest, type Manifest } from "./dump.ts";
import { watts } from "./energy.ts";

/**
 * The choke point. Every other module reads the snapshot through here, the way
 * wesnoth-advisor reads the board through save.ts.
 *
 * Prototype classes are grouped by the fields they carry rather than by a
 * hardcoded list of class names, so a class added by a future version still
 * lands in the right bucket. Which fields mean what is schema, not statistics,
 * and is allowed to live in code; the values behind them never are.
 */

export type Raw = Record<string, unknown>;
export type Klass = Record<string, Raw>;

export interface Proto extends Raw {
  name: string;
  type: string;
}

export interface Effect {
  speed?: number;
  productivity?: number;
  consumption?: number;
  pollution?: number;
  quality?: number;
}

export interface ModuleProto extends Proto {
  tier?: number;
  category?: string;
  effect?: Effect;
  limitation?: string[];
  limitation_blacklist?: string[];
}

export interface CraftingMachine extends Proto {
  crafting_speed: number;
  crafting_categories: string[];
  module_slots?: number;
  allowed_effects?: string[];
  energy_usage?: string;
  energy_source?: Raw;
}

export interface MiningDrill extends Proto {
  mining_speed: number;
  resource_categories: string[];
  module_slots?: number;
  energy_usage?: string;
  energy_source?: Raw;
}

export interface BeaconProto extends Proto {
  distribution_effectivity: number;
  distribution_effectivity_bonus_per_quality_level?: number;
  supply_area_distance?: number;
  module_slots?: number;
  energy_usage?: string;
  /** Space Age: effectivity falls off with the number of beacons in range. */
  profile?: number[];
}

export interface TechProto extends Proto {
  prerequisites?: string[];
  effects?: Array<Raw & { type: string; recipe?: string }>;
  unit?: {
    count?: number;
    count_formula?: string;
    time: number;
    ingredients: Array<[string, number]>;
  };
  hidden?: boolean;
  enabled?: boolean;
  max_level?: number | string;
}

/** Engine default: a recipe with no `energy_required` crafts in 0.5s. */
export const DEFAULT_ENERGY_REQUIRED = 0.5;
/** Engine default: an ingredient or result with no `amount` means one. */
export const DEFAULT_AMOUNT = 1;
/** Engine default: a result with no `probability` always appears. */
export const DEFAULT_PROBABILITY = 1;

export class Data {
  readonly raw: Record<string, Klass>;
  readonly manifest: Manifest | null;

  private byName = new Map<string, Proto[]>();

  constructor(raw: Record<string, Klass>, manifest: Manifest | null) {
    this.raw = raw;
    this.manifest = manifest;
    for (const [klass, entries] of Object.entries(raw)) {
      if (!entries || typeof entries !== "object") continue;
      for (const [name, proto] of Object.entries(entries)) {
        if (!proto || typeof proto !== "object") continue;
        const p = { ...proto, name, type: klass } as Proto;
        const list = this.byName.get(name);
        if (list) list.push(p);
        else this.byName.set(name, [p]);
      }
    }
  }

  static load(): Data {
    let text: string;
    try {
      text = readFileSync(SNAPSHOT_PATH, "utf8");
    } catch {
      throw new Error(
        "No prototype snapshot. Run `bun run sync` first (it launches Factorio headless for about three seconds and writes nothing to your game directories).",
      );
    }
    return new Data(JSON.parse(text) as Record<string, Klass>, readManifest());
  }

  klass(name: string): Klass {
    return this.raw[name] ?? {};
  }

  /** Every prototype carrying this name, across all classes. */
  all(name: string): Proto[] {
    return this.byName.get(name) ?? [];
  }

  /** The first prototype with this name, preferring the given classes. */
  find(name: string, prefer: string[] = []): Proto | null {
    const list = this.byName.get(name);
    if (!list || list.length === 0) return null;
    for (const klass of prefer) {
      const hit = list.find((p) => p.type === klass);
      if (hit) return hit;
    }
    return list[0]!;
  }

  private cache = new Map<string, unknown>();
  private memo<T>(key: string, build: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, build());
    return this.cache.get(key) as T;
  }

  /**
   * Item classes are the ones whose members declare a stack size. That covers
   * item, tool, module, ammo, capsule, gun, armor, and anything a future version
   * adds, without a maintained list.
   */
  itemClasses(): string[] {
    return this.memo("itemClasses", () => {
      const out: string[] = [];
      for (const [klass, entries] of Object.entries(this.raw)) {
        const first = Object.values(entries ?? {})[0];
        if (first && typeof first === "object" && "stack_size" in first) out.push(klass);
      }
      return out;
    });
  }

  /**
   * Prototype classes that place something on the map, which is every class that
   * is not an item class. Grouped by what they carry rather than by a hardcoded
   * list, the same way `itemClasses` is: an entity declares a `collision_box`
   * or a `selection_box`, an item never does.
   */
  entityClasses(): string[] {
    return this.memo("entityClasses", () => {
      const items = new Set(this.itemClasses());
      const out: string[] = [];
      for (const [klass, entries] of Object.entries(this.raw)) {
        if (items.has(klass)) continue;
        const first = Object.values(entries ?? {})[0];
        if (!first || typeof first !== "object") continue;
        if ("collision_box" in first || "selection_box" in first) out.push(klass);
      }
      return out;
    });
  }

  items(): Map<string, Proto> {
    return this.memo("items", () => {
      const m = new Map<string, Proto>();
      for (const klass of this.itemClasses()) {
        for (const [name, proto] of Object.entries(this.klass(klass))) {
          if (!m.has(name)) m.set(name, { ...proto, name, type: klass } as Proto);
        }
      }
      return m;
    });
  }

  item(name: string): Proto | null {
    return this.items().get(name) ?? null;
  }

  fluid(name: string): Proto | null {
    const f = this.klass("fluid")[name];
    return f ? ({ ...f, name, type: "fluid" } as Proto) : null;
  }

  /** True when the name is a known item or fluid. */
  isProduct(name: string): boolean {
    return this.items().has(name) || this.klass("fluid")[name] !== undefined;
  }

  recipes(): Map<string, Proto> {
    return this.memo("recipes", () => {
      const m = new Map<string, Proto>();
      for (const [name, proto] of Object.entries(this.klass("recipe"))) {
        m.set(name, { ...proto, name, type: "recipe" } as Proto);
      }
      return m;
    });
  }

  recipe(name: string): Proto | null {
    return this.recipes().get(name) ?? null;
  }

  /** Classes that craft: they declare both a speed and a set of categories. */
  craftingMachines(): CraftingMachine[] {
    return this.memo("craftingMachines", () => {
      const out: CraftingMachine[] = [];
      for (const [klass, entries] of Object.entries(this.raw)) {
        for (const [name, proto] of Object.entries(entries ?? {})) {
          if (!proto || typeof proto !== "object") continue;
          const cats = (proto as Raw)["crafting_categories"];
          const speed = (proto as Raw)["crafting_speed"];
          // The character and the god controller declare categories with no
          // speed. They craft, but they are not machines you can count.
          if (!Array.isArray(cats) || typeof speed !== "number") continue;
          out.push({ ...proto, name, type: klass } as CraftingMachine);
        }
      }
      return out;
    });
  }

  miningDrills(): MiningDrill[] {
    return this.memo("miningDrills", () => {
      const out: MiningDrill[] = [];
      for (const [name, proto] of Object.entries(this.klass("mining-drill"))) {
        out.push({ ...proto, name, type: "mining-drill" } as MiningDrill);
      }
      return out;
    });
  }

  modules(): ModuleProto[] {
    return this.memo("modules", () =>
      Object.entries(this.klass("module")).map(
        ([name, proto]) => ({ ...proto, name, type: "module" }) as ModuleProto,
      ),
    );
  }

  module(name: string): ModuleProto | null {
    return this.modules().find((m) => m.name === name) ?? null;
  }

  beacons(): BeaconProto[] {
    return this.memo("beacons", () =>
      Object.entries(this.klass("beacon")).map(
        ([name, proto]) => ({ ...proto, name, type: "beacon" }) as BeaconProto,
      ),
    );
  }

  technologies(): Map<string, TechProto> {
    return this.memo("technologies", () => {
      const m = new Map<string, TechProto>();
      for (const [name, proto] of Object.entries(this.klass("technology"))) {
        m.set(name, { ...proto, name, type: "technology" } as TechProto);
      }
      return m;
    });
  }

  technology(name: string): TechProto | null {
    return this.technologies().get(name) ?? null;
  }

  /** Belt classes carry a tiles-per-tick `speed`. */
  belts(): Proto[] {
    return this.memo("belts", () =>
      Object.entries(this.klass("transport-belt")).map(
        ([name, proto]) => ({ ...proto, name, type: "transport-belt" }) as Proto,
      ),
    );
  }

  inserters(): Proto[] {
    return this.memo("inserters", () =>
      Object.entries(this.klass("inserter")).map(
        ([name, proto]) => ({ ...proto, name, type: "inserter" }) as Proto,
      ),
    );
  }

  /** Quality tiers ordered by level, excluding the internal unknown tier. */
  qualities(): Proto[] {
    return this.memo("qualities", () =>
      Object.entries(this.klass("quality"))
        .map(([name, proto]) => ({ ...proto, name, type: "quality" }) as Proto)
        .filter((q) => q.name !== "quality-unknown")
        .sort((a, b) => Number(a["level"] ?? 0) - Number(b["level"] ?? 0)),
    );
  }

  /** Power draw of a machine prototype, in watts. */
  machineWatts(m: Proto): number {
    return watts(m["energy_usage"]);
  }

  /** Pollution per minute at full load, from the energy source. */
  machinePollution(m: Proto): number {
    const src = m["energy_source"];
    if (!src || typeof src !== "object") return 0;
    const em = (src as Raw)["emissions_per_minute"];
    if (!em || typeof em !== "object") return 0;
    const p = (em as Raw)["pollution"];
    return typeof p === "number" ? p : 0;
  }

  /** Substring search across every prototype name, for the `search` command. */
  search(query: string, limit = 40): Proto[] {
    const q = query.toLowerCase();
    const hits: Proto[] = [];
    for (const [name, list] of this.byName) {
      if (!name.toLowerCase().includes(q)) continue;
      for (const p of list) hits.push(p);
      if (hits.length > limit * 4) break;
    }
    hits.sort((a, b) => {
      const ax = a.name.toLowerCase() === q ? 0 : a.name.length;
      const bx = b.name.toLowerCase() === q ? 0 : b.name.length;
      return ax - bx || a.name.localeCompare(b.name);
    });
    return hits.slice(0, limit);
  }
}

let cached: Data | null = null;
export function load(): Data {
  if (!cached) cached = Data.load();
  return cached;
}
