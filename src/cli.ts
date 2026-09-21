import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatWatts } from "./energy.ts";
import { readManifest, sync, type Manifest } from "./dump.ts";
import { load, type Data } from "./proto.ts";
import { RecipeIndex } from "./recipes.ts";
import { PROJECT_ROOT } from "./paths.ts";
import { machinesFor, multipliers, parseModules, runOne, type ModuleLoadout } from "./machines.ts";
import { parseRate, solve } from "./solve.ts";
import { beltOptions, inserterCeilings } from "./belts.ts";
import { costOf, dependents, labsFor, researchPath, totalCost, unlocksOf } from "./tech.ts";
import { decode, flatten, describeKind } from "./blueprint.ts";
import { audit, byRecipe, type AuditResult } from "./audit.ts";
import { judge } from "./target.ts";
import { beltFor, buildRow } from "./layout.ts";
import { drawPrint, printPage, type DrawnPrint } from "./draw.ts";
import { flowOf, newestSave, readState, readStateFile, slugify, type GameState } from "./state.ts";
import { busAreas, judge as judgeBus, readSurvey, surveyPath, type BusReport } from "./bus.ts";
import { mapOf, renderMap, type Area } from "./map.ts";
import { advise, type Advisory, type Requirement } from "./advise.ts";
import { gateFor, pathFromHere, researchable } from "./next.ts";
import { effectiveGeneration, powerReport, solarAverageFactor } from "./power.ts";
import { bullet, heading, indent, num, pct, rate, sub, table } from "./render.ts";

/**
 * The only entry point, and the only place that formats output.
 *
 * Every command that reports a game fact prints the snapshot it came from
 * first, the way wesnoth-advisor prints the save name. A number with no
 * provenance is not an answer.
 */

interface Args {
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (const a of argv) {
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) flags.set(a.slice(2), "true");
      else flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function header(manifest: Manifest | null): string {
  if (!manifest) return "snapshot: (no manifest; run `bun run sync`)";
  const mods = manifest.mods.map((m) => m.name).join(", ");
  const when = manifest.dumpedAt.slice(0, 16).replace("T", " ");
  return `snapshot: Factorio ${manifest.gameVersion} build ${manifest.build} [${mods}] dumped ${when}`;
}

/** Resolve a name the way a person types it: exact, then unique substring. */
function resolveProduct(data: Data, query: string): string {
  if (data.isProduct(query)) return query;
  const q = query.toLowerCase().replace(/\s+/g, "-");
  if (data.isProduct(q)) return q;

  const names = [...data.items().keys(), ...Object.keys(data.klass("fluid"))];
  const exact = names.filter((n) => n.toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  const hits = names.filter((n) => n.toLowerCase().includes(q));
  if (hits.length === 0) throw new Error(`No item or fluid matching "${query}".`);
  if (hits.length === 1) return hits[0]!;
  hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const shortest = hits[0]!;
  if (shortest.toLowerCase() === q) return shortest;
  throw new Error(
    `"${query}" matches ${hits.length} products. Did you mean one of:\n` +
      bullet(hits.slice(0, 12)),
  );
}

function resolveTech(data: Data, query: string): string {
  const techs = data.technologies();
  if (techs.has(query)) return query;
  const q = query.toLowerCase().replace(/\s+/g, "-");
  if (techs.has(q)) return q;
  const hits = [...techs.keys()].filter((n) => n.toLowerCase().includes(q));
  if (hits.length === 0) throw new Error(`No technology matching "${query}".`);
  if (hits.length === 1) return hits[0]!;
  hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (hits[0]!.toLowerCase() === q) return hits[0]!;
  throw new Error(
    `"${query}" matches ${hits.length} technologies. Did you mean one of:\n` +
      bullet(hits.slice(0, 12)),
  );
}

/** Build the module and beacon loadout from the flags. */
function buildLoadout(data: Data, flags: Map<string, string>): ModuleLoadout {
  const modules = parseModules(data, flags.get("modules"));
  const beaconCount = Number(flags.get("beacons") ?? 0);
  if (!Number.isFinite(beaconCount) || beaconCount <= 0) return { modules, beacons: [] };

  const beaconName = flags.get("beacon") ?? data.beacons()[0]?.name;
  const beacon = data.beacons().find((b) => b.name === beaconName);
  if (!beacon) throw new Error(`Unknown beacon: ${beaconName}`);

  const spec = flags.get("beacon-modules");
  let beaconModules = parseModules(data, spec);
  if (beaconModules.length === 0) {
    const slots = typeof beacon.module_slots === "number" ? beacon.module_slots : 0;
    const fallback = data.module("speed-module-3") ?? data.modules()[0];
    if (fallback) beaconModules = Array.from({ length: slots }, () => fallback);
  }

  return {
    modules,
    beacons: Array.from({ length: Math.floor(beaconCount) }, () => ({
      beacon,
      modules: beaconModules,
    })),
  };
}

function stackList(list: Array<{ name: string; amount: number; probability?: number }>): string {
  if (list.length === 0) return "(none)";
  return list
    .map((s) => {
      const p = s.probability !== undefined ? ` @ ${num(s.probability * 100, 1)}%` : "";
      return `${num(s.amount)} ${s.name}${p}`;
    })
    .join(", ");
}

// ---------------------------------------------------------------- commands

async function cmdSync(): Promise<void> {
  const manifest = await sync();
  console.log(
    `\nMods in the snapshot:\n` +
      bullet(manifest.mods.map((m) => `${m.name} ${m.version}`)),
  );
  console.log(
    "\nThis is a vanilla snapshot by construction: the dump ran against a fresh\n" +
      "write-data inside this project, so whatever mods you play with were not loaded.",
  );
}

function cmdSearch(args: Args): void {
  const data = load();
  const query = args.positional.join(" ");
  if (!query) throw new Error("Usage: bun run search <text>");
  console.log(header(data.manifest));
  const hits = data.search(query, Number(args.flags.get("limit") ?? 40));
  if (hits.length === 0) {
    console.log(`\nNothing matching "${query}".`);
    return;
  }
  console.log(heading(`${hits.length} prototypes matching "${query}"`));
  console.log(
    table(
      [{ header: "name" }, { header: "class" }],
      hits.map((h) => [h.name, h.type]),
    ),
  );
}

function cmdRecipe(args: Args): void {
  const data = load();
  const index = new RecipeIndex(data);
  const query = args.positional.join("-");
  if (!query) throw new Error("Usage: bun run recipe <name>");
  console.log(header(data.manifest));

  let recipe = index.get(query);
  if (!recipe) {
    // Fall back to "the recipe that makes this product".
    const product = resolveProduct(data, query);
    const producers = index.productionCandidates(product);
    if (producers.length === 0) {
      throw new Error(
        `Nothing makes ${product}. It is a raw input: you mine it, pump it, or collect it.`,
      );
    }
    recipe = index.defaultFor(product)!;
    if (producers.length > 1) {
      console.log(`\n${product} has ${producers.length} recipes; showing the default.`);
    }
  }

  console.log(heading(recipe.name));
  console.log(`category    ${recipe.category}`);
  console.log(`craft time  ${num(recipe.time)}s at speed 1`);
  console.log(`ingredients ${stackList(recipe.ingredients)}`);
  console.log(`results     ${stackList(recipe.results)}`);
  console.log(`productivity ${recipe.allowProductivity ? "allowed" : "not allowed"}`);

  const unlocks = index.unlockedBy(recipe.name);
  console.log(
    `unlocked by ${recipe.enabled ? "available from the start" : unlocks.join(", ") || "nothing (unreachable)"}`,
  );

  const machines = machinesFor(data, recipe);
  if (machines.length === 0) {
    console.log("\nNo machine in this snapshot can run that category.");
  } else {
    console.log(sub("Machines that can run it"));
    console.log(
      table(
        [
          { header: "machine" },
          { header: "speed", align: "right" },
          { header: "slots", align: "right" },
          { header: "power", align: "right" },
          { header: "out/s", align: "right" },
        ],
        machines.map((m) => {
          const r = runOne(data, recipe!, m);
          const main = recipe!.mainProduct ?? recipe!.results[0]?.name ?? "";
          return [
            m.name,
            num(m.crafting_speed),
            String(m.module_slots ?? 0),
            formatWatts(r.activeWatts),
            num(r.outputPerSecond.get(main) ?? 0),
          ];
        }),
      ),
    );
  }

  const alternatives = recipe.results
    .flatMap((r) => index.productionCandidates(r.name))
    .filter((r) => r.name !== recipe!.name);
  const uniqueAlts = [...new Set(alternatives.map((r) => r.name))];
  if (uniqueAlts.length > 0) {
    console.log(sub("Other ways to make the same things"));
    console.log(bullet(uniqueAlts));
  }

  const recyclers = recipe.results
    .flatMap((r) => index.producersOf(r.name))
    .filter((r) => r.category === "recycling").length;
  if (recyclers > 0) {
    console.log(
      `\n  ${recyclers} recycling recipes also return this item. They are excluded from` +
        `\n  production planning, because a recycler gives back a quarter of what it ate.`,
    );
  }
}

function cmdRatio(args: Args): void {
  const data = load();
  const index = new RecipeIndex(data);
  const query = args.positional.join("-");
  if (!query) throw new Error("Usage: bun run ratio <item> --rate=<n[/s|/m|/h]>");
  console.log(header(data.manifest));

  const target = resolveProduct(data, query);
  const perSecond = parseRate(args.flags.get("rate") ?? "1");
  const loadout = buildLoadout(data, args.flags);

  const recipeFor = new Map<string, string>();
  for (const [k, v] of args.flags) {
    if (k === "recipe") {
      // --recipe=product=recipe-name, repeatable via commas
      for (const pair of v.split(",")) {
        const [p, r] = pair.split("=");
        if (p && r) recipeFor.set(p, r);
      }
    }
  }
  const raw = new Set(
    (args.flags.get("raw") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );

  const sol = solve(data, index, target, perSecond, {
    recipeFor,
    machine: args.flags.get("machine"),
    loadout,
    raw,
  });

  console.log(heading(`${target} at ${rate(perSecond)}`));
  if (loadout.modules.length > 0 || loadout.beacons.length > 0) {
    const m = multipliers(loadout);
    console.log(
      `loadout: ${loadout.modules.map((x) => x.name).join(", ") || "no machine modules"}` +
        (loadout.beacons.length > 0
          ? ` + ${loadout.beacons.length} x ${loadout.beacons[0]!.beacon.name}`
          : "") +
        `  ->  speed ${pct(m.speed - 1)}, productivity ${pct(m.productivity - 1)}, power ${pct(m.consumption - 1)}`,
    );
  }

  console.log(sub("Production steps"));
  console.log(
    table(
      [
        { header: "" },
        { header: "product" },
        { header: "rate/s", align: "right" },
        { header: "recipe" },
        { header: "machine" },
        { header: "count", align: "right" },
      ],
      sol.steps.map((s) => [
        indent(s.depth),
        s.product,
        num(s.ratePerSecond),
        s.recipe.name === s.product ? "" : s.recipe.name,
        s.machine?.name ?? "(none can run it)",
        s.machineCount > 0 ? `${num(s.machineCount)} -> ${Math.ceil(s.machineCount - 1e-9)}` : "-",
      ]),
    ),
  );

  if (sol.raw.size > 0) {
    console.log(sub("Raw inputs"));
    console.log(
      table(
        [{ header: "input" }, { header: "rate/s", align: "right" }, { header: "per min", align: "right" }],
        [...sol.raw]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, num(v), num(v * 60)]),
      ),
    );
  }

  if (sol.surplus.size > 0) {
    console.log(sub("Surplus the chain does not consume"));
    console.log(
      table(
        [{ header: "product" }, { header: "rate/s", align: "right" }],
        [...sol.surplus].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, num(v)]),
      ),
    );
  }

  console.log(sub("Totals"));
  console.log(`machines     ${sol.totalMachines} (whole buildings)`);
  console.log(
    `power        ${formatWatts(sol.totalWatts)} active + ${formatWatts(sol.totalDrainWatts)} idle drain`,
  );
  console.log(`pollution    ${num(sol.pollutionPerMinute)} /min at full load`);

  if (sol.choices.length > 0) {
    console.log(sub("Recipe choices this made for you"));
    console.log(
      bullet(
        sol.choices.map(
          (c) =>
            `${c.product}: using ${c.chosen}, declined ${c.alternatives.join(", ")}` +
            `   (override with --recipe=${c.product}=${c.alternatives[0]})`,
        ),
      ),
    );
  }

  if (sol.cycles.length > 0) {
    console.log(sub("Cycles, not expanded"));
    console.log(
      bullet(
        sol.cycles.map(
          (c) => `${c.join(" -> ")}  (treated as a raw input where it closes)`,
        ),
      ),
    );
    console.log(
      "\n  A loop like coal liquefaction feeds itself, so the numbers above assume the\n" +
        "  looping input is supplied. Pick the non-looping recipe with --recipe to avoid it.",
    );
  }

  if (sol.unresolved.length > 0) {
    console.log(sub("Unresolved"));
    console.log(bullet(sol.unresolved));
  }

  const rejected = [...new Set(sol.steps.flatMap((s) => s.rejectedModules))];
  if (rejected.length > 0) {
    console.log(sub("Modules that did not fit"));
    console.log(bullet(rejected));
  }
}

