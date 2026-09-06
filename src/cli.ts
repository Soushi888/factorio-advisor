import { readFileSync } from "node:fs";
import { formatWatts } from "./energy.ts";
import { readManifest, sync, type Manifest } from "./dump.ts";
import { load, type Data } from "./proto.ts";
import { RecipeIndex } from "./recipes.ts";
import { machinesFor, multipliers, parseModules, runOne, type ModuleLoadout } from "./machines.ts";
import { parseRate, solve } from "./solve.ts";
import { beltOptions, inserterCeilings } from "./belts.ts";
import { costOf, dependents, labsFor, researchPath, totalCost, unlocksOf } from "./tech.ts";
import { decode, flatten, describeKind } from "./blueprint.ts";
import { audit, byRecipe } from "./audit.ts";
import { newestSave, readState, readStateFile, type GameState } from "./state.ts";
import { gateFor, pathFromHere, researchable } from "./next.ts";
import { powerReport, solarAverageFactor } from "./power.ts";
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

  for (const { path, bp } of prints) {
    const result = audit(data, index, bp, bp.label ?? path);
    printAudit(result, bp.label ?? path);
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

async function cmdState(args: Args): Promise<void> {
  // `--save=game 4` and `--save "game 4"` both reach here: the parser stores a
  // valueless flag as "true", in which case the name is the next positional.
  const flagged = args.flags.get("save");
  const save = flagged && flagged !== "true" ? flagged : args.positional.join(" ");
  if (!save.trim()) {
    throw new Error(
      'Which save? e.g. bun run state --save "game 4"\n' +
        "The save is copied into this project and read there; the original is never opened.",
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

  const items = Object.entries(force.production.item)
    .sort((a, b) => b[1].perMinute - a[1].perMinute)
    .slice(0, top);
  console.log(heading(`Top ${items.length} items produced`));
  console.log(
    table(
      [
        { header: "item" },
        { header: "per min", align: "right" },
        { header: "per s", align: "right" },
        { header: "made total", align: "right" },
        { header: "used total", align: "right" },
      ],
      items.map(([name, f]) => [
        name,
        f.perMinute.toFixed(1),
        (f.perMinute / 60).toFixed(2),
        String(f.output),
        String(f.input),
      ]),
    ),
  );

  const fluids = Object.entries(force.production.fluid)
    .sort((a, b) => b[1].perMinute - a[1].perMinute)
    .slice(0, top);
  if (fluids.length > 0) {
    console.log(heading(`Top ${fluids.length} fluids produced`));
    console.log(
      table(
        [
          { header: "fluid" },
          { header: "per min", align: "right" },
          { header: "made total", align: "right" },
        ],
        fluids.map(([name, f]) => [name, f.perMinute.toFixed(1), String(f.output)]),
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
    throw new Error(
      `--${name} needs a value, written with an equals sign: --${name}=<value>\n` +
        `A bare --${name} was silently ignored before; it is an error now.`,
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
        return [
          c.tech.name,
          c.cost.formula || c.cost.labSeconds === 0 ? "-" : num(c.cost.labSeconds),
          String(c.opens),
          cost,
          unlocks,
        ];
      }),
    ),
  );

  console.log(
    "\n  `opens` is how many further technologies become researchable once this one\n" +
      "  is done. Lab-seconds are at speed 1 before lab speed and productivity, which\n" +
      "  are live game facts this tool does not read.\n" +
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

  const gen = r.solar?.averageTotal !== null && r.solar?.averageTotal !== undefined
    ? r.generationTotal - r.solar.peakTotal + r.solar.averageTotal
    : r.generationTotal;

  // Nameplate generation counts every engine built. If the boilers cannot make
  // enough steam for them, that figure is a fiction, so the steam-limited number
  // is computed and it is the one the balance is drawn against.
  let effective = gen;
  const steamCapped =
    r.steam && r.steam.enginesFed < r.steam.engines
      ? (r.steam.engines - r.steam.enginesFed) *
        (r.generation.find((g) => g.name === r.steam!.name)?.each ?? 0)
      : 0;
  effective -= steamCapped;

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
      "  Idle drain applies whatever the machine is doing. Generation is nameplate\n" +
      "  capacity, not what your grid actually delivered, which is a runtime figure\n" +
      "  this tool does not read. Every watt above is derived from the prototype\n" +
      "  fields named in the `derived from` column.",
  );
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
  bun run state --save "game 4"           live state read from a copy of a save
  bun run next                            what you can research right now
  bun run next --for=<item>               path from here to what unlocks that item
  bun run power                           generation against draw, from your census

Flags for ratio:
  --rate=45 | 90/m | 5400/h               target output rate
  --machine=assembling-machine-3          prefer a machine where it fits
  --modules=productivity-module-3x4       modules in every machine
  --beacons=8 --beacon-modules=speed-module-3x2
  --recipe=<product>=<recipe>             override a recipe choice
  --raw=iron-plate,copper-plate           treat these as bought in

Flags for state:
  --save="game 4"                         which save to read (copied, never opened)
  --force=player                          which force to report on
  --top=10                                how many items and fluids to list

Nothing here writes to your game. sync and state launch Factorio headless with
their write-data redirected into this project, and state reads a copy of the
save rather than the save itself; every other command reads the snapshot.`,
  );
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
    default:
      usage();
      process.exitCode = command === undefined || command === "help" ? 0 : 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
