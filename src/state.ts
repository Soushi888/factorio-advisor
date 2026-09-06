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

export interface ForceState {
  technologies: {
    researched: string[];
    current: string | null;
    queue: string[];
  };
  production: {
    item: Record<string, { input: number; output: number; perMinute: number }>;
    fluid: Record<string, { input: number; output: number; perMinute: number }>;
  };
  machines: Record<string, number>;
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
  };
  forces: Record<string, ForceState>;
}

/**
 * The collector, appended to the copied save's own control script.
 *
 * It runs once, on the first tick, and writes one JSON file. Everything it reads
 * is a documented runtime API; nothing is computed here that the TypeScript side
 * could compute from the snapshot instead.
 */
function collectorLua(): string {
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
    local out = {}
    for name, count in pairs(stats.output_counts) do
      out[name] = { input = 0, output = count, perMinute = 0 }
    end
    for name, count in pairs(stats.input_counts) do
      local e = out[name]
      if e then e.input = count else out[name] = { input = count, output = 0, perMinute = 0 } end
    end
    for name, e in pairs(out) do
      -- The default return is a per-minute RATE over the window, not a total.
      -- Measured, not recalled: on iron-plate over the one-hour window the same
      -- call gave 113774.95 with count = true and 1896.249 without, and
      -- 113774.95 / 60 = 1896.249 exactly.
      e.perMinute = stats.get_flow_count{
        name = name, category = "output", precision_index = hour,
      }
    end
    return out
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
          acc.input = acc.input + e.input
          acc.output = acc.output + e.output
          acc.perMinute = acc.perMinute + e.perMinute
        else
          into[name] = e
        end
      end
    end
    local machines = {}
    for _, surface in pairs(game.surfaces) do
      merge(items, collect_flows(force.get_item_production_statistics(surface)))
      merge(fluids, collect_flows(force.get_fluid_production_statistics(surface)))
      local found = surface.find_entities_filtered{
        force = force,
        type = { "assembling-machine", "furnace", "mining-drill", "lab",
                 "rocket-silo", "reactor", "generator", "solar-panel",
                 "boiler", "beacon", "agricultural-tower", "asteroid-collector" },
      }
      for _, e in pairs(found) do
        machines[e.name] = (machines[e.name] or 0) + 1
      end
    end

    forces[force_name] = {
      technologies = {
        researched = researched,
        current = force.current_research and force.current_research.name or nil,
        queue = queue,
      },
      production = { item = items, fluid = fluids },
      machines = machines,
    }
  end

  helpers.write_file("factorio-advisor/state.json", helpers.table_to_json({
    tick = game.tick,
    surfaces = surfaces,
    day = day,
    forces = forces,
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
async function injectCollector(copyPath: string, innerDir: string): Promise<void> {
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
  writeFileSync(controlPath, original + collectorLua());

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
  await injectCollector(copy, innerDir);

  const configPath = writeRuntimeConfig(core);
  const outPath = join(RUNTIME_DIR, "script-output", "factorio-advisor", "state.json");
  rmSync(outPath, { force: true });

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
    forces: Record<string, ForceState>;
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
    },
    forces: raw.forces,
  };

  const stateDir = join(DATA_DIR, "state");
  mkdirSync(stateDir, { recursive: true });
  const dest = join(stateDir, `${slug}.json`);
  writeFileSync(dest, JSON.stringify(state, null, 2) + "\n");
  say(`  wrote   ${dest}`);

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