function cmdTech(args: Args): void {
  const data = load();
  console.log(header(data.manifest));

  const wantPath = args.flags.has("path");
  const query = args.flags.get("path") !== "true" && args.flags.get("path")
    ? args.flags.get("path")!
    : args.positional.join("-");
  if (!query) throw new Error("Usage: bun run tech <name> [--path]");

  const name = resolveTech(data, query);
  const tech = data.technology(name)!;

  console.log(heading(name));
  const cost = costOf(tech);
  if (cost.formula) {
    console.log(`count       formula ${cost.formula} (infinite technology)`);
  }
  if (cost.trigger) {
    console.log(`trigger     ${cost.trigger}`);
  }
  console.log(
    `cost        ${[...cost.packs].map(([k, v]) => `${num(v)} ${k}`).join(", ") || "(no science; unlocked by doing)"}`,
  );
  if (cost.labSeconds > 0) console.log(`lab time    ${num(cost.labSeconds)}s at lab speed 1`);
  const labs = labsFor(data, cost.packs.keys());
  if (labs.length > 0) console.log(`labs        ${labs.join(", ")}`);
  console.log(`prerequisites ${(tech.prerequisites ?? []).join(", ") || "(none)"}`);

  const un = unlocksOf(tech);
  if (un.length > 0) {
    console.log(sub("Unlocks"));
    console.log(
      table(
        [{ header: "effect" }, { header: "detail" }],
        un.map((u) => [u.kind, u.detail]),
      ),
    );
  }

  const deps = dependents(data, name);
  if (deps.length > 0) {
    console.log(sub("Leads to"));
    console.log(bullet(deps));
  }

  if (wantPath) {
    const path = researchPath(data, name);
    const totals = totalCost(path);
    console.log(sub(`Research path: ${path.length} technologies`));
    console.log(
      table(
        [
          { header: "#", align: "right" },
          { header: "technology" },
          { header: "lab s", align: "right" },
          { header: "packs" },
        ],
        path.map((t, i) => {
          const c = costOf(t);
          return [
            String(i + 1),
            t.name,
            c.formula ? "formula" : c.trigger && c.packs.size === 0 ? "-" : num(c.labSeconds, 0),
            c.trigger && c.packs.size === 0
              ? c.trigger
              : [...c.packs].map(([k, v]) => `${num(v, 0)} ${shortPack(k)}`).join(" "),
          ];
        }),
      ),
    );
    console.log(sub("Path totals"));
    console.log(
      table(
        [{ header: "science pack" }, { header: "count", align: "right" }],
        [...totals.packs]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, num(v, 0)]),
      ),
    );
    console.log(`\nlab time  ${num(totals.labSeconds, 0)}s at lab speed 1`);
    const biolab = data.klass("lab")["biolab"];
    if (biolab && typeof biolab["researching_speed"] === "number") {
      const s = biolab["researching_speed"];
      console.log(`          ${num(totals.labSeconds / s, 0)}s in one biolab (speed ${num(s)})`);
    }
    if (totals.triggered.length > 0) {
      console.log(
        `\n${totals.triggered.length} of these cost no science. They unlock when you do the` +
          `\nthing they name, so they are free but not automatic.`,
      );
    }
    if (totals.infinite.length > 0) {
      console.log(`\ninfinite technologies on the path, cost not summed: ${totals.infinite.join(", ")}`);
    }
  }
}

function shortPack(name: string): string {
  return name.replace(/-science-pack$/, "");
}

function cmdBelt(args: Args): void {
  const data = load();
  console.log(header(data.manifest));

  const rateFlag = args.flags.get("rate");
  const query = args.positional.join("-");
  const perSecond = rateFlag ? parseRate(rateFlag) : null;

  console.log(heading(perSecond === null ? "Belt throughput" : `Carrying ${rate(perSecond)}`));
  const options = beltOptions(data, perSecond ?? 1);
  console.log(
    table(
      [
        { header: "belt" },
        { header: "items/s", align: "right" },
        { header: "items/min", align: "right" },
        ...(perSecond === null
          ? []
          : [{ header: "belts needed", align: "right" as const }, { header: "one belt at", align: "right" as const }]),
      ],
      options.map((o) => [
        o.belt.name,
        num(o.itemsPerSecond),
        num(o.itemsPerSecond * 60, 0),
        ...(perSecond === null
          ? []
          : [num(o.beltsNeeded), `${num(o.saturation * 100, 0)}%`]),
      ]),
    ),
  );

  if (query) {
    const product = resolveProduct(data, query);
    const item = data.item(product);
    if (item) {
      const stack = item["stack_size"];
      console.log(`\n${product}: stack size ${typeof stack === "number" ? stack : "?"}`);
    } else if (data.fluid(product)) {
      console.log(
        `\n${product} is a fluid. Belts do not carry it; pipes and pumps do, and pipe` +
          `\nthroughput depends on the length of the run, which a prototype cannot tell you.`,
      );
    }
  }

  console.log(sub("Inserter rotation ceiling"));
  console.log(
    table(
      [
        { header: "inserter" },
        { header: "swings/s", align: "right" },
        { header: "bulk" },
      ],
      inserterCeilings(data).map((i) => [
        i.inserter.name,
        num(i.swingsPerSecond),
        i.bulk ? "yes" : "",
      ]),
    ),
  );
  console.log(
    "\n  Swings per second is derived from rotation_speed alone and is a ceiling, not\n" +
      "  a prediction. Real throughput depends on belt chasing, the inserter capacity\n" +
      "  bonus from research, and what sits on each side. None of those are prototype\n" +
      "  facts, so this tool will not invent them.",
  );
}

function cmdBp(args: Args): void {
  const data = load();
  const index = new RecipeIndex(data);
  console.log(header(data.manifest));

  let text: string;
  const file = args.flags.get("file");
  const inline = args.flags.get("string") ?? args.positional[0];
  if (file) {
    text = readFileSync(file, "utf8");
  } else if (inline && inline.length > 32) {
    text = inline;
  } else {
    text = readFileSync(0, "utf8");
  }

  const decoded = decode(text);
  const prints = flatten(decoded);
  if (prints.length === 0) {
    console.log(
      `\nThat string holds a ${describeKind(decoded)}, which carries no entities to audit.`,
    );
    return;
  }

  // Additive by construction: without --rate the loop below does exactly what it
  // did before this flag existed, and printAudit is untouched.
  const rateFlag = valueFlag(args, "rate");
  const itemFlag = valueFlag(args, "item");
  const wantDraw = args.flags.has("draw") || args.flags.has("render");

  const drawings: DrawnPrint[] = [];
  const results: AuditResult[] = [];
  for (const { path, bp } of prints) {
    const result = audit(data, index, bp, bp.label ?? path);
    printAudit(result, bp.label ?? path);
    if (rateFlag) reportAgainstTarget(data, result, rateFlag, itemFlag);
    if (wantDraw) {
      drawings.push(drawPrint(data, bp, result));
      results.push(result);
    }
  }

  if (wantDraw) {
    writeDrawing(data, drawings, results, file ?? "a pasted string", args);
  }
}

