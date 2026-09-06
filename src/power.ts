import { watts, joules } from "./energy.ts";
import type { Data, Raw } from "./proto.ts";
import type { GameState, SurfaceDay } from "./state.ts";

/**
 * Power, from the machine census a save reports.
 *
 * Every figure here is derived from declared prototype fields. Two of them were
 * cross-checked against the engine's own runtime values before this was written,
 * because a wattage nobody can reproduce is worse than no wattage:
 *
 *   - `steam-engine.max_power_output` is 15000 J per tick at runtime, which is
 *     900 kW, and the same number falls out of the declared fields as
 *     `fluid_usage_per_tick 0.5 * 60 * (maximum_temperature 165 - steam
 *     default_temperature 15) * heat_capacity 0.2kJ * effectivity 1`.
 *   - `assembling-machine-2.energy_usage` is 2500 J per tick, which is the
 *     150 kW the prototype string declares.
 *
 * So the snapshot alone is enough, and the runtime agrees with it.
 */

/** Ticks per second. An engine constant, absent from the dump. */
const TICKS_PER_SECOND = 60;

export interface GenerationRow {
  name: string;
  count: number;
  /** Watts per unit at full output. */
  each: number;
  total: number;
  /** How the number was obtained, printed so a reader can redo it. */
  derivation: string;
}

export interface ConsumptionRow {
  name: string;
  count: number;
  /** Watts per unit while running, excluding drain. */
  each: number;
  drainEach: number;
  total: number;
}

export interface SteamChain {
  /** The generator prototype name, so the caller can price the shortfall. */
  name: string;
  boilers: number;
  engines: number;
  /** Steam units per second one boiler emits. */
  steamPerBoiler: number;
  /** Steam units per second one engine consumes. */
  steamPerEngine: number;
  /** Engines one boiler can feed. */
  ratio: number;
  /** Engines the boilers present can actually feed. */
  enginesFed: number;
  boilerFuelDraw: number;
  derivation: string;
}

export interface SolarReport {
  count: number;
  peakEach: number;
  peakTotal: number;
  /** Null when the day curve is not in the state file. */
  averageFactor: number | null;
  averageTotal: number | null;
  cycleTicks: number | null;
  curve: SurfaceDay | null;
}

export interface PowerReport {
  generation: GenerationRow[];
  generationTotal: number;
  consumption: ConsumptionRow[];
  consumptionTotal: number;
  drainTotal: number;
  solar: SolarReport | null;
  steam: SteamChain | null;
  accumulators: { count: number; capacity: number; outputLimit: number } | null;
  /** Census entries whose prototype this snapshot does not declare. */
  unknown: string[];
}

/** Find an entity prototype by name, skipping the item class of the same name. */
function entityProto(data: Data, name: string): { cls: string; proto: Raw } | null {
  for (const cls of data.entityClasses()) {
    const proto = data.klass(cls)[name];
    if (proto && typeof proto === "object") return { cls, proto: proto as Raw };
  }
  return null;
}

/**
 * Energy carried by one unit of a generator's fluid at its working temperature.
 *
 * `(maximum_temperature - fluid.default_temperature) * fluid.heat_capacity`.
 * Confirmed against the engine: for steam at 165 this is 30 kJ, and an engine
 * burning 30 units a second at 30 kJ each is exactly the 900 kW the runtime
 * reports.
 */
function energyPerFluidUnit(data: Data, fluidName: string, maxTemp: number): number | null {
  const fluid = data.klass("fluid")[fluidName] as Raw | undefined;
  if (!fluid) return null;
  const hc = joules(fluid["heat_capacity"]);
  const base = typeof fluid["default_temperature"] === "number" ? fluid["default_temperature"] : 0;
  if (!hc) return null;
  return (maxTemp - base) * hc;
}

function generatorOutput(data: Data, proto: Raw): { w: number; derivation: string } | null {
  const perTick = proto["fluid_usage_per_tick"];
  const maxTemp = proto["maximum_temperature"];
  if (typeof perTick !== "number" || typeof maxTemp !== "number") return null;
  const box = proto["fluid_box"] as Raw | undefined;
  const fluidName = typeof box?.["filter"] === "string" ? box["filter"] : "steam";
  const perUnit = energyPerFluidUnit(data, fluidName, maxTemp);
  if (perUnit === null) return null;
  const eff = typeof proto["effectivity"] === "number" ? proto["effectivity"] : 1;
  const w = perTick * TICKS_PER_SECOND * perUnit * eff;
  return {
    w,
    derivation:
      `${perTick}/tick x ${TICKS_PER_SECOND} x (${maxTemp} - default) x ${fluidName} heat_capacity x eff ${eff}`,
  };
}

/**
 * The average of the solar curve over one full cycle.
 *
 * Factorio's daytime runs 0 to 1. It is fully light from `dawn` round through 0
 * to `dusk`, fully dark between `evening` and `morning`, and ramps linearly
 * across the two remaining stretches, so those average a half. Every number in
 * that sentence is read from the surface, not assumed: on Nauvis the curve is
 * dusk 0.25, evening 0.45, morning 0.55, dawn 0.75, which gives 0.7.
 */
