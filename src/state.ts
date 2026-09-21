import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR, RUNTIME_DIR, findBinary, findCore, findUserdata } from "./paths.ts";
import { readManifest, writeRuntimeConfig, type Manifest } from "./dump.ts";

/**
 * Tier C: live game state, read from a COPY of a save.
 *
 * The save format is version-locked binary, so nothing outside the engine parses
 * it. The engine, however, will happily load a save and tick it with no player
 * connected, and a save carries its own `control.lua`. So we copy the save into
 * this project, append a collector to the copy's script, and run the binary in
 * benchmark mode against the copy.
 *
 * Three properties make this keep the read-only promise the rest of the tool has:
 *
 *   - The player's save is copied, never opened in place, and never written back.
 *   - `--config` redirects write-data into `.factorio-runtime/`, so the collector's
 *     output lands inside this project rather than in `~/.factorio/script-output`.
 *   - `--benchmark` carries no multiplayer state, so nothing asks for credentials
 *     and nothing is written to the user directory. `--start-server` would also
 *     tick the game, but it wants server state we have no reason to create.
 *
 * Verified 2026-09-05 against `game 4.zip`: the script ran, the file was written,
 * and `find` over both `~/.factorio` and the Steam install returned nothing newer
 * than the run.
 */

/** Ticks to run. The collector fires on the first one; the rest is slack. */
const BENCHMARK_TICKS = 60;
/** Factorio ticks per second. An engine constant, absent from the dump. */
const TICKS_PER_SECOND = 60;

/**
 * The day-night curve of a surface, read from the game rather than assumed.
 *
 * `daytime` runs 0 to 1. The surface is fully lit from `dawn` round through 0 to
 * `dusk`, fully dark between `evening` and `morning`, and ramps between. These
 * are runtime surface properties, not prototype fields, which is why they are
 * collected here: without them the average solar output over a cycle would be a
 * number this tool has no source for.
 */
export interface SurfaceDay {
  surface: string;
  ticksPerDay: number;
  solarPowerMultiplier: number;
  dusk: number;
  evening: number;
  morning: number;
  dawn: number;
}

/** Energy figures the engine resolved, per prototype. Ticks, not watts. */
export interface ResolvedEnergy {
  electric?: boolean;
  usagePerTick?: number;
  maxUsagePerTick?: number;
  outputPerTick?: number;
  drainPerTick?: number;
  buffer?: number;
  outputFlowLimit?: number;
  /** Per-event costs, in joules. Not a continuous draw. */
  perMovement?: number;
  perShot?: number;
  perSector?: number;
}

/** What the grid actually did, as opposed to what it could do. */
export interface ElectricState {
  networks: number;
  /** Watts produced over the last hour, by source prototype. */
  production: Record<string, number>;
  /** Watts consumed over the last hour, by consumer prototype. */
  consumption: Record<string, number>;
}

export interface ResearchState {
  labSpeedModifier: number;
  labProductivityBonus: number;
  /** 0 to 1 through the current technology, or null when nothing is queued. */
  progress: number | null;
}

export interface SurfaceState {
  surface: string;
  evolution: number | null;
  pollution: number | null;
}

/**
 * One item's or fluid's flow, as the engine's own statistics report it.
 *
 * The two cumulative fields are the engine's `input_counts` and `output_counts`
 * for item and fluid production statistics, and on those statistics input is
 * what was MADE and output is what was USED. That is not a guess: this save
 * carries 84 labs placed and reports `input = 84, output = 0` for the lab item,
 * and a lab is never consumed by anything. The opposite reading would have him
 * consuming 84 labs he never made. Electric network statistics use the reverse
 * convention and are collected separately; see the electric block below.
 *
 * `producedPerMinute` and `consumedPerMinute` are the game's own one-hour
 * rolling averages. Both are collected because the gap between them is the
 * whole diagnosis: a line making more than the base eats has headroom, a line
 * making exactly what it eats has none, and only the pair tells them apart.
 * State files written before U7 carry a single `perMinute`, which was the
 * consumption rate under a production label; `flowOf` normalises them.
 */
