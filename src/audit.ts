import { entityModules, type BpEntity, type Blueprint } from "./blueprint.ts";
import { runOne, type MachineRun, type ModuleLoadout } from "./machines.ts";
import type { BeaconProto, CraftingMachine, Data, ModuleProto, Proto } from "./proto.ts";
import { normalise, type RecipeIndex } from "./recipes.ts";
import { beltItemsPerSecond } from "./belts.ts";

/**
 * Blueprint audit.
 *
 * The useful question about a blueprint is not what it contains but where it
 * binds. So the audit resolves every crafting machine's real loadout, including
 * which beacons physically reach it, runs each one, and nets the flows. An item
 * the print both makes and consumes shows its internal balance; a negative net
 * is what the print needs fed in, a positive net is what it exports.
 */

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Footprint in tiles, from the prototype's selection box. */
function footprint(proto: Proto | null, at: { x: number; y: number }): Box {
  let hw = 0.5;
  let hh = 0.5;
  const sel = proto?.["selection_box"];
  if (Array.isArray(sel) && sel.length === 2) {
    const [a, b] = sel as [unknown, unknown];
    if (Array.isArray(a) && Array.isArray(b)) {
      hw = Math.max(Math.abs(Number(a[0])), Math.abs(Number(b[0])));
      hh = Math.max(Math.abs(Number(a[1])), Math.abs(Number(b[1])));
    }
  }
  return { x1: at.x - hw, y1: at.y - hh, x2: at.x + hw, y2: at.y + hh };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

export interface MachineEntry {
  entity: BpEntity;
  machine: CraftingMachine;
  recipeName: string;
  run: MachineRun;
  beaconCount: number;
  modules: ModuleProto[];
}

export interface Flow {
  item: string;
  produced: number;
  consumed: number;
  net: number;
}

export interface Census {
  name: string;
  count: number;
}

export interface AuditResult {
  label: string;
  entityCount: number;
  tileCount: number;
  census: Census[];
  machines: MachineEntry[];
  /** Machines placed with no recipe set. */
  unsetRecipes: Census[];
  beacons: Array<{ entity: BpEntity; beacon: BeaconProto; modules: ModuleProto[] }>;
  moduleCensus: Census[];
  flows: Flow[];
  totalWatts: number;
  totalDrainWatts: number;
  pollutionPerMinute: number;
  /** Belt tiers present in the print, best first. */
  beltsPresent: Array<{ name: string; itemsPerSecond: number; count: number }>;
  /** Entities the snapshot does not know, usually a modded print. */
  unknownEntities: string[];
  /** Modules above normal quality, whose scaling this tool does not apply. */
  qualityModules: Census[];
  footprintTiles: Box | null;
}

export function audit(
  data: Data,
  index: RecipeIndex,
  bp: Blueprint,
  label: string,
): AuditResult {
  const entities = bp.entities ?? [];
  const census = new Map<string, number>();
  const unknownEntities = new Set<string>();

  const craftingByName = new Map<string, CraftingMachine>();
  for (const m of data.craftingMachines()) craftingByName.set(m.name, m);
  const beaconByName = new Map<string, BeaconProto>();
  for (const b of data.beacons()) beaconByName.set(b.name, b);
  const beltByName = new Map<string, Proto>();
  for (const b of data.belts()) beltByName.set(b.name, b);

  // Pass one: census, beacons with their own modules and reach.
  const beacons: Array<{
    entity: BpEntity;
    beacon: BeaconProto;
    modules: ModuleProto[];
    reach: Box;
  }> = [];
  const moduleCensus = new Map<string, number>();
  const qualityModules = new Map<string, number>();

  for (const e of entities) {
    census.set(e.name, (census.get(e.name) ?? 0) + 1);
    const known = data.find(e.name);
    if (!known) unknownEntities.add(e.name);

    for (const m of entityModules(e)) {
      const key = m.quality === "normal" ? m.name : `${m.name} (${m.quality})`;
      moduleCensus.set(key, (moduleCensus.get(key) ?? 0) + m.count);
      // Only count things that are actually modules, not fuel in a locomotive.
      if (m.quality !== "normal" && data.module(m.name)) {
        qualityModules.set(key, (qualityModules.get(key) ?? 0) + m.count);
      }
    }

    const beacon = beaconByName.get(e.name);
    if (beacon) {
      const mods: ModuleProto[] = [];
      for (const use of entityModules(e)) {
        const proto = data.module(use.name);
        if (!proto) continue;
        for (let i = 0; i < use.count; i++) mods.push(proto);
      }
      const box = footprint(beacon, e.position);
      const d = typeof beacon.supply_area_distance === "number"
        ? beacon.supply_area_distance
        : 0;
      beacons.push({
        entity: e,
        beacon,
        modules: mods,
        reach: { x1: box.x1 - d, y1: box.y1 - d, x2: box.x2 + d, y2: box.y2 + d },
      });
    }
  }

  // Pass two: run every crafting machine with its real loadout.
  const machines: MachineEntry[] = [];
  const unsetRecipes = new Map<string, number>();

  for (const e of entities) {
    const machine = craftingByName.get(e.name);
    if (!machine) continue;
    if (typeof e.recipe !== "string" || e.recipe === "") {
      unsetRecipes.set(e.name, (unsetRecipes.get(e.name) ?? 0) + 1);
      continue;
    }
    const recipeProto = data.recipe(e.recipe);
    if (!recipeProto) {
      unknownEntities.add(`recipe:${e.recipe}`);
      continue;
    }
    const recipe = normalise(recipeProto);

    const mods: ModuleProto[] = [];
    for (const use of entityModules(e)) {
      const proto = data.module(use.name);
      if (!proto) continue;
      for (let i = 0; i < use.count; i++) mods.push(proto);
    }

    const box = footprint(machine, e.position);
    const covering = beacons.filter((b) => overlaps(b.reach, box));
    const loadout: ModuleLoadout = {
      modules: mods,
      beacons: covering.map((b) => ({ beacon: b.beacon, modules: b.modules })),
    };

    machines.push({
      entity: e,
      machine,
      recipeName: recipe.name,
      run: runOne(data, recipe, machine, loadout),
      beaconCount: covering.length,
      modules: mods,
    });
  }

  // Net flows.
  const produced = new Map<string, number>();
  const consumed = new Map<string, number>();
  let totalWatts = 0;
  let totalDrainWatts = 0;
  let pollutionPerMinute = 0;

  for (const m of machines) {
    for (const [item, rate] of m.run.outputPerSecond) {
      produced.set(item, (produced.get(item) ?? 0) + rate);
    }
    for (const [item, rate] of m.run.inputPerSecond) {
      consumed.set(item, (consumed.get(item) ?? 0) + rate);
    }
    totalWatts += m.run.activeWatts;
    totalDrainWatts += m.run.drainWatts;
    pollutionPerMinute += m.run.pollutionPerMinute;
  }
  for (const b of beacons) {
    const w = data.machineWatts(b.beacon);
    totalWatts += w;
  }

  const items = new Set([...produced.keys(), ...consumed.keys()]);
  const flows: Flow[] = [...items]
    .map((item) => {
      const p = produced.get(item) ?? 0;
      const c = consumed.get(item) ?? 0;
      return { item, produced: p, consumed: c, net: p - c };
    })
    .sort((a, b) => a.net - b.net || a.item.localeCompare(b.item));

  const beltsPresent = [...census]
    .filter(([name]) => beltByName.has(name))
    .map(([name, count]) => ({
      name,
      itemsPerSecond: beltItemsPerSecond(beltByName.get(name)!),
      count,
    }))
    .sort((a, b) => b.itemsPerSecond - a.itemsPerSecond);

  let bounds: Box | null = null;
  for (const e of entities) {
    const b = footprint(data.find(e.name), e.position);
    bounds = bounds
      ? {
          x1: Math.min(bounds.x1, b.x1),
          y1: Math.min(bounds.y1, b.y1),
          x2: Math.max(bounds.x2, b.x2),
          y2: Math.max(bounds.y2, b.y2),
        }
      : b;
  }

  return {
    label,
    entityCount: entities.length,
    tileCount: bp.tiles?.length ?? 0,
    census: [...census]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    machines,
    unsetRecipes: [...unsetRecipes].map(([name, count]) => ({ name, count })),
    beacons: beacons.map(({ entity, beacon, modules }) => ({ entity, beacon, modules })),
    moduleCensus: [...moduleCensus]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    flows,
    totalWatts,
    totalDrainWatts,
    pollutionPerMinute,
    beltsPresent,
    unknownEntities: [...unknownEntities].sort(),
    qualityModules: [...qualityModules]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    footprintTiles: bounds,
  };
}

/** Group machines by recipe, which is how a person reads a print. */
export function byRecipe(result: AuditResult): Array<{
  recipe: string;
  count: number;
  machine: string;
  outputPerSecond: number;
  product: string;
  beaconed: number;
}> {
  const groups = new Map<string, MachineEntry[]>();
  for (const m of result.machines) {
    const key = `${m.recipeName} ${m.machine.name}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }
  const out: Array<{
    recipe: string;
    count: number;
    machine: string;
    outputPerSecond: number;
    product: string;
    beaconed: number;
  }> = [];
  for (const [key, list] of groups) {
    const [recipe = "", machine = ""] = key.split(" ");
    let product = "";
    let best = 0;
    const totals = new Map<string, number>();
    for (const m of list) {
      for (const [item, rate] of m.run.outputPerSecond) {
        totals.set(item, (totals.get(item) ?? 0) + rate);
      }
    }
    for (const [item, rate] of totals) {
      if (rate > best) {
        best = rate;
        product = item;
      }
    }
    out.push({
      recipe,
      machine,
      count: list.length,
      outputPerSecond: best,
      product,
      beaconed: list.filter((m) => m.beaconCount > 0).length,
    });
  }
  return out.sort((a, b) => b.count - a.count || a.recipe.localeCompare(b.recipe));
}