export function solarAverageFactor(day: SurfaceDay): number {
  const { dusk, evening, morning, dawn } = day;
  const light = 1 - (dawn - dusk); // the lit stretch, wrapping through 0
  const dark = morning - evening;
  const ramp = dawn - dusk - dark; // the two ramps together
  return light * 1 + dark * 0 + ramp * 0.5;
}

export function powerReport(
  data: Data,
  state: GameState,
  forceName: string,
): PowerReport {
  const force = state.forces[forceName];
  if (!force) {
    const names = Object.keys(state.forces).join(", ");
    throw new Error(`No force called "${forceName}" in that state file. Forces: ${names}.`);
  }

  const generation: GenerationRow[] = [];
  const consumption: ConsumptionRow[] = [];
  const unknown: string[] = [];
  let solar: SolarReport | null = null;
  let accumulators: PowerReport["accumulators"] = null;
  let boilerCount = 0;
  let boilerProto: Raw | null = null;
  let engineCount = 0;
  let engineProto: Raw | null = null;
  let engineName = "";

  for (const [name, count] of Object.entries(force.machines)) {
    const found = entityProto(data, name);
    if (!found) {
      unknown.push(name);
      continue;
    }
    const { cls, proto } = found;

    if (cls === "solar-panel") {
      const each = watts(proto["production"]);
      const day = state.save.day ?? null;
      const factor = day ? solarAverageFactor(day) : null;
      solar = {
        count,
        peakEach: each,
        peakTotal: each * count,
        averageFactor: factor,
        averageTotal: factor === null ? null : each * count * factor,
        cycleTicks: day?.ticksPerDay ?? null,
        curve: day,
      };
      generation.push({
        name,
        count,
        each,
        total: each * count,
        derivation: `production ${String(proto["production"])} each, at peak`,
      });
      continue;
    }

    if (cls === "generator") {
      engineCount = count;
      engineProto = proto;
      engineName = name;
      const out = generatorOutput(data, proto);
      if (!out) {
        unknown.push(name);
        continue;
      }
      generation.push({
        name,
        count,
        each: out.w,
        total: out.w * count,
        derivation: out.derivation,
      });
      continue;
    }

    if (cls === "reactor") {
      const each = watts(proto["consumption"]);
      generation.push({
        name,
        count,
        each,
        total: each * count,
        derivation: `consumption ${String(proto["consumption"])} of heat, before neighbour bonus`,
      });
      continue;
    }

    if (cls === "accumulator") {
      const es = proto["energy_source"] as Raw | undefined;
      accumulators = {
        count,
        capacity: joules(es?.["buffer_capacity"]),
        outputLimit: watts(es?.["output_flow_limit"]),
      };
      continue;
    }

    if (cls === "boiler") {
      boilerCount = count;
      boilerProto = proto;
      continue; // Heat, not electricity. Reported in the steam chain instead.
    }

    // Everything else: an electric consumer, if it declares one.
    const es = proto["energy_source"] as Raw | undefined;
    if (es?.["type"] !== "electric") continue;
    const each = watts(proto["energy_usage"]);
    if (each === 0) continue;
    // `drain` defaults to a thirtieth of usage when the prototype omits it, the
    // same declared constant `machines.ts` already uses.
    const drainEach = es["drain"] !== undefined ? watts(es["drain"]) : each / 30;
    consumption.push({
      name,
      count,
      each,
      drainEach,
      total: (each + drainEach) * count,
    });
  }

  let steam: SteamChain | null = null;
  if (boilerProto && engineProto && boilerCount > 0 && engineCount > 0) {
    const targetTemp = boilerProto["target_temperature"];
    const outBox = boilerProto["output_fluid_box"] as Raw | undefined;
    const outFluid = typeof outBox?.["filter"] === "string" ? outBox["filter"] : "steam";
    const perUnit =
      typeof targetTemp === "number" ? energyPerFluidUnit(data, outFluid, targetTemp) : null;
    const fuelDraw = watts(boilerProto["energy_consumption"]);
    const enginePerTick = engineProto["fluid_usage_per_tick"];
    if (perUnit && perUnit > 0 && typeof enginePerTick === "number") {
      const steamPerBoiler = fuelDraw / perUnit;
      const steamPerEngine = enginePerTick * TICKS_PER_SECOND;
      const ratio = steamPerBoiler / steamPerEngine;
      steam = {
        name: engineName,
        boilers: boilerCount,
        engines: engineCount,
        steamPerBoiler,
        steamPerEngine,
        ratio,
        enginesFed: boilerCount * ratio,
        boilerFuelDraw: fuelDraw * boilerCount,
        derivation:
          `boiler ${String(boilerProto["energy_consumption"])} / ((${targetTemp} - default) x ` +
          `${outFluid} heat_capacity) = ${steamPerBoiler}/s of ${outFluid}; ` +
          `engine ${enginePerTick}/tick x ${TICKS_PER_SECOND} = ${steamPerEngine}/s`,
      };
    }
  }

  generation.sort((a, b) => b.total - a.total);
  consumption.sort((a, b) => b.total - a.total);

  return {
    generation,
    generationTotal: generation.reduce((n, r) => n + r.total, 0),
    consumption,
    consumptionTotal: consumption.reduce((n, r) => n + r.total, 0),
    drainTotal: consumption.reduce((n, r) => n + r.drainEach * r.count, 0),
    solar,
    steam,
    accumulators,
    unknown: unknown.sort(),
  };
}