export interface Flow {
  /** Cumulative units made. */
  produced: number;
  /** Cumulative units consumed. */
  consumed: number;
  producedPerMinute: number;
  consumedPerMinute: number;
  /** Pre-U7 field names, read by `flowOf` and never written. */
  input?: number;
  output?: number;
  perMinute?: number;
}

/** Normalised view of a flow, whichever schema version wrote it. */
export interface Rates {
  produced: number;
  consumed: number;
  producedPerMinute: number;
  consumedPerMinute: number;
  /** Made per minute minus used per minute: what the base has spare. */
  headroomPerMinute: number;
}

/**
 * Read a flow from either schema. A pre-U7 file knows only the consumption
 * rate, so `producedPerMinute` comes back as null-equivalent 0 and headroom is
 * reported as 0 rather than invented from the cumulative totals, which average
 * over the whole save and say nothing about now.
 */
export function flowOf(flow: Flow | undefined): Rates {
  if (!flow) {
    return { produced: 0, consumed: 0, producedPerMinute: 0, consumedPerMinute: 0, headroomPerMinute: 0 };
  }
  const legacy = flow.producedPerMinute === undefined;
  const produced = flow.produced ?? flow.input ?? 0;
  const consumed = flow.consumed ?? flow.output ?? 0;
  const consumedPerMinute = flow.consumedPerMinute ?? flow.perMinute ?? 0;
  const producedPerMinute = legacy ? 0 : (flow.producedPerMinute ?? 0);
  return {
    produced,
    consumed,
    producedPerMinute,
    consumedPerMinute,
    headroomPerMinute: legacy ? 0 : producedPerMinute - consumedPerMinute,
  };
}

/** True when this state file predates the two-rate collector. */
export function isLegacyFlows(state: GameState, force = "player"): boolean {
  const items = state.forces[force]?.production.item;
  if (!items) return false;
  const first = Object.values(items)[0];
  return first !== undefined && first.producedPerMinute === undefined;
}

export interface ForceState {
  /** Present from U5 onward. */
  electric?: ElectricState;
  research?: ResearchState;
  /** Logistic network contents by item, summed across networks. */
  logistic?: Record<string, number>;
  /** Present from U3b onward; absent in older state files. */
  energy?: Record<string, ResolvedEnergy>;
  technologies: {
    researched: string[];
    current: string | null;
    queue: string[];
  };
  production: {
    item: Record<string, Flow>;
    fluid: Record<string, Flow>;
  };
  machines: Record<string, number>;
}

/**
 * The base, as coordinates.
 *
 * Every figure elsewhere in a state file is an aggregate; this is the one place
 * the save's geometry survives, and it exists so advice can point at a place.
 * Two resolutions, because one does not fit: a per-chunk count for everything,
 * and exact positions for prototypes rare enough that a point means something.
 */
export interface MapCell {
  /** Chunk coordinates: tile position divided by the chunk size, floored. */
  cx: number;
  cy: number;
  /** Placed entities of the force in this chunk, by prototype type. */
  byType: Record<string, number>;
  total: number;
  /** The surface's own pollution at the chunk, or absent when unreadable. */
  pollution?: number;
}

export interface OreCell {
  cx: number;
  cy: number;
  /** Remaining amount by resource name, summed over the chunk. */
  res: Record<string, number>;
}

export interface SurfaceMap {
  name: string;
  cellTiles: number;
  /** Tile bounds of everything below, so a renderer needs no second pass. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  cells: MapCell[];
  ore: OreCell[];
  /** Exact tile positions, only for prototypes under the point limit. */
  points: Record<string, Array<[number, number]>>;
}

export interface GameState {
  snapshot: {
    gameVersion: string;
    build: string;
    mods: Array<{ name: string; version: string }>;
    dumpedAt: string;
  };
  save: {
    name: string;
    copiedFrom: string;
    tick: number;
    hoursPlayed: number;
    surfaces: string[];
    readAt: string;
    /** Absent in state files written before the curve was collected. */
    day?: SurfaceDay;
    /** Entity classes the census counted, derived from the game's prototypes. */
    censusClasses?: string[];
    /** Evolution and pollution per surface. Present from U5 onward. */
    surfaceState?: SurfaceState[];
  };
  forces: Record<string, ForceState>;
  /** Present from U8 onward; absent in older state files. */
  map?: SurfaceMap[];
}