/**
 * Write the drawing, as a page by default and as a bare SVG on `--svg`.
 *
 * Two formats because two readers want different things: the page carries the
 * legend, the gaps and the audit's shortfall table, and the bare file drops into
 * anything that renders SVG. The geometry is the same string in both.
 */
function writeDrawing(
  data: Data,
  drawings: DrawnPrint[],
  results: AuditResult[],
  source: string,
  args: Args,
): void {
  const bare = args.flags.has("svg");
  const dir = join(PROJECT_ROOT, ".local");
  mkdirSync(dir, { recursive: true });
  const stem = slugify(drawings[0]?.label ?? "blueprint") || "blueprint";
  const out = args.flags.get("out") ?? join(dir, `print-${stem}.${bare ? "svg" : "html"}`);

  const body = bare
    ? drawings.map((d) => d.svg).join("\n")
    : printPage({ drawings, results, snapshot: header(data.manifest), source });
  writeFileSync(out, body + "\n");

  const drawn = drawings.reduce((n, d) => n + d.entityCount, 0);
  console.log(heading("Drawn to scale"));
  console.log(`  ${out}`);
  console.log(
    `  ${String(drawn)} entities across ${String(drawings.length)} print` +
      `${drawings.length === 1 ? "" : "s"}, each at its prototype's selection box.`,
  );
  for (const d of drawings) {
    if (d.entityCount === 0) {
      console.log(`  ${d.label}: decodes and holds no entities, so it draws empty.`);
    }
    if (d.guessed.length > 0) {
      console.log(
        `  ${d.label}: ${String(d.guessed.reduce((n, g) => n + g.count, 0))} entities have no ` +
          `selection box in this snapshot and are drawn as one tile (${d.guessed
            .map((g) => g.name)
            .join(", ")}).`,
      );
    }
    if (d.diagonal.length > 0) {
      console.log(
        `  ${d.label}: ${String(d.diagonal.reduce((n, g) => n + g.count, 0))} entities sit on a ` +
          `diagonal direction and are drawn unrotated (${d.diagonal.map((g) => g.name).join(", ")}).`,
      );
    }
  }
}

function printAudit(result: ReturnType<typeof audit>, label: string): void {
  console.log(heading(label));
  const box = result.footprintTiles;
  const size = box
    ? `${Math.round(box.x2 - box.x1)} x ${Math.round(box.y2 - box.y1)} tiles`
    : "empty";
  console.log(`${result.entityCount} entities, ${result.tileCount} tiles, ${size}`);

  const grouped = byRecipe(result);
  if (grouped.length > 0) {
    console.log(sub("What it makes"));
    console.log(
      table(
        [
          { header: "recipe" },
          { header: "machine" },
          { header: "count", align: "right" },
          { header: "beaconed", align: "right" },
          { header: "output/s", align: "right" },
          { header: "product" },
        ],
        grouped.map((g) => [
          g.recipe,
          g.machine,
          String(g.count),
          g.beaconed > 0 ? String(g.beaconed) : "",
          num(g.outputPerSecond),
          g.product,
        ]),
      ),
    );
  }

  const imports = result.flows.filter((f) => f.net < -1e-9);
  const exports = result.flows.filter((f) => f.net > 1e-9);
  const internal = result.flows.filter((f) => Math.abs(f.net) <= 1e-9 && f.produced > 0);

  if (imports.length > 0) {
    console.log(sub("Needs fed in"));
    console.log(
      table(
        [
          { header: "item" },
          { header: "needed/s", align: "right" },
          { header: "made here/s", align: "right" },
          { header: "shortfall/s", align: "right" },
        ],
        imports.map((f) => [f.item, num(f.consumed), num(f.produced), num(-f.net)]),
      ),
    );
  }

  if (exports.length > 0) {
    console.log(sub("Produces for export"));
    console.log(
      table(
        [
          { header: "item" },
          { header: "made/s", align: "right" },
          { header: "used here/s", align: "right" },
          { header: "net/s", align: "right" },
          { header: "per min", align: "right" },
        ],
        exports.map((f) => [
          f.item,
          num(f.produced),
          num(f.consumed),
          num(f.net),
          num(f.net * 60),
        ]),
      ),
    );
  }

  if (internal.length > 0) {
    console.log(sub("Balanced internally"));
    console.log(bullet(internal.map((f) => `${f.item} at ${num(f.produced)}/s`)));
  }

  if (result.beltsPresent.length > 0) {
    console.log(sub("Belts in the print"));
    console.log(
      table(
        [
          { header: "belt" },
          { header: "count", align: "right" },
          { header: "carries/s", align: "right" },
        ],
        result.beltsPresent.map((b) => [b.name, String(b.count), num(b.itemsPerSecond)]),
      ),
    );
    const worst = result.beltsPresent[result.beltsPresent.length - 1];
    const biggest = [...result.flows].sort((a, b) => b.net - a.net)[0];
    if (worst && biggest && biggest.net > worst.itemsPerSecond) {
      console.log(
        `\n  ${biggest.item} leaves at ${num(biggest.net)}/s, which is more than one ` +
          `${worst.name} carries (${num(worst.itemsPerSecond)}/s).`,
      );
    }
  }

  if (result.moduleCensus.length > 0) {
    console.log(sub("Modules"));
    console.log(bullet(result.moduleCensus.map((m) => `${m.count} x ${m.name}`)));
  }

  if (result.qualityModules.length > 0) {
    console.log(
      `\n  ${result.qualityModules.length} module type(s) here are above normal quality.\n` +
        "  Quality raises a module's effect in game, but the scaling is an engine rule and\n" +
        "  does not appear anywhere in the prototype data. Rather than guess at it, the\n" +
        "  figures above use base module effects, so they understate this print.",
    );
  }

  console.log(sub("Power and pollution"));
  console.log(
    `${formatWatts(result.totalWatts)} active + ${formatWatts(result.totalDrainWatts)} idle drain`,
  );
  console.log(`${num(result.pollutionPerMinute)} pollution/min at full load`);

  if (result.unsetRecipes.length > 0) {
    console.log(sub("Machines with no recipe set"));
    console.log(bullet(result.unsetRecipes.map((u) => `${u.count} x ${u.name}`)));
  }

  if (result.unknownEntities.length > 0) {
    console.log(sub("Not in this snapshot"));
    console.log(bullet(result.unknownEntities));
    console.log(
      "\n  These are almost certainly from a mod. The audit above ignored them, so its\n" +
        "  totals are for the vanilla part of the print only.",
    );
  }

  console.log(sub("Full entity census"));
  console.log(
    table(
      [{ header: "entity" }, { header: "count", align: "right" }],
      result.census.map((c) => [c.name, String(c.count)]),
    ),
  );
}

function reportAgainstTarget(
  data: Data,
  result: AuditResult,
  rateFlag: string,
  item: string | null,
): void {
  const target = parseRate(rateFlag);
  const v = judge(data, result, target, item ?? undefined);

  console.log(heading(`Against a target of ${rate(target)} of ${v.item}`));
  if (v.itemChosen) {
    console.log(`  (item chosen as the print's largest net export; override with --item=<name>)`);
  }
  console.log(
    `  the print makes ${rate(v.achievedPerSecond)}, which is ` +
      `${num(v.ratio * 100, 1)}% of the target` +
      (v.shortfallPerSecond > 0 ? `, short by ${rate(v.shortfallPerSecond)}.` : "."),
  );

  // A blueprint is scaled as a unit, so the honest statement is how many of THIS
  // PRINT the target wants, and what that means per machine type. Labelling the
  // column "needed" per recipe invites reading it as "this recipe needs N
  // machines to make the target", which is false for any step that does not make
  // the target item at all: in the shipped platform print, carbonic and oxide
  // crushing make no iron ore, yet they scale with it because the print does.
  const printsNeeded = v.ratio > 0 && Number.isFinite(v.ratio) ? 1 / v.ratio : Infinity;
  console.log(
    `\n  The target wants ${Number.isFinite(printsNeeded) ? num(printsNeeded) : "infinitely many"} ` +
      "of this print. A print scales as a unit, so every step below scales with it,\n" +
      "  including steps that do not make " + v.item + " at all.",
  );
  console.log(sub("Machines at that scale"));
  console.log(
    table(
      [
        { header: "recipe" },
        { header: "machine" },
        { header: "in the print", align: "right" },
        { header: "at that scale", align: "right" },
        { header: "spare", align: "right" },
      ],
      v.steps.map((st) => [
        st.recipe,
        st.machine,
        String(st.present),
        Number.isFinite(st.needed) ? num(st.needed) : "inf",
        Number.isFinite(st.spare)
          ? (st.spare >= 0 ? `+${num(st.spare)}` : num(st.spare))
          : "-",
      ]),
    ),
  );
  console.log(
    "\n  `at that scale` is the print's own machine count multiplied by the scale\n" +
      "  above, so it uses the print's measured rate and adds no calculation of its\n" +
      "  own. A negative spare means the target wants more of this print than it has.\n" +
      "  To size one recipe on its own rather than a whole print, use `bun run ratio`.",
  );

  console.log(sub("Belts"));
  const b = v.belt;
  if (!b.present) {
    console.log("  The print places no belt, so there is no tier to judge.");
  } else {
    console.log(
      `  print uses ${b.present.name} at ${num(b.present.itemsPerSecond)}/s ` +
        `(${b.present.count} placed), which the target loads to ` +
        `${num((b.presentSaturation ?? 0) * 100, 1)}%.`,
    );
    if (b.underTiered && b.needed) {
      console.log(
        `  That is over one belt. ${b.needed.belt["name"]} carries ` +
          `${rate(b.needed.itemsPerSecond)} and would hold it at ` +
          `${num(b.needed.saturation * 100, 1)}%.`,
      );
    } else if (b.underTiered) {
      console.log("  That is over one belt, and no tier in this snapshot carries it alone.");
    } else {
      console.log("  One belt of that tier carries the target.");
    }
  }

  if (v.inserters) {
    const ins = v.inserters;
    console.log(sub("Inserters, at the rotation ceiling"));
    if (ins.present.length > 0) {
      console.log(
        table(
          [
            { header: "in the print" },
            { header: "count", align: "right" },
            { header: "ceiling/s", align: "right" },
          ],
          ins.present.map((x) => [x.name, String(x.count), num(x.ceilingPerSecond)]),
        ),
      );
    } else {
      console.log("  The print places no inserter.");
    }
    console.log(
      `\n  The target spread over ${String(ins.machines)} machines is ` +
        `${rate(ins.perMachinePerSecond)} each. At the rotation ceiling that needs:`,
    );
    console.log(
      table(
        [{ header: "inserter" }, { header: "per machine", align: "right" }],
        ins.neededPerMachine.map((x) => [x.name, String(x.count)]),
      ),
    );
    console.log(
      "\n  A ceiling, not a prediction, exactly as `bun run belt` reports it. Real\n" +
        "  throughput depends on belt chasing and the inserter capacity research,\n" +
        "  neither of which is a prototype fact, so this is a floor on the count\n" +
        "  rather than a number to build to.",
    );
  }
}