/**
 * A chunk is 32 tiles square. The map buckets everything into chunks because
 * that is the grid the engine already thinks in, so a cell boundary on our map
 * is a cell boundary in the game rather than an arbitrary one of ours.
 */
const MAP_CELL_TILES = 32;

/**
 * A prototype with at most this many placed instances gets exact positions;
 * anything commoner is left as a per-chunk count. A choice, not a game fact:
 * 3914 inserters as points would be noise on a map and megabytes in a file,
 * while 115 boilers are exactly what an advisor needs to point at. The list of
 * which prototypes qualify is derived from the census, never typed.
 */
const MAP_POINT_LIMIT = 600;

/**
 * The belt survey (C26), appended to the collector when a bus question asks for it.
 *
 * Every belt-like entity on the player force, with its prototype, position,
 * direction, and what sits on each of its transport lines. The lane record is
 * `[item, count, distinct, span]`: the item holding the most positions on that
 * lane, how many items are on it, how many different items are, which is how a
 * lane carrying one thing is told from a lane that has been contaminated, and
 * how many tiles the line spans.
 *
 * The span matters because a transport line is not a belt. The engine merges a
 * straight stretch of belts into one line, and every belt in that stretch reports
 * the same contents, so a raw count says nothing until it is divided by the tiles
 * the line covers. Density is that division; `line_length` is the engine's own
 * figure for it, read rather than counted here.
 *
 * Shapes are probed rather than assumed. `get_contents()` returned a dictionary
 * in 1.1 and an array of records in 2.0, so both are handled; every runtime call
 * is inside a `pcall`, because a survey that throws loses the whole state read.
 */
const BELT_SURVEY_LUA = `
  -- The belt survey (C26). Same surfaces, same force, no writes.
  local belt_types = { "transport-belt", "underground-belt", "splitter",
                       "loader", "loader-1x1", "linked-belt" }
  local belt_surfaces = {}
  for _, surface in pairs(game.surfaces) do
    local recs = {}
    for _, e in pairs(surface.find_entities_filtered{ force = player_force, type = belt_types }) do
      local lanes = {}
      local okn, lines = pcall(function() return e.get_max_transport_line_index() end)
      if okn and type(lines) == "number" then
        for i = 1, lines do
          local okl, line = pcall(function() return e.get_transport_line(i) end)
          if okl and line then
            local top, topn, distinct, total = "", 0, 0, 0
            local okc, contents = pcall(function() return line.get_contents() end)
            if okc and type(contents) == "table" then
              for k, v in pairs(contents) do
                local nm, ct
                if type(v) == "table" then nm, ct = v.name, (v.count or 1) else nm, ct = k, v end
                if nm then
                  distinct = distinct + 1
                  total = total + ct
                  if ct > topn then top, topn = nm, ct end
                end
              end
            end
            local span = 0
            local oks, len = pcall(function() return line.line_length end)
            if oks and type(len) == "number" then span = len end
            lanes[#lanes + 1] = { top, total, distinct, span }
          end
        end
      end
      local ug = nil
      if e.type == "underground-belt" then
        local oku, side = pcall(function() return e.belt_to_ground_type end)
        if oku then ug = side end
      end
      recs[#recs + 1] = { n = e.name, t = e.type, x = e.position.x, y = e.position.y,
                          d = e.direction, u = ug, l = lanes }
    end
    belt_surfaces[#belt_surfaces + 1] = { name = surface.name, belts = recs }
  end

  helpers.write_file("factorio-advisor/belts.json", helpers.table_to_json({
    tick = game.tick, surfaces = belt_surfaces,
  }), false)
`;

/**
 * The collector, appended to the copied save's own control script.
 *
 * It runs once, on the first tick, and writes one JSON file. Everything it reads
 * is a documented runtime API; nothing is computed here that the TypeScript side
 * could compute from the snapshot instead.
 *
 * `belts` adds a second file, the belt survey (C26). It is off by default because
 * it walks every belt on the surface and the watcher runs this collector on every
 * save; a bus question asks for it explicitly.
 */
function collectorLua(opts: { belts?: boolean } = {}): string {
  return `

-- ---------------------------------------------------------------------------
-- factorio-advisor collector. Appended to a COPY of the save; the original is
-- never modified. Writes one file to the redirected script-output and stops.
-- ---------------------------------------------------------------------------
script.on_nth_tick(1, function()
  if storage.__factorio_advisor_done then return end
  storage.__factorio_advisor_done = true

  local hour = defines.flow_precision_index.one_hour

  local function collect_flows(stats)
    -- On item and fluid production statistics, "input" is what was made and
    -- "output" is what was used. Both directions are collected: one rate alone
    -- cannot tell a line with spare capacity from one running flat out.
    local out = {}
    local function entry(name)
      local e = out[name]
      if not e then
        e = { produced = 0, consumed = 0, producedPerMinute = 0, consumedPerMinute = 0 }
        out[name] = e
      end
      return e
    end
    for name, count in pairs(stats.input_counts) do entry(name).produced = count end
    for name, count in pairs(stats.output_counts) do entry(name).consumed = count end
    for name, e in pairs(out) do
      -- The default return is a per-minute RATE over the window, not a total.
      -- Measured, not recalled: on iron-plate over the one-hour window the same
      -- call gave 113774.95 with count = true and 1896.249 without, and
      -- 113774.95 / 60 = 1896.249 exactly.
      e.producedPerMinute = stats.get_flow_count{
        name = name, category = "input", precision_index = hour,
      }
      e.consumedPerMinute = stats.get_flow_count{
        name = name, category = "output", precision_index = hour,
      }
    end
    return out
  end

  -- Which entity classes to count.
  --
  -- The first version of this listed twelve class names by hand and silently
  -- omitted radar, roboport, lamp, pump, electric turrets, inserters and
  -- accumulators, which made a figure the tool called a ceiling into an
  -- undercount. A hand-typed list cannot fail safely: nothing warns you about
  -- the class you did not think of.
  --
  -- So the list is derived instead. Anything that declares an energy source of
  -- any kind either draws power or makes it, and is therefore worth counting.
  -- A class added by a future version arrives on its own.
  local ENERGY_FIELDS = { "electric_energy_source_prototype", "burner_prototype",
                          "heat_energy_source_prototype", "fluid_energy_source_prototype" }
  local energy_types_cache = nil
  local function energy_types()
    if energy_types_cache then return energy_types_cache end
    local seen, out = {}, {}
    for _, proto in pairs(prototypes.entity) do
      if not seen[proto.type] then
        for _, field in ipairs(ENERGY_FIELDS) do
          local ok, src = pcall(function() return proto[field] end)
          if ok and src then
            seen[proto.type] = true
            out[#out + 1] = proto.type
            break
          end
        end
      end
    end
    energy_types_cache = out
    return out
  end

  -- Resolved energy figures, per prototype, straight from the engine.
  --
  -- The prototype data does not let you infer drain reliably. An assembling
  -- machine that declares none gets a thirtieth of its usage; a radar that
  -- declares none gets zero. Measured: radar energy_usage is 5000 J/tick with
  -- drain 0, while assembling-machine-2 is 2500 J/tick with drain 83.33, which
  -- is exactly usage/30. One rule cannot produce both, so no rule is applied
  -- here. The engine has already resolved these; they are copied, not derived.
  --
  -- Runtime energy fields are per tick. They are converted to watts on the
  -- TypeScript side, where the tick constant is already declared.
  local function energy_of(name)
    local proto = prototypes.entity[name]
    if not proto then return nil end
    local o = {}
    local function try(field, into)
      local ok, v = pcall(function() return proto[field] end)
      if ok and type(v) == "number" then o[into] = v end
    end
    try("energy_usage", "usagePerTick")
    try("max_energy_usage", "maxUsagePerTick")
    try("max_power_output", "outputPerTick")
    try("energy_per_movement", "perMovement")
    try("energy_per_shot", "perShot")
    try("energy_per_sector", "perSector")
    local ok, es = pcall(function() return proto.electric_energy_source_prototype end)
    if ok and es then
      o.electric = true
      local o2, v2 = pcall(function() return es.drain end)
      if o2 and type(v2) == "number" then o.drainPerTick = v2 end
      local o3, v3 = pcall(function() return es.buffer_capacity end)
      if o3 and type(v3) == "number" then o.buffer = v3 end
      local o4, v4 = pcall(function() return es.output_flow_limit end)
      if o4 and type(v4) == "number" then o.outputFlowLimit = v4 end
    end
    return o
  end

  local surfaces = {}
  for name in pairs(game.surfaces) do surfaces[#surfaces + 1] = name end

  -- The day curve is a runtime surface property, not a prototype field, so it
  -- has to be read here or the solar average has no source at all.
  local day = nil
  local first = game.surfaces[surfaces[1]]
  if first then
    day = { surface = first.name, ticksPerDay = first.ticks_per_day,
            solarPowerMultiplier = first.solar_power_multiplier,
            dusk = first.dusk, evening = first.evening,
            morning = first.morning, dawn = first.dawn }
  end

  -- Evolution is per force per surface; pollution is per surface. The player
  -- force is the one that matters, and both are copied, never computed.
  local surface_state = {}
  for _, surface in pairs(game.surfaces) do
    local entry = { surface = surface.name }
    local oke, ev = pcall(function() return game.forces["enemy"].get_evolution_factor(surface) end)
    entry.evolution = oke and ev or nil
    local okp, po = pcall(function() return surface.get_total_pollution() end)
    entry.pollution = okp and po or nil
    surface_state[#surface_state + 1] = entry
  end

  local forces = {}
  for force_name, force in pairs(game.forces) do
    local researched, queue = {}, {}
    for tech_name, tech in pairs(force.technologies) do
      if tech.researched then researched[#researched + 1] = tech_name end
    end
    for _, tech in pairs(force.research_queue or {}) do queue[#queue + 1] = tech.name end

    -- Statistics are per surface in 2.0, because a base can span planets.
    local items, fluids = {}, {}
    local function merge(into, from)
      for name, e in pairs(from) do
        local acc = into[name]
        if acc then
          acc.produced = acc.produced + e.produced
          acc.consumed = acc.consumed + e.consumed
          acc.producedPerMinute = acc.producedPerMinute + e.producedPerMinute
          acc.consumedPerMinute = acc.consumedPerMinute + e.consumedPerMinute
        else
          into[name] = e
        end
      end
    end
    local machines = {}
    for _, surface in pairs(game.surfaces) do
      merge(items, collect_flows(force.get_item_production_statistics(surface)))
      merge(fluids, collect_flows(force.get_fluid_production_statistics(surface)))
      local found = surface.find_entities_filtered{ force = force, type = energy_types() }
      for _, e in pairs(found) do
        machines[e.name] = (machines[e.name] or 0) + 1
      end
    end

    local energy = {}
    for name in pairs(machines) do energy[name] = energy_of(name) end

    -- What the grid actually delivered, as opposed to what it could.
    --
    -- Electric network statistics are per network, and a base has several (four
    -- here), so every distinct network on every surface is visited and summed.
    -- The figures are joules per tick. Measured, not assumed: 34 radars, which
    -- scan continuously at 300 kW, report 169041, and 169041 x 60 is 10.14 MW
    -- against a nameplate 10.2 MW. No other reading of the unit is possible.
    local nets_seen, prod, cons, net_count = {}, {}, {}, 0
    for _, surface in pairs(game.surfaces) do
      for _, pole in pairs(surface.find_entities_filtered{ type = "electric-pole", force = force }) do
        local id = pole.electric_network_id
        if id and not nets_seen[id] then
          nets_seen[id] = true
          net_count = net_count + 1
          local st = pole.electric_network_statistics
          if st then
            for name in pairs(st.output_counts) do
              prod[name] = (prod[name] or 0)
                + st.get_flow_count{ name = name, category = "output", precision_index = hour }
            end
            for name in pairs(st.input_counts) do
              cons[name] = (cons[name] or 0)
                + st.get_flow_count{ name = name, category = "input", precision_index = hour }
            end
          end
        end
      end
    end

    -- Logistic network contents, summed over every network on every surface.
    local logistic = {}
    for _, surface in pairs(game.surfaces) do
      local nets = force.logistic_networks[surface.name]
      if nets then
        for _, net in pairs(nets) do
          local ok, contents = pcall(function() return net.get_contents() end)
          if ok and contents then
            for key, entry in pairs(contents) do
              if type(entry) == "table" then
                logistic[entry.name] = (logistic[entry.name] or 0) + entry.count
              else
                logistic[key] = (logistic[key] or 0) + entry
              end
            end
          end
        end
      end
    end

    local research_progress = nil
    local okp, pv = pcall(function() return force.research_progress end)
    if okp and type(pv) == "number" and force.current_research then research_progress = pv end

    forces[force_name] = {
      energy = energy,
      electric = { networks = net_count, production = prod, consumption = cons },
      research = { labSpeedModifier = force.laboratory_speed_modifier,
                   labProductivityBonus = force.laboratory_productivity_bonus,
                   progress = research_progress },
      logistic = logistic,
      technologies = {
        researched = researched,
        current = force.current_research and force.current_research.name or nil,
        queue = queue,
      },
      production = { item = items, fluid = fluids },
      machines = machines,
    }
  end

  -- The map.
  --
  -- Aggregated in here rather than shipped raw: a played surface holds hundreds
  -- of thousands of resource entities and tens of thousands of machines, and a
  -- file with every one of them in it would be slower to write than the read it
  -- belongs to. Chunks are the bucket because the engine already uses them.
  local CELL = ${String(MAP_CELL_TILES)}
  local POINT_LIMIT = ${String(MAP_POINT_LIMIT)}
  local player_force = game.forces["player"]
  local map = {}
  for _, surface in pairs(game.surfaces) do
    local cells, ore, points = {}, {}, {}
    local minx, miny, maxx, maxy

    local function bound(x, y)
      if not minx or x < minx then minx = x end
      if not maxx or x > maxx then maxx = x end
      if not miny or y < miny then miny = y end
      if not maxy or y > maxy then maxy = y end
    end

    local function cell_of(store, x, y)
      local cx, cy = math.floor(x / CELL), math.floor(y / CELL)
      local key = cx .. ":" .. cy
      local c = store[key]
      if not c then c = { cx = cx, cy = cy }; store[key] = c end
      return c
    end

    for _, e in pairs(surface.find_entities_filtered{ force = player_force }) do
      local pos = e.position
      local kind = e.type
      -- Ground clutter carries no information a map can use and would swamp
      -- the bounds: a stray corpse or an item on the ground is not the base.
      -- Tile ghosts go with them for a different reason: this save holds 136298
      -- of them, planned landfill, which is eighty percent of everything placed
      -- and would have set the density shading for the whole map on its own.
      -- Entity ghosts stay, because planned construction is part of the base.
      if kind ~= "corpse" and kind ~= "item-entity" and kind ~= "character"
         and kind ~= "tile-ghost" then
        local c = cell_of(cells, pos.x, pos.y)
        c.byType = c.byType or {}
        c.byType[kind] = (c.byType[kind] or 0) + 1
        c.total = (c.total or 0) + 1
        bound(pos.x, pos.y)
        local p = points[e.name]
        if not p then p = {}; points[e.name] = p end
        if #p <= POINT_LIMIT then p[#p + 1] = { pos.x, pos.y } end
      end
    end

    -- Over the limit means the positions were never worth keeping. The count
    -- per chunk above already carries that prototype.
    for name, p in pairs(points) do
      if #p > POINT_LIMIT then points[name] = nil end
    end

    for _, e in pairs(surface.find_entities_filtered{ type = "resource" }) do
      local pos = e.position
      local c = cell_of(ore, pos.x, pos.y)
      c.res = c.res or {}
      c.res[e.name] = (c.res[e.name] or 0) + (e.amount or 0)
      bound(pos.x, pos.y)
    end

    local cell_list = {}
    for _, c in pairs(cells) do
      local okp, pol = pcall(function()
        return surface.get_pollution({ c.cx * CELL + CELL / 2, c.cy * CELL + CELL / 2 })
      end)
      if okp and type(pol) == "number" and pol > 0 then c.pollution = pol end
      cell_list[#cell_list + 1] = c
    end
    local ore_list = {}
    for _, c in pairs(ore) do ore_list[#ore_list + 1] = c end

    map[#map + 1] = {
      name = surface.name,
      cellTiles = CELL,
      bounds = minx and { minX = minx, minY = miny, maxX = maxx, maxY = maxy } or nil,
      cells = cell_list,
      ore = ore_list,
      points = points,
    }
  end

${opts.belts ? BELT_SURVEY_LUA : ""}
  helpers.write_file("factorio-advisor/state.json", helpers.table_to_json({
    tick = game.tick,
    surfaces = surfaces,
    day = day,
    censusClasses = energy_types(),
    surfaceState = surface_state,
    forces = forces,
    map = map,
  }), false)
end)
`;
}