async function cmdState(args: Args): Promise<void> {
  // `--save=game 4` and `--save "game 4"` both reach here: the parser stores a
  // valueless flag as "true", in which case the name is the next positional.
  // N4: with no --save, read the newest save on disk, which is what the README
  // promises and what "save in game, then ask" actually needs.
  const flagged = args.flags.get("save");
  const named = flagged && flagged !== "true" ? flagged : args.positional.join(" ");
  const newest = named.trim() ? null : newestSave();
  const save = named.trim() || newest?.name || "";
  if (newest) {
    console.log(`No save named, using the newest: "${newest.name}" (${newest.mtime.toISOString().slice(0, 16).replace("T", " ")})`);
  }
  if (!save.trim()) {
    throw new Error(
      "No save found to read. Name one with --save=<name>, or set FACTORIO_USERDATA\n" +
        "to the directory holding saves/. The save is copied into this project and\n" +
        "read there; the original is never opened.",
    );
  }
  const top = Number(args.flags.get("top") ?? "10");
  const forceName = args.flags.get("force") ?? "player";

  const state = await readState({ save: String(save) });
  const manifest = readManifest();
  console.log("");
  console.log(header(manifest));
  console.log(
    `save: ${state.save.name} at tick ${String(state.save.tick)} ` +
      `(${state.save.hoursPlayed.toFixed(1)} h played), ` +
      `surfaces: ${state.save.surfaces.join(", ")}`,
  );

  const force = state.forces[forceName];
  if (!force) {
    const names = Object.keys(state.forces).join(", ");
    throw new Error(`No force called "${forceName}" in this save. Forces: ${names}.`);
  }

  console.log(heading(`Research, force "${forceName}"`));
  const researchedCount = force.technologies.researched.length;
  console.log(
    `  ${researchedCount} technologies researched.  ` +
      `current: ${force.technologies.current ?? "(nothing being researched)"}`,
  );
  if (force.technologies.queue.length > 0) {
    console.log(`  queue: ${force.technologies.queue.join(" -> ")}`);
  }

  // Made and used are two columns, not one. They were one until U7, and the
  // one they were was consumption printed under a production heading: the
  // engine's item statistics call production `input_counts`, and this table
  // read `output`. A saturated line and an idle one looked identical.
  const items = Object.entries(force.production.item)
    .map(([name, f]) => ({ name, r: flowOf(f) }))
    .sort((a, b) => b.r.producedPerMinute - a.r.producedPerMinute)
    .slice(0, top);
  console.log(heading(`Top ${items.length} items by production`));
  console.log(
    table(
      [
        { header: "item" },
        { header: "made/min", align: "right" },
        { header: "used/min", align: "right" },
        { header: "spare/min", align: "right" },
        { header: "made total", align: "right" },
        { header: "used total", align: "right" },
      ],
      items.map(({ name, r }) => [
        name,
        r.producedPerMinute.toFixed(1),
        r.consumedPerMinute.toFixed(1),
        r.headroomPerMinute.toFixed(1),
        String(r.produced),
        String(r.consumed),
      ]),
    ),
  );

  const fluids = Object.entries(force.production.fluid)
    .map(([name, f]) => ({ name, r: flowOf(f) }))
    .sort((a, b) => b.r.producedPerMinute - a.r.producedPerMinute)
    .slice(0, top);
  if (fluids.length > 0) {
    console.log(heading(`Top ${fluids.length} fluids by production`));
    console.log(
      table(
        [
          { header: "fluid" },
          { header: "made/min", align: "right" },
          { header: "used/min", align: "right" },
          { header: "made total", align: "right" },
        ],
        fluids.map(({ name, r }) => [
          name,
          r.producedPerMinute.toFixed(1),
          r.consumedPerMinute.toFixed(1),
          String(r.produced),
        ]),
      ),
    );
  }

  const machines = Object.entries(force.machines).sort((a, b) => b[1] - a[1]);
  const machineTotal = machines.reduce((n, [, c]) => n + c, 0);
  console.log(heading(`Machines placed (${String(machineTotal)} total)`));
  console.log(
    table(
      [{ header: "prototype" }, { header: "count", align: "right" }],
      machines.map(([name, count]) => [name, String(count)]),
    ),
  );

  const surf = state.save.surfaceState;
  if (surf && surf.length > 0) {
    console.log(heading("Surfaces"));
    console.log(
      table(
        [
          { header: "surface" },
          { header: "evolution", align: "right" },
          { header: "pollution", align: "right" },
        ],
        surf.map((x) => [
          x.surface,
          x.evolution === null || x.evolution === undefined ? "-" : pct(x.evolution),
          x.pollution === null || x.pollution === undefined ? "-" : num(x.pollution),
        ]),
      ),
    );
    console.log(
      "\n  Evolution is the enemy force's own factor for that surface, and pollution\n" +
        "  is the surface total. Both copied from the game, neither computed here.",
    );
  }

  const logi = force.logistic;
  if (logi && Object.keys(logi).length > 0) {
    const items = Object.entries(logi).sort((a, b) => b[1] - a[1]).slice(0, top);
    console.log(heading(`In your logistic network, top ${items.length} of ${Object.keys(logi).length}`));
    console.log(
      table(
        [{ header: "item" }, { header: "count", align: "right" }],
        items.map(([name, n]) => [name, String(n)]),
      ),
    );
  }

  console.log(
    "\n  Rates are the game's own one-hour average, in items per minute. Totals are\n" +
      "  cumulative since the map was created. Nothing was written to your Factorio\n" +
      "  directories: the save was copied into this project and read from the copy.",
  );
}


/**
 * A flag that needs a value.
 *
 * The parser stores `--for` with no `=` as the string "true", so a bare
 * `--for carbon-fiber` used to fall through silently and print the plain table.
 * A wrong answer that looks like a right one is the worst failure available, so
 * this errors with the syntax instead.
 */
function valueFlag(args: Args, name: string): string | null {
  const v = args.flags.get(name);
  if (v === undefined) return null;
  if (v === "true") {
    // The parser stores a valueless flag as "true", which once made a bare
    // `--for` fall through and print the wrong table (N1). Erroring is the point:
    // a wrong answer that looks like a right one is the worst failure available.
    throw new Error(
      `--${name} needs a value, written with an equals sign: --${name}=<value>`,
    );
  }
  return v;
}

/** Pack counts are whole packs in vanilla; `num` would render 500 as "500.0". */
function packCount(n: number): string {
  return Number.isInteger(n) ? String(n) : num(n);
}

/**
 * The state file to answer from: the one named, or the newest save read so far.
 *
 * Naming a file by hand every time is friction that has nothing to do with the
 * question being asked, so with no flag this falls back to whatever save is
 * newest on disk, autosaves included.
 */
function requireState(args: Args): GameState {
  const named = valueFlag(args, "save");
  if (named) {
    const s = readStateFile(named);
    if (!s) {
      throw new Error(
        `No state on file for "${named}". Read it first:\n  bun run state --save="${named}"`,
      );
    }
    return s;
  }
  const newest = newestSave();
  if (newest) {
    const s = readStateFile(newest.name);
    if (s) return s;
    throw new Error(
      `Your newest save is "${newest.name}" but no state has been read from it yet:\n` +
        `  bun run state --save="${newest.name}"`,
    );
  }
  throw new Error("No save found. Name one with --save=<name>, or set FACTORIO_USERDATA.");
}

function stateHeader(state: GameState): string {
  const when = state.save.readAt.slice(0, 16).replace("T", " ");
  return (
    `state: save "${state.save.name}" at tick ${String(state.save.tick)} ` +
    `(${state.save.hoursPlayed.toFixed(1)} h played), read ${when}`
  );
}