/** A save name as it appears in the save directory, turned into a filename. */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Append the collector to the control script inside a copy of the save.
 *
 * A save zip carries `<save name>/control.lua`. We read it, append, and write it
 * back into the copy with `zip`, which is the one external tool this needs. Bun's
 * own zip support cannot update an entry in place.
 */
async function injectCollector(
  copyPath: string,
  innerDir: string,
  opts: { belts?: boolean } = {},
): Promise<void> {
  const staging = join(RUNTIME_DIR, "inject");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, innerDir), { recursive: true });

  const unzip = Bun.spawn(["unzip", "-o", "-q", copyPath, `${innerDir}/control.lua`, "-d", staging], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await unzip.exited) !== 0) {
    const err = await new Response(unzip.stderr).text();
    throw new Error(`Could not read control.lua out of the save copy.\n${err}`);
  }

  const controlPath = join(staging, innerDir, "control.lua");
  const original = readFileSync(controlPath, "utf8");
  writeFileSync(controlPath, original + collectorLua(opts));

  const zip = Bun.spawn(["zip", "-q", copyPath, `${innerDir}/control.lua`], {
    cwd: staging,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await zip.exited) !== 0) {
    const err = await new Response(zip.stderr).text();
    throw new Error(`Could not write the collector back into the save copy.\n${err}`);
  }
}