function cmdNext(args: Args): void {
  const data = load();
  const forceName = args.flags.get("force") ?? "player";
  const state = requireState(args);

  console.log(header(data.manifest));
  console.log(stateHeader(state));

  const forItem = valueFlag(args, "for");
  if (forItem) {
    cmdNextFor(data, state, forceName, forItem);
    return;
  }

  const r = researchable(data, state, forceName);
  console.log(
    `\n${r.researchedCount} of ${r.totalCount} technologies researched. ` +
      `${r.available.length} researchable right now.`,
  );

  const research = state.forces[forceName]?.research;
  const labSpeed = research ? 1 + research.labSpeedModifier : null;
  if (research) {
    const cur = state.forces[forceName]?.technologies.current;
    console.log(
      `  Lab speed bonus ${pct(research.labSpeedModifier)}, so a lab runs at ` +
        `${num(labSpeed!)}x base` +
        (research.labProductivityBonus > 0
          ? `, productivity ${pct(research.labProductivityBonus)}`
          : "") +
        ".",
    );
    if (cur && research.progress !== null) {
      console.log(`  ${cur} is ${num(research.progress * 100, 1)}% done.`);
    }
  }

  if (r.unknownToSnapshot.length > 0) {
    console.log(sub("Researched in the save but absent from this snapshot"));
    console.log(bullet(r.unknownToSnapshot));
    console.log(
      "\n  These are reported rather than dropped. A save made on another version,\n" +
        "  or with mods, can carry names this vanilla snapshot has never heard of.",
    );
  }

  const limit = Number(args.flags.get("top") ?? "25");
  const shown = r.available.slice(0, limit);
  console.log(heading(`Researchable now, cheapest first (${shown.length} of ${r.available.length})`));
  console.log(
    table(
      [
        { header: "technology" },
        { header: "lab s", align: "right" },
        { header: "yours", align: "right" },
        { header: "opens", align: "right" },
        { header: "science packs" },
        { header: "unlocks" },
      ],
      shown.map((c) => {
        const packs = [...c.cost.packs.entries()]
          .map(([name, n]) => `${packCount(n)} ${name.replace(/-science-pack$/, "")}`)
          .join(", ");
        const cost = c.cost.trigger && c.cost.packs.size === 0
          ? c.cost.trigger
          : c.cost.formula
            ? `formula ${c.cost.formula}`
            : packs || "(none)";
        const unlocks = c.unlocksRecipes.length > 0
          ? c.unlocksRecipes.slice(0, 3).join(", ") +
            (c.unlocksRecipes.length > 3 ? `, +${c.unlocksRecipes.length - 3}` : "")
          : "(no recipe)";
        const labs = c.cost.formula || c.cost.labSeconds === 0 ? "-" : num(c.cost.labSeconds);
        const real =
          labSpeed && c.cost.labSeconds > 0 && !c.cost.formula
            ? num(c.cost.labSeconds / labSpeed)
            : "-";
        return [c.tech.name, labs, real, String(c.opens), cost, unlocks];
      }),
    ),
  );

  console.log(
    "\n  `opens` is how many further technologies become researchable once this one\n" +
      "  is done. `lab s` is at speed 1; `yours` divides by your actual lab speed,\n" +
      "  read from the save. Both are per lab, before you multiply by how many you\n" +
      "  have running.\n" +
      "  For a specific goal: bun run next --for=electric-furnace",
  );
}

function cmdNextFor(data: Data, state: GameState, forceName: string, query: string): void {
  const index = new RecipeIndex(data);
  const techs = data.technologies();

  // The query is a technology name if the tree knows it, otherwise an item.
  let target: string | null = null;
  if (techs.has(query)) target = query;

  if (!target) {
    const product = resolveProduct(data, query);
    const gate = gateFor(data, index, state, forceName, product);
    if (gate.availableFromStart && gate.options.length === 0) {
      console.log(`\n${product} needs no research: it is available from the start.`);
      return;
    }
    if (!gate.best) {
      console.log(`\nNothing in this snapshot unlocks ${product}.`);
      return;
    }
    target = gate.best;
    console.log(`\n${product} is gated by ${target} (via ${gate.options[0]!.viaRecipe}).`);
    if (gate.options.length > 1) {
      console.log(
        bullet(
          gate.options
            .slice(1, 5)
            .map((o) => `also unlocked by ${o.tech}, ${o.remaining} still to research`),
        ),
      );
    }
  }

  const path = pathFromHere(data, state, forceName, target);
  if (path.alreadyDone) {
    console.log(`\n${target} is already researched in this save. Nothing to do.`);
    return;
  }
  if (path.remaining.length === 0) {
    console.log(`\n${target} has no unresearched prerequisites left.`);
    return;
  }

  console.log(heading(`Path to ${target}: ${path.remaining.length} technologies left`));
  console.log(
    table(
      [
        { header: "#", align: "right" },
        { header: "technology" },
        { header: "lab s", align: "right" },
        { header: "science packs" },
      ],
      path.remaining.map((t, i) => {
        const c = costOf(t);
        const packs = [...c.packs.entries()]
          .map(([name, n]) => `${packCount(n)} ${name.replace(/-science-pack$/, "")}`)
          .join(", ");
        const cost = c.trigger && c.packs.size === 0
          ? c.trigger
          : c.formula
            ? `formula ${c.formula}`
            : packs || "(none)";
        const labs = c.formula || c.labSeconds === 0 ? "-" : num(c.labSeconds);
        return [String(i + 1), t.name, labs, cost];
      }),
    ),
  );

  const totals = totalCost(path.remaining);
  console.log(sub("Totals for what is left"));
  console.log(
    table(
      [{ header: "science pack" }, { header: "count", align: "right" }],
      [...totals.packs.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => [name, packCount(n)]),
    ),
  );
  console.log(`\n  ${packCount(totals.labSeconds)} lab-seconds at speed 1.`);
  if (totals.triggered.length > 0) {
    console.log(`  Unlocked by doing, not by science: ${totals.triggered.join(", ")}`);
  }
  if (totals.infinite.length > 0) {
    console.log(`  Infinite, cost is a formula and is not in the total: ${totals.infinite.join(", ")}`);
  }
}

function cmdPower(args: Args): void {
  const data = load();
  const forceName = args.flags.get("force") ?? "player";
  const state = requireState(args);

  console.log(header(data.manifest));
  console.log(stateHeader(state));

  const r = powerReport(data, state, forceName);

  console.log(heading("Generation, at full output"));
  console.log(
    table(
      [
        { header: "source" },
        { header: "count", align: "right" },
        { header: "each", align: "right" },
        { header: "total", align: "right" },
        { header: "derived from" },
      ],
      r.generation.map((g) => [
        g.name,
        String(g.count),
        formatWatts(g.each),
        formatWatts(g.total),
        g.derivation,
      ]),
    ),
  );

  if (r.solar) {
    console.log(sub("Solar over a day-night cycle"));
    if (r.solar.averageFactor !== null && r.solar.curve) {
      const c = r.solar.curve;
      console.log(
        `  ${r.solar.count} panels, ${formatWatts(r.solar.peakTotal)} at peak, ` +
          `${formatWatts(r.solar.averageTotal!)} averaged over the cycle ` +
          `(factor ${num(r.solar.averageFactor, 3)}).`,
      );
      console.log(
        `  Cycle ${String(c.ticksPerDay)} ticks. Curve read from the surface: ` +
          `dusk ${c.dusk}, evening ${c.evening}, morning ${c.morning}, dawn ${c.dawn}, ` +
          `solar multiplier ${c.solarPowerMultiplier}.`,
      );
      console.log(
        "  Lit from dawn round through 0 to dusk, dark from evening to morning,\n" +
          "  linear between, so the two ramps average a half. That is the whole rule.",
      );
    } else {
      console.log(
        `  ${r.solar.count} panels, ${formatWatts(r.solar.peakTotal)} at peak. ` +
          "Average not reported.",
      );
      console.log(
        "  The day curve is a runtime surface property, not a prototype field, and\n" +
          "  this state file predates its collection. Re-read the save to get it:\n" +
          "    bun run state --save=<name>",
      );
    }
  }

  if (r.steam) {
    const s = r.steam;
    console.log(sub("Steam chain"));
    console.log(
      `  ${s.boilers} boilers make ${num(s.steamPerBoiler)}/s of steam each; ` +
        `${s.engines} engines burn ${num(s.steamPerEngine)}/s each.`,
    );
    console.log(
    `  One boiler feeds ${num(s.ratio)} engines, so ${s.boilers} feed ${packCount(s.enginesFed)}.`,
  );
    const short = s.enginesFed < s.engines;
    console.log(
      short
        ? `  You are boiler bound: ${s.engines} engines are built and only ${packCount(s.enginesFed)} can be fed.`
        : `  Boilers are sufficient for the engines built (${packCount(s.enginesFed)} >= ${s.engines}).`,
    );
    console.log(`  Boilers draw ${formatWatts(s.boilerFuelDraw)} of chemical fuel at full tilt.`);
    console.log(`  Derivation: ${s.derivation}`);
  }

  if (r.accumulators) {
    const a = r.accumulators;
    console.log(sub("Accumulators"));
    console.log(
      `  ${a.count} holding ${num(a.capacity * a.count / 1e6)} MJ, ` +
        `discharging at up to ${formatWatts(a.outputLimit * a.count)}.`,
    );
  }

  const el = state.forces[forceName]?.electric;
  if (el) {
    const prod = Object.entries(el.production).sort((a, b) => b[1] - a[1]);
    const cons = Object.entries(el.consumption).sort((a, b) => b[1] - a[1]);
    const prodTotal = prod.reduce((n, [, w]) => n + w, 0);
    const consTotal = cons.reduce((n, [, w]) => n + w, 0);
    console.log(heading(`Delivered, averaged over the last hour (${el.networks} networks)`));
    console.log(
      table(
        [
          { header: "source" },
          { header: "produced", align: "right" },
          { header: "consumer" },
          { header: "consumed", align: "right" },
        ],
        Array.from({ length: Math.max(prod.length, Math.min(cons.length, 10)) }, (_, i) => [
          prod[i]?.[0] ?? "",
          prod[i] ? formatWatts(prod[i]![1]) : "",
          cons[i]?.[0] ?? "",
          cons[i] ? formatWatts(cons[i]![1]) : "",
        ]),
      ),
    );
    console.log(
      `  produced ${formatWatts(prodTotal)}, consumed ${formatWatts(consTotal)}` +
        (cons.length > 10 ? `, ${String(cons.length - 10)} smaller consumers not listed` : ""),
    );
    console.log(
      "\n  This is what your grid actually did, copied from the game's own electric\n" +
        "  network statistics, not computed here. Compare it with the ceiling below:\n" +
        "  the gap is duty cycle, the fraction of the time your machines are busy.",
    );
  }

  console.log(heading("Draw, every machine running at once"));
  console.log(
    table(
      [
        { header: "machine" },
        { header: "count", align: "right" },
        { header: "each", align: "right" },
        { header: "drain each", align: "right" },
        { header: "total", align: "right" },
      ],
      r.consumption.map((c) => [
        c.name,
        String(c.count),
        formatWatts(c.each),
        formatWatts(c.drainEach),
        formatWatts(c.total),
      ]),
    ),
  );

  if (r.perEvent.length > 0) {
    console.log(sub("Draws per event, not per second"));
    console.log(
      table(
        [
          { header: "machine" },
          { header: "count", align: "right" },
          { header: "per event", align: "right" },
          { header: "field" },
          { header: "idle drain each", align: "right" },
        ],
        r.perEvent.map((e) => [
          e.name,
          String(e.count),
          e.joules >= 1e6 ? `${num(e.joules / 1e6)} MJ` : `${num(e.joules / 1000)} kJ`,
          e.field,
          formatWatts(e.drainEach),
        ]),
      ),
    );
    console.log(
      "\n  Their idle drain is in the total above, because it is paid every tick.\n" +
        "  The per-event cost is not, because turning it into watts needs a rate of\n" +
        "  swings or shots per second that no prototype declares. Same wall as the\n" +
        "  inserter throughput figure, and it is not worth guessing past.",
    );
  }

  // Nameplate generation counts every engine built. If the boilers cannot make
  // enough steam for them, that figure is a fiction, so the steam-limited number
  // is computed and it is the one the balance is drawn against. The derivation
  // lives in power.ts so the advisor draws against the same figure.
  const eff = effectiveGeneration(r);
  const gen = eff.solarAveraged;
  const effective = eff.effective;
  const steamCapped = eff.starvedEngines > 0 ? gen - effective : 0;

  const rows: Array<[string, string]> = [["generation, nameplate peak", formatWatts(r.generationTotal)]];
  if (r.solar?.averageTotal != null) {
    rows.push(["generation, solar averaged", formatWatts(gen)]);
  }
  if (steamCapped > 0) {
    rows.push(["generation, steam limited", formatWatts(effective)]);
  }
  rows.push(["draw, everything running", formatWatts(r.consumptionTotal)]);
  rows.push(["of which idle drain", formatWatts(r.drainTotal)]);
  const headroom = effective - r.consumptionTotal;
  rows.push([headroom >= 0 ? "headroom" : "shortfall", formatWatts(Math.abs(headroom))]);

  console.log(sub("Balance"));
  const width = Math.max(...rows.map((x) => x[0].length));
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(width)}  ${value}`);
  }
  if (steamCapped > 0) {
    console.log(
      `\n  The steam-limited line is the one that matters: ${r.steam!.engines - Math.floor(r.steam!.enginesFed)} ` +
        "engines have no boiler behind them, so their nameplate output is a fiction.",
    );
  }

  if (r.unknown.length > 0) {
    console.log(sub("In the save but not in this snapshot"));
    console.log(bullet(r.unknown));
  }

  const classes = state.save.censusClasses?.length;
  console.log(
    (r.fromEngine
      ? "\n  Draw figures are the engine's own resolved values, copied rather than\n" +
        "  inferred: a radar declaring no drain resolves to zero, an assembling\n" +
        "  machine declaring none resolves to a thirtieth of its usage, and no\n" +
        "  single rule gives both.\n"
      : "\n  This state file predates the engine's resolved figures, so drain is\n" +
        "  inferred from the prototype and is wrong for classes like radar and\n" +
        "  lamp. Re-read the save to fix it: bun run state\n") +
      (classes ? `  The census covered ${String(classes)} entity classes, every one the game\n  declares with an energy source of any kind.\n` : "") +
      "\n  Draw is a ceiling: every machine running at once, which no base does.\n" +
      "  Idle drain applies whatever the machine is doing." +
      (el
        ? " What your grid actually\n  delivered is in the Delivered section, so nothing here is nameplate-only."
        : " Generation is nameplate\n  capacity, not what your grid delivered; re-read the save to get the real\n  figures, which this state file predates.") +
      "\n  Every watt in the generation table is derived from the prototype fields\n" +
      "  named in its `derived from` column.",
  );
}


function cmdGen(args: Args): void {
  const data = load();
  const index = new RecipeIndex(data);
  const query = args.positional.join("-");
  if (!query) throw new Error('Usage: bun run gen <item> --rate=<n>   e.g. bun run gen electronic-circuit --rate=45');

  const rateFlag = valueFlag(args, "rate");
  if (!rateFlag) throw new Error("gen needs a target: --rate=<n[/s|/m|/h]>");
  const target = parseRate(rateFlag);
  const product = resolveProduct(data, query);

  console.log(header(data.manifest));

  // One step only. Every ingredient is declared raw so the solver stops at the
  // first recipe instead of expanding a chain, which is what makes this a row
  // rather than a factory.
  const recipe = index.defaultFor(product);
  if (!recipe) {
    throw new Error(`Nothing makes ${product}: it is a raw input, so there is no step to lay out.`);
  }
  const raw = new Set(recipe.ingredients.map((i) => i.name));
  const loadout = buildLoadout(data, args.flags);
  const machineFlag = args.flags.get("machine");
  const solution = solve(data, index, product, target, {
    raw,
    loadout,
    ...(machineFlag ? { machine: machineFlag } : {}),
  });

  const step = solution.steps.find((st) => st.product === product);
  if (!step || !step.machine || !step.run) {
    throw new Error(`No machine in this snapshot can run ${recipe.category}, so there is nothing to lay out.`);
  }

  // Machines round UP, so the row meets the target and the overcapacity is
  // stated rather than silently spent (pm#36).
  const exact = step.machineCount;
  const pinned = valueFlag(args, "machines");
  const count = pinned ? Number(pinned) : Math.ceil(exact - 1e-9);
  if (!Number.isFinite(count) || count < 1) throw new Error(`--machines must be a positive whole number.`);

  const perMachine = step.run.outputPerSecond.get(product) ?? 0;
  if (perMachine <= 0) {
    throw new Error(`${step.machine.name} running ${recipe.name} makes no ${product} per second, so a row cannot be sized.`);
  }
  const actual = perMachine * count;
  const overPct = target > 0 ? (actual / target - 1) * 100 : 0;

  const beltProto = beltFor(data, actual, valueFlag(args, "belt") ?? undefined);
  const beltRate = beltProto ? Number(beltProto["speed"]) * 480 : 0;
  const saturation = beltRate > 0 ? actual / beltRate : Infinity;

  // B3: the input side. Ingredient demand comes from the run, so it is the same
  // number the auditor would re-derive, and one input belt is all this row lays.
  const inputs = [...step.run.inputPerSecond.entries()]
    .map(([name, perMachine]) => ({ name, perSecond: perMachine * count }))
    .sort((a, b) => b.perSecond - a.perSecond);
  const inputTotal = inputs.reduce((n, i) => n + i.perSecond, 0);

  // N5: pick the inserter by its rotation ceiling rather than taking the first
  // in the list, which was a basic inserter at 0.84/s against 16/s of demand.
  const perMachineOut = perMachine;
  const perMachineIn = inputTotal / count;
  const need = Math.max(perMachineOut, perMachineIn);
  const ceilings = inserterCeilings(data);
  const inserter =
    (ceilings.find((c) => c.itemsPerSecondCeiling >= need)?.inserter ??
      ceilings[ceilings.length - 1]?.inserter) ?? null;
  const inserterCeiling =
    ceilings.find((c) => String(c.inserter["name"]) === String(inserter?.["name"]))
      ?.itemsPerSecondCeiling ?? 0;

  const label =
    `${product} ${num(actual)}/s (${count} x ${step.machine.name}` +
    (overPct > 0.05 ? `, +${num(overPct, 1)}% over ${num(target)}/s` : "") +
    ")";

  const row = buildRow(data, {
    machine: step.machine,
    machineCount: count,
    recipe: recipe.name,
    belt: beltProto,
    inserter,
    modules: loadout.modules.map((m) => m.name),
    label,
  });

  console.log(heading(`One row: ${count} x ${step.machine.name} making ${product}`));
  console.log(
    table(
      [{ header: "" }, { header: "value", align: "right" }],
      [
        ["recipe", recipe.name],
        ["target", rate(target)],
        ["machines needed, exact", num(exact)],
        [pinned ? "machines pinned" : "machines placed, rounded up", String(count)],
        ["output per machine", rate(perMachine)],
        ["output of the row", rate(actual)],
        [overPct >= 0 ? "overcapacity" : "shortfall", `${num(Math.abs(overPct), 1)}%`],
        ["output belt", beltProto ? `${String(beltProto["name"])} at ${rate(beltRate)}` : "(none placed)"],
        ["output saturation", beltRate > 0 ? `${num(saturation * 100, 1)}%` : "-"],
        ["input needed", rate(inputTotal)],
        ["input saturation, one belt", beltRate > 0 ? `${num((inputTotal / beltRate) * 100, 1)}%` : "-"],
        ["input belts needed", beltRate > 0 ? String(Math.ceil(inputTotal / beltRate)) : "-"],
        ["inserter", inserter ? `${String(inserter["name"])}, ceiling ${rate(inserterCeiling)}` : "(none)"],
        ["footprint", `${String(row.width)} x ${String(row.height)} tiles, ${String(row.entityCount)} entities`],
      ],
    ),
  );

  console.log(sub("Input side"));
  console.log(
    table(
      [
        { header: "ingredient" },
        { header: "per second", align: "right" },
        { header: "one belt at", align: "right" },
      ],
      inputs.map((i) => [
        i.name,
        num(i.perSecond),
        beltRate > 0 ? `${num((i.perSecond / beltRate) * 100, 1)}%` : "-",
      ]),
    ),
  );
  const inputBelts = beltRate > 0 ? Math.ceil(inputTotal / beltRate) : 0;
  if (inputBelts > 1) {
    console.log(
      `\n  WARNING: the row needs ${rate(inputTotal)} in, which is ` +
        `${num((inputTotal / beltRate) * 100, 1)}% of one ${String(beltProto?.["name"])}. ` +
        `That is ${String(inputBelts)} input belts.\n` +
        "  This row lays ONE input lane, so the rest is yours to route: laying several\n" +
        "  is out of scope, because where a second lane goes is a layout opinion and\n" +
        "  this tool has no source for those.",
    );
  }

  if (inserterCeiling > 0 && need > inserterCeiling) {
    console.log(
      `\n  WARNING: no inserter in this snapshot keeps up. The busiest side moves ` +
        `${rate(need)} per machine and the fastest, ${String(inserter?.["name"])}, ` +
        `has a rotation ceiling of ${rate(inserterCeiling)}.\n` +
        "  One per side is what this row lays, so you will need more of them, and a\n" +
        "  ceiling is not a prediction: real throughput is lower still.",
    );
  }

  if (saturation > 1) {
    console.log(
      `\n  WARNING: output is ${num(saturation * 100, 1)}% of one ${String(beltProto?.["name"])}. ` +
        "The row makes more than its output belt carries.\n" +
        "  Pick a faster tier with --belt=<name>, or split the row.",
    );
  }

  if (row.gaps.length > 0) {
    console.log(sub("Gaps, reported rather than guessed"));
    console.log(bullet(row.gaps));
    console.log("\n  These prototypes declare no selection_box, so nothing was placed for them.");
  }

  console.log(
    "\n  One recipe step. A whole chain or a main bus is out of scope: this lays out\n" +
      "  the machines for ONE recipe with an input and an output belt, and nothing\n" +
      "  upstream or downstream of it. Positions come from each prototype's own\n" +
      "  selection_box, and inserters are placed one per machine per side.\n" +
      "  Check it before you build it: bun run bp --rate=" + rateFlag,
  );

  console.log("\nBlueprint string:\n");
  console.log(row.string);

  // Straight off the object the row builder just produced, with no round trip
  // through the encoder: a drawing of what `gen` laid out must be a drawing of
  // THAT, not of whatever a re-decode of its string happens to give back.
  if (args.flags.has("draw") || args.flags.has("render")) {
    const drawn = audit(data, index, row.blueprint, label);
    writeDrawing(data, [drawPrint(data, row.blueprint, drawn)], [drawn], "bun run gen", args);
  }
}

function usage(): void {
  console.log(
    `factorio-advisor: read-only prototype solver and blueprint auditor.

  bun run sync                            refresh the prototype snapshot
  bun run search <text>                   find prototypes by name
  bun run recipe <name>                   a recipe, its makers, its unlock
  bun run ratio <item> --rate=<n>         full production chain
  bun run tech <name> [--path]            cost, prerequisites, research path
  bun run belt [item] --rate=<n>          belt throughput and saturation
  bun run bp --file=<path>                decode and audit a blueprint
  bun run bp --file=<path> --rate=45      judge that print against a target
  bun run state --save "game 4"           live state read from a copy of a save
  bun run next                            what you can research right now
  bun run next --for=<item>               path from here to what unlocks that item
  bun run power                           generation against draw, from your census
  bun run gen <item> --rate=<n>           lay one recipe step out as a placeable row
  bun run advise [--spm=<n>]              where the base stands and what the next step costs
  bun run bus [--save=<name>] [--map]     the belt survey: buses, lanes, saturation, corridors

Flags for ratio:
  --rate=45 | 90/m | 5400/h               target output rate
  --machine=assembling-machine-3          prefer a machine where it fits
  --modules=productivity-module-3x4       modules in every machine
  --beacons=8 --beacon-modules=speed-module-3x2
  --recipe=<product>=<recipe>             override a recipe choice
  --raw=iron-plate,copper-plate           treat these as bought in

Flags for bp:
  --rate=45 | 90/m | 5400/h               judge the print against this output
  --item=<name>                           which product (default: largest export)

Flags for advise:
  --spm=45                                target rate per science pack, per minute
  --force=player                          which force to advise
  --top=18                                how many requirement gaps to list

Flags for state:
  --save="game 4"                         which save to read (copied, never opened)
  --force=player                          which force to report on
  --top=10                                how many items and fluids to list

Nothing here writes to your game. sync and state launch Factorio headless with
their write-data redirected into this project, and state reads a copy of the
save rather than the save itself; every other command reads the snapshot.`,
  );
}


/**
 * The advisor's own command: where the base stands and what the next step costs.
 *
 * It prints nothing the save or the snapshot did not state, and every piece of
 * advice arrives with the measurement that produced it on the line below, so a
 * wrong recommendation can be argued with rather than merely disbelieved.
 */
function cmdAdvise(args: Args): void {
  const data = load();
  const index = new RecipeIndex(data);
  const forceName = args.flags.get("force") ?? "player";
  const state = requireState(args);

  console.log(header(data.manifest));
  console.log(stateHeader(state));

  // Packs per minute, plainly. `parseRate` reads a bare number as per second,
  // which turned `--spm=20` into a 1200/min target and a refactor nobody asked
  // for. The flag's own name says the unit, so it is read that way.
  const spmFlag = valueFlag(args, "spm");
  const spm = spmFlag === null ? undefined : Number(spmFlag.replace(/\/m(in)?$/, ""));
  if (spm !== undefined && (!Number.isFinite(spm) || spm <= 0)) {
    throw new Error(`--spm takes a number of science packs per minute, such as --spm=45.`);
  }
  const r = researchable(data, state, forceName);
  const techs = r.available.map((c) => c.tech);

  const a = advise(data, index, state, techs, { force: forceName, spm });

  console.log(heading("Where you stand"));
  console.log(
    table(
      [
        { header: "science pack" },
        { header: "made/min", align: "right" },
        { header: "used/min", align: "right" },
        { header: "spare/min", align: "right" },
        { header: "made total", align: "right" },
      ],
      a.packs
        .filter((p) => p.everMade || p.rates.consumed > 0)
        .map((p) => [
          p.name === a.limiting ? `${p.name}  <- slowest` : p.name,
          num(p.rates.producedPerMinute, 1),
          num(p.rates.consumedPerMinute, 1),
          num(p.rates.headroomPerMinute, 1),
          String(p.rates.produced),
        ]),
    ),
  );

  if (a.currentResearch) {
    console.log(`\n  researching ${a.currentResearch}.`);
  } else {
    console.log("\n  nothing is being researched.");
  }

  if (a.labs) {
    console.log(
      `  ${a.labs.labs} labs at ${num(a.labs.labSpeed, 2)}x could eat ` +
        `${num(a.labs.capacityPerMinute, 1)} packs/min on ${a.labs.basis} ` +
        `(${num(a.labs.unitSeconds, 0)} s per unit). They ate ${num(a.labs.actualPerMinute, 1)}, ` +
        `which is ${num(a.labs.utilisation * 100, 1)}% of capacity.`,
    );
  }

  if (a.grid) {
    console.log(
      `  grid: ${formatWatts(a.grid.deliveredWatts)} flowed over the last hour against ` +
        `${formatWatts(a.grid.capacityWatts)} the generators can deliver ` +
        `(nameplate ${formatWatts(a.grid.nameplateWatts)}), ` +
        `${formatWatts(a.grid.spareWatts)} spare.`,
    );
  }

  if (a.target) {
    const t = a.target;
    console.log(
      heading(
        `To reach ${num(t.spm, 0)}/min of every pack you already make` +
          (t.derived ? " (twice your best line; set another with --spm=)" : ""),
      ),
    );
    console.log(
      table(
        [
          { header: "science pack" },
          { header: "have/min", align: "right" },
          { header: "to add/min", align: "right" },
        ],
        t.packs.map((p) => [p.name, num(p.havePerMinute, 1), num(p.addPerMinute, 1)]),
      ),
    );

    const gaps = t.requirements.filter((x) => x.deficitPerMinute > 0);
    const shown = gaps.slice(0, Number(args.flags.get("top") ?? "18"));
    console.log(sub(`What that addition needs (${shown.length} of ${gaps.length} gaps)`));
    console.log(
      table(
        [
          { header: "item" },
          { header: "needs/min", align: "right" },
          { header: "spare/min", align: "right" },
          { header: "build for/min", align: "right" },
          { header: "machines", align: "right" },
          { header: "kind" },
        ],
        shown.map((x: Requirement) => [
          x.item,
          num(x.requiredPerMinute, 1),
          num(x.headroomPerMinute, 1),
          num(x.deficitPerMinute, 1),
          x.machines > 0 ? num(x.machines, 1) : "",
          x.raw ? "raw" : "",
        ]),
      ),
    );
    console.log(
      `\n  spare is what the base makes minus what it uses, over the last hour.\n` +
        `  build for is the requirement minus that spare: new capacity, not total.\n` +
        `  Raw rows are ore, fluid and water: the mining end, which no recipe makes.\n` +
        `  About ${t.machinesAdded} machines and ${formatWatts(t.wattsAdded)} in total.`,
    );
    if (t.unresolved.length > 0) {
      console.log(sub("Not resolvable from the snapshot"));
      console.log(bullet(t.unresolved));
    }
    for (const cycle of t.cycles) {
      console.log(`\n  cycle reported, not unrolled: ${cycle.join(" -> ")}`);
    }
  }

  console.log(heading("Advice"));
  if (a.advice.length === 0) {
    console.log("  Nothing crossed a threshold worth naming.");
  }
  for (const [i, item] of a.advice.entries()) {
    console.log(`\n  ${i + 1}. ${item.text}`);
    console.log(`     ${item.because}`);
  }
  console.log(
    `\n  Every line above is derived from the save read at ` +
      `${a.readAt.slice(0, 16).replace("T", " ")} and the snapshot in the header.\n` +
      `  The save has no map in it that this tool can read, so there is no advice\n` +
      `  here about layout, placement or where to put anything.`,
  );
}

/**
 * `bun run bus`: the belt survey, and what it says about the base (C26, C27, C30).
 *
 * The survey is collected by the same save copy the state read uses, so the
 * default path launches the engine once and answers both. `--reuse` re-reads
 * the last survey on disk, which is what a second question about the same save
 * should do. `--map` additionally writes the corridors onto the base map.
 */
async function cmdBus(args: Args): Promise<void> {
  const flagged = args.flags.get("save");
  const named = flagged && flagged !== "true" ? flagged : args.positional.join(" ");
  const newest = named.trim() ? null : newestSave();
  const save = (named.trim() || newest?.name || "").trim();
  if (!save) {
    throw new Error("No save found to read. Name one with --save=<name>.");
  }

  // `--reuse` answers a second question about the same save without launching
  // the engine again. The state file is read by name rather than through
  // `requireState`, because the name may have arrived as a positional.
  const reuse = args.flags.get("reuse") === "true";
  let state: GameState;
  if (reuse) {
    const onFile = readStateFile(save);
    if (!onFile) {
      throw new Error(
        `No state on file for "${save}". Read it first:\n  bun run bus --save="${save}"`,
      );
    }
    state = onFile;
  } else {
    state = await readState({ save, belts: true });
  }

  const surveys = readSurvey(save);
  if (!surveys || surveys.length === 0) {
    throw new Error(
      `No belt survey for "${save}" at ${surveyPath(save)}.\n` +
        `Run without --reuse to collect one: bun run bus --save="${save}"`,
    );
  }

  // A survey and a state file from two different ticks are two different bases,
  // and every saturation figure here divides one by the other. Reported rather
  // than worked around: the save moved while the survey sat on disk, which is
  // exactly what happens when Soushi keeps playing between questions.
  const surveyTick = surveys[0]?.tick ?? 0;
  if (surveyTick !== state.save.tick) {
    throw new Error(
      `The belt survey on file is tick ${String(surveyTick)} and the state is tick ` +
        `${String(state.save.tick)}: two different bases.\n` +
        `Every saturation figure divides a rate from one by a lane count from the other,\n` +
        `so this refuses rather than printing a number nothing supports.\n` +
        `  bun run bus --save="${save}"   collects both from one read.`,
    );
  }

  const data = load();
  console.log(header(data.manifest));
  console.log(stateHeader(state));

  for (const survey of surveys) {
    if (survey.belts.length === 0) continue;
    const report = judgeBus(survey, state, data);
    printBus(report, survey.surface);
    if (args.flags.get("map") === "true") writeBusMap(report, state, survey.surface);
  }
}

function printBus(report: BusReport, surface: string): void {
  console.log(heading(`The belts on ${surface}`));
  console.log(
    indent(1) +
      `${report.beltsSurveyed} belt entities, ${report.runs} straight runs, ` +
      `${report.looseBelts} in runs too short to be a lane ` +
      `(${share(report.looseBelts / Math.max(1, report.beltsSurveyed))} not in a lane).`,
  );

  if (report.buses.length === 0) {
    console.log(indent(1) + "No bus: no cluster of parallel lanes long enough to be one.");
  }
  for (const [i, bus] of report.buses.entries()) {
    const axis = bus.axis === "vertical" ? "north-south" : "east-west";
    console.log(
      sub(
        `Bus ${i + 1}: ${bus.lanes.length} lanes, ${axis}, ` +
          `${Math.abs(bus.to - bus.from).toFixed(0)} tiles, ` +
          `across ${bus.spanFrom.toFixed(0)} to ${bus.spanTo.toFixed(0)}`,
      ),
    );
    console.log(
      table(
        [
          { header: "at", align: "right" },
          { header: "carries" },
          { header: "tiles", align: "right" },
          { header: "slowest tier" },
          { header: "full", align: "right" },
          { header: "note" },
        ],
        bus.lanes
          .slice()
          .sort((a, b) => a.run.fixed - b.run.fixed)
          .map((lane) => [
            lane.run.fixed.toFixed(0),
            lane.item ?? "(empty)",
            lane.run.length.toFixed(0),
            lane.slowestTier,
            share(lane.density),
            lane.pinchTiles > 0 ? `${lane.pinchTiles} slow tiles` : lane.contaminated > 0 ? `${lane.contaminated} mixed` : "",
          ]),
      ),
    );
  }

  if (report.items.length > 0) {
    console.log(heading("What the lanes carry against what you make"));
    console.log(
      table(
        [
          { header: "item" },
          { header: "lanes", align: "right" },
          { header: "carry/min", align: "right" },
          { header: "made/min", align: "right" },
          { header: "used/min", align: "right" },
          { header: "full", align: "right" },
          { header: "using", align: "right" },
        ],
        report.items.map((v) => [
          v.item,
          String(v.lanes),
          num(v.capacityPerMinute, 0),
          num(v.producedPerMinute, 0),
          num(v.consumedPerMinute, 0),
          share(v.density),
          v.capacityPerMinute > 0 ? share(v.producedPerMinute / v.capacityPerMinute) : "",
        ]),
      ),
    );
    console.log(
      bullet([
        "a lane is ONE SIDE of a belt: two lanes of the same item is one full belt.",
        "carry/min is those lanes at the tier actually placed, not the tier you could place.",
        "full is the lane's own occupancy from the engine's transport line contents;",
        "a full lane is held back downstream, an empty one upstream.",
      ]),
    );
  }

  if (report.findings.length > 0) {
    console.log(heading("Findings"));
    for (const [i, f] of report.findings.entries()) {
      console.log(`\n${indent(1)}${i + 1}. ${f.text}\n${indent(2)}${f.because}`);
    }
  }
}

/**
 * The corridors drawn on the base map (C30).
 *
 * Nothing is computed here: `busAreas` converts the clusters the survey already
 * found into the `Area` shape `renderMap` already takes, and the page is the SVG
 * with its legend. The file goes under `.local/`, which is this project's own
 * scratch directory and is gitignored, never into a game directory.
 */
function writeBusMap(report: BusReport, state: GameState, surface: string): void {
  const map = mapOf(state, surface);
  if (!map) {
    console.log(
      `\n${indent(1)}No map in this state file, so no corridors were drawn.\n` +
        `${indent(1)}Re-read the save to collect one: bun run state --save="${state.save.name}"`,
    );
    return;
  }

  const areas = busAreas(report);
  const svg = renderMap(map, {
    base: true,
    points: [{ names: ["train-stop"], colour: "#c9a227", radius: 3 }],
    areas,
    size: 900,
  });

  const dir = join(PROJECT_ROOT, ".local");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `bus-map-${slugify(state.save.name)}-${String(state.save.tick)}.html`);
  writeFileSync(file, busPage(svg, areas, state, surface));
  console.log(`\n${indent(1)}corridors drawn: ${file}`);
}

function busPage(svg: string, areas: Area[], state: GameState, surface: string): string {
  const rows = areas
    .map((a) => `<li><b>${escapeHtml(a.label)}</b><br><span class="c">at ${a.x.toFixed(0)}, ${a.y.toFixed(0)}, ${a.w.toFixed(0)} by ${a.h.toFixed(0)} tiles</span></li>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Bus corridors: ${escapeHtml(state.save.name)}</title>
<style>
  :root { color-scheme: dark; --bg:#14161a; --fg:#d8dde3; --dim:#8b949e; --line:#262b33; }
  body { margin:0; padding:2rem; background:var(--bg); color:var(--fg);
         font:15px/1.6 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 74rem; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  p.meta { color:var(--dim); margin:0 0 2rem; }
  .map { background:#0f1114; border:1px solid var(--line); border-radius:8px; color:#5a6270; }
  ul { list-style:none; padding:0; margin:2rem 0 0;
       display:grid; gap:.75rem; grid-template-columns:repeat(auto-fit,minmax(22rem,1fr)); }
  li { border:1px solid var(--line); border-radius:6px; padding:.75rem 1rem; }
  .c { color:var(--dim); font-size:.85em; }
</style></head>
<body><main>
<h1>Bus corridors on ${escapeHtml(surface)}</h1>
<p class="meta">Save "${escapeHtml(state.save.name)}" at tick ${String(state.save.tick)},
${state.save.hoursPlayed.toFixed(1)} hours played, read ${escapeHtml(state.save.readAt.slice(0, 16).replace("T", " "))}.
Every rectangle is a cluster of parallel belt runs the survey found; nothing here is drawn from a guess,
and no position on this page is advice about where to build.</p>
${svg}
<ul>${rows}</ul>
</main></body></html>
`;
}

/** A share of a whole, which unlike a delta never carries a sign. */
function share(v: number): string {
  return `${num(v * 100, 0)}%`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (command) {
    case "sync":
      await cmdSync();
      break;
    case "search":
      cmdSearch(args);
      break;
    case "recipe":
      cmdRecipe(args);
      break;
    case "ratio":
      cmdRatio(args);
      break;
    case "tech":
      cmdTech(args);
      break;
    case "belt":
      cmdBelt(args);
      break;
    case "bp":
      cmdBp(args);
      break;
    case "state":
      await cmdState(args);
      break;
    case "next":
      cmdNext(args);
      break;
    case "power":
      cmdPower(args);
      break;
    case "gen":
      cmdGen(args);
      break;
    case "advise":
      cmdAdvise(args);
      break;
    case "bus":
      await cmdBus(args);
      break;
    default:
      usage();
      process.exitCode = command === undefined || command === "help" ? 0 : 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