/** The directory name inside the save zip, which is the save's own name. */
async function innerDirOf(zipPath: string): Promise<string> {
  const proc = Bun.spawn(["unzip", "-Z1", zipPath], { stdout: "pipe", stderr: "pipe" });
  const listing = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`Could not list ${zipPath}.`);
  for (const line of listing.split("\n")) {
    const slash = line.indexOf("/");
    if (slash > 0) return line.slice(0, slash);
  }
  throw new Error(`${zipPath} does not look like a Factorio save: no top-level directory.`);
}

/**
 * The newest save in the save directory, autosaves included.
 *
 * The workflow this exists for is "press save, alt-tab, ask": naming a file by
 * hand every time is friction that has nothing to do with the question.
 */
export function newestSave(): { name: string; path: string; mtime: Date } | null {
  const userdata = findUserdata();
  if (!userdata) return null;
  const dir = join(userdata, "saves");
  if (!existsSync(dir)) return null;
  let best: { name: string; path: string; mtime: Date } | null = null;
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".zip")) continue;
    const path = join(dir, entry);
    const mtime = statSync(path).mtime;
    if (!best || mtime > best.mtime) {
      best = { name: entry.replace(/\.zip$/i, ""), path, mtime };
    }
  }
  return best;
}

export interface ReadStateOptions {
  save: string;
  quiet?: boolean;
  /** Also run the belt survey (C26) and write `data/state/<slug>-belts.json`. */
  belts?: boolean;
}

export async function readState(opts: ReadStateOptions): Promise<GameState> {
  const core = findCore();
  const binary = findBinary(core);
  const userdata = findUserdata();
  if (!userdata) {
    throw new Error(
      "Could not find the Factorio user directory. Set FACTORIO_USERDATA to the directory holding saves/.",
    );
  }

  const bare = opts.save.replace(/\.zip$/i, "");
  const source = join(userdata, "saves", `${bare}.zip`);
  if (!existsSync(source)) {
    throw new Error(`No save called "${bare}" in ${join(userdata, "saves")}.`);
  }

  const say = (s: string) => {
    if (!opts.quiet) console.log(s);
  };

  const slug = slugify(bare);
  const savesDir = join(RUNTIME_DIR, "saves");
  mkdirSync(savesDir, { recursive: true });
  const copy = join(savesDir, `advisor-${slug}.zip`);

  say(`Reading ${source}`);
  say(`  copy    ${copy}   (your save is never opened in place)`);
  copyFileSync(source, copy);

  const innerDir = await innerDirOf(copy);
  await injectCollector(copy, innerDir, { belts: opts.belts });

  const configPath = writeRuntimeConfig(core);
  const outPath = join(RUNTIME_DIR, "script-output", "factorio-advisor", "state.json");
  const beltsPath = join(RUNTIME_DIR, "script-output", "factorio-advisor", "belts.json");
  rmSync(outPath, { force: true });
  rmSync(beltsPath, { force: true });

  say(`  engine  ${binary} --benchmark, write-data redirected into this project`);
  const proc = Bun.spawn(
    [binary, "--config", configPath, "--benchmark", copy,
     "--benchmark-ticks", String(BENCHMARK_TICKS), "--disable-audio"],
    { cwd: RUNTIME_DIR, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const log = stdout + stderr;

  if (!existsSync(outPath)) {
    throw new Error(
      `The collector did not write ${outPath} (engine exited ${code}).\n` +
        `This is reported rather than worked around: without the file there is no state to report.\n\n` +
        log.slice(-2000),
    );
  }

  const raw = JSON.parse(readFileSync(outPath, "utf8")) as {
    tick: number;
    surfaces: string[];
    day?: SurfaceDay;
    censusClasses?: string[];
    surfaceState?: SurfaceState[];
    forces: Record<string, ForceState>;
    map?: SurfaceMap[];
  };

  const manifest: Manifest | null = readManifest();
  const state: GameState = {
    snapshot: {
      gameVersion: manifest?.gameVersion ?? "unknown",
      build: manifest?.build ?? "unknown",
      mods: manifest?.mods ?? [],
      dumpedAt: manifest?.dumpedAt ?? "unknown",
    },
    save: {
      name: bare,
      copiedFrom: source,
      tick: raw.tick,
      hoursPlayed: raw.tick / TICKS_PER_SECOND / 3600,
      surfaces: raw.surfaces,
      readAt: new Date().toISOString(),
      ...(raw.day ? { day: raw.day } : {}),
      ...(raw.censusClasses ? { censusClasses: raw.censusClasses } : {}),
      ...(raw.surfaceState ? { surfaceState: raw.surfaceState } : {}),
    },
    forces: raw.forces,
    ...(raw.map ? { map: raw.map } : {}),
  };

  // Electric network figures arrive as joules per tick. Watts is what a reader
  // wants, and the tick constant is declared here rather than in the Lua.
  for (const force of Object.values(state.forces)) {
    if (!force.electric) continue;
    for (const side of [force.electric.production, force.electric.consumption]) {
      for (const key of Object.keys(side)) side[key] = side[key]! * TICKS_PER_SECOND;
    }
  }

  const stateDir = join(DATA_DIR, "state");
  mkdirSync(stateDir, { recursive: true });
  const dest = join(stateDir, `${slug}.json`);
  writeFileSync(dest, JSON.stringify(state, null, 2) + "\n");
  say(`  wrote   ${dest}`);

  if (opts.belts) {
    if (!existsSync(beltsPath)) {
      throw new Error(
        `The belt survey did not write ${beltsPath}, although the state read succeeded.\n` +
          `Reported rather than worked around: without the file there are no belts to judge.`,
      );
    }
    const beltDest = join(stateDir, `${slug}-belts.json`);
    copyFileSync(beltsPath, beltDest);
    say(`  wrote   ${beltDest}`);
  }

  return state;
}

/** Read a state file written by an earlier `state` run, if there is one. */
export function readStateFile(save: string): GameState | null {
  try {
    const path = join(DATA_DIR, "state", `${slugify(save.replace(/\.zip$/i, ""))}.json`);
    return JSON.parse(readFileSync(path, "utf8")) as GameState;
  } catch {
    return null;
  }
}

export { slugify };
