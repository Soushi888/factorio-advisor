import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, findUserdata } from "../src/paths.ts";
// One slug, not two. `bridge/` had its own copy, identical to `src/state.ts`
// today, and the state-only path now depends on the two agreeing forever: a
// state file is found by the advisor spelling and named by the bridge one
// (pm#108).
import { readState, readStateFile, slugify as slug, type GameState } from "../src/state.ts";
import { buildReport, renderMarkdown, DEFAULT_RATE_THRESHOLD_PER_MIN } from "./report.ts";
import { advise, type Advisory } from "../src/advise.ts";
import type { SectionView } from "../src/sections.ts";
import { load } from "../src/proto.ts";
import { RecipeIndex } from "../src/recipes.ts";
import { researchable } from "../src/next.ts";
import { sections } from "../src/sections.ts";
import { renderPage } from "./page.ts";
import { mapModel } from "../src/layers.ts";
import { advanceMarkers, authoredChanged, planView, type Plan, type PlanView } from "../src/plan.ts";
import { Icons } from "../src/icons.ts";
import { bottlenecks, type BottleneckReport } from "../src/bottlenecks.ts";
import { mapOf, recipeBlocks, type Area } from "../src/map.ts";
import { busAreas, judge as judgeBus, readSurvey } from "../src/bus.ts";

/**
 * The loop: Soushi saves, a report appears.
 *
 * This is the only long-running thing in the project, and it is still read-only
 * in the sense that matters. It polls save mtimes, which is a stat call; when
 * one moves it hands off to the existing save-copy read (ADR-6), which copies
 * the save into the project and lets the engine tick the copy. Nothing here
 * opens the player's save, and `find ~/.factorio -newermt` stays empty across a
 * watch, which is the unit's own criterion.
 *
 * Polling rather than an inotify watch, deliberately. Factorio writes a save as
 * a temporary file and renames it, so a naive watcher fires on a partial write
 * and reads a truncated zip. Polling mtime and then requiring it to hold still
 * for one interval means the rename has landed before we touch anything.
 */

const POLL_MS = 3000;
/** A save must stop changing for this long before it is read. */
const SETTLE_MS = 3000;

export const REPORTS_DIR = join(PROJECT_ROOT, "reports");

interface Seen {
  mtimeMs: number;
  size: number;
}

function savesDir(): string {
  const userdata = findUserdata();
  if (!userdata) {
    throw new Error(
      "Could not find the Factorio user directory. Set FACTORIO_USERDATA to the directory holding saves/.",
    );
  }
  return join(userdata, "saves");
}

function scan(dir: string): Map<string, Seen> {
  const out = new Map<string, Seen>();
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".zip")) continue;
    const st = statSync(join(dir, entry));
    out.set(entry.replace(/\.zip$/i, ""), { mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

/** Reports already written for a save, newest first, by the tick in the name. */
function historyFor(save: string): string[] {
  if (!existsSync(REPORTS_DIR)) return [];
  const prefix = `${slug(save)}-`;
  return readdirSync(REPORTS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .sort((a, b) => Number(b.slice(prefix.length, -3)) - Number(a.slice(prefix.length, -3)));
}

/** The state a previous report was written from, if one exists. */
function previousState(save: string, currentTick: number): GameState | null {
  const prior = historyFor(save)
    .map((f) => Number(f.slice(slug(save).length + 1, -3)))
    .filter((t) => Number.isFinite(t) && t < currentTick);
  if (prior.length === 0) return null;
  const path = join(REPORTS_DIR, `${slug(save)}-${String(prior[0]!)}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as GameState;
  } catch {
    return null;
  }
}

export interface ReportWritten {
  save: string;
  tick: number;
  markdown: string;
  json: string;
  page: string;
  quiet: boolean;
  firstForSave: boolean;
  /**
   * What happened to the plan's completion markers on this report.
   *
   * `refused` is the interesting one and it is surfaced rather than swallowed:
   * it means the marker pass would have changed something a human wrote, which
   * is a defect in this code and not a condition to retry.
   */
  markers: MarkerOutcome;
}

/**
 * The advisory for a state, or null when the snapshot cannot answer.
 *
 * A missing or stale snapshot is a reason to report less, never a reason to
 * fail the report: the diff is still true without it. The loop runs unattended,
 * so it says what it could not compute rather than stopping.
 */
function advisoryFor(state: GameState, previous: GameState | null = null): { advisory: Advisory; views: SectionView[] } | null {
  try {
    const data = load();
    const index = new RecipeIndex(data);
    const techs = researchable(data, state, "player").available.map((c) => c.tech);
    // The previous report is what makes paving measurable, and paving is the one
    // consumption the game does not record. Without it refined concrete reads as
    // 155.7/min of spare on a base laying 130 a minute (MAP-2, ADVISE-1).
    const advisory = advise(data, index, state, techs, { force: "player", previous });
    return { advisory, views: sections(data, state, advisory) };
  } catch {
    return null;
  }
}

/** Read a save and write its report. Returns null when that tick already has one. */
export async function reportOn(
  save: string,
  opts: { threshold?: number; quiet?: boolean } = {},
): Promise<ReportWritten | null> {
  // The belt survey rides the same pass, which is MAP-3's one-read-one-tick
  // property bought for 1.66 s on this save (6.43 s against 8.09 s, measured
  // 22:06). It was never a redesign: readState has always written both files
  // from one collector run at one tick, and the 160318 tick gap the map was
  // drawing from was two separate invocations of two different commands.
  const state = await readState({ save, belts: true, quiet: opts.quiet ?? true });
  const tick = state.save.tick;
  mkdirSync(REPORTS_DIR, { recursive: true });

  const base = `${slug(save)}-${String(tick)}`;
  const mdPath = join(REPORTS_DIR, `${base}.md`);
  // Re-reading an unchanged save must not produce a second report: the tick is
  // the identity, which is why the file is named by tick and not by wall clock.
  if (existsSync(mdPath)) return null;

  const previous = previousState(save, tick);
  const derived = advisoryFor(state, previous);
  const report = buildReport(
    state,
    previous,
    "player",
    opts.threshold ?? DEFAULT_RATE_THRESHOLD_PER_MIN,
    derived?.advisory ?? null,
  );
  const stateFile = `data/state/${slug(save)}.json`;
  const jsonPath = join(REPORTS_DIR, `${base}.json`);
  const pagePath = join(REPORTS_DIR, "index.html");

  // Everything is rendered before anything is written (pm#119).
  //
  // The md used to be written first, and the tick guard above refuses any retry
  // once it exists. So a throw anywhere in renderPage burned that tick
  // permanently: every later run saw the md, returned null, and said "nothing
  // new to say" while no page had ever been written. The failure was a missing
  // prototype snapshot, which `protoData` and `bottlenecksFor` both swallow and
  // `modelFor` does not, and the shape of it is what matters rather than the
  // cause: the guard treats the md as proof the report exists, so the md must
  // not exist until it does.
  //
  // The markers move once per report and the page renders from the copy that
  // keeps the previous report's anchor, so the plan write waits here too: a run
  // that throws must not leave the markers advanced for a report nobody has.
  const planned = planForReport(save, state);
  const markdown = renderMarkdown(report, stateFile);
  const page = renderPage({
    report,
    state,
    stateFile,
    sections: derived?.views ?? [],
    history: historyFor(save).filter((f) => f !== `${base}.md`),
    plan: planned.view,
    icons: new Icons(protoData()),
    bottlenecks: bottlenecksFor(state, previous),
    model: modelFor(state, derived?.advisory ?? null),
  });

  // The archived state drops the map's geometry and keeps its paved counts.
  //
  // A report is kept forever and the map is 800 KB of coordinates the diff
  // never reads, so it goes. `paved` stays, and it is a handful of numbers: it
  // is the ONLY record of a consumption the game does not report, and the next
  // report measures the paving rate as the delta against this one. Dropping the
  // whole map put that delta permanently out of reach, which is how refined
  // concrete kept reading as 155.7/min of spare on a base laying 130 a minute.
  const { map: fullMap, ...rest } = state;
  const archived: GameState = {
    ...rest,
    ...(fullMap
      ? { map: fullMap.map((s) => ({ name: s.name, cellTiles: s.cellTiles, bounds: s.bounds, cells: [], ore: [], points: {}, ...(s.paved ? { paved: s.paved } : {}) })) }
      : {}),
  };
  writeFileSync(pagePath, page);
  writeFileSync(jsonPath, JSON.stringify(archived, null, 2) + "\n");
  writeFileSync(mdPath, markdown);
  planned.commit();

  return {
    save,
    tick,
    markdown: mdPath,
    json: jsonPath,
    page: pagePath,
    quiet: report.quiet,
    firstForSave: previous === null,
    markers: planned.markers,
  };
}

/**
 * Redraw `reports/index.html` from the state file already on disk.
 *
 * No engine run and no new report: a report is a statement about a tick, and
 * this is a different view of a tick already read. It exists because the page
 * changes far more often than the base does, and re-reading a save to look at a
 * layout change costs a minute of Factorio start-up for a file that has not
 * moved.
 */
export function rerenderPage(save: string, opts: { threshold?: number } = {}): string | null {
  const state = readStateFile(save);
  if (!state) return null;
  const derived = advisoryFor(state, previousState(save, state.save.tick));
  const report = buildReport(
    state,
    previousState(save, state.save.tick),
    "player",
    opts.threshold ?? DEFAULT_RATE_THRESHOLD_PER_MIN,
    derived?.advisory ?? null,
  );
  const pagePath = join(REPORTS_DIR, "index.html");
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(
    pagePath,
    renderPage({
      report,
      state,
      stateFile: `data/state/${slug(save)}.json`,
      sections: derived?.views ?? [],
      history: historyFor(save).filter((f) => f !== `${slug(save)}-${String(state.save.tick)}.md`),
      plan: planFor(save, state),
      icons: new Icons(protoData()),
      bottlenecks: bottlenecksFor(state, previousState(save, state.save.tick)),
      model: modelFor(state, derived?.advisory ?? null),
    }),
  );
  return pagePath;
}

/**
 * The one map's layers (C33).
 *
 * The bus corridors are included only when a belt survey exists for this save
 * AT THE SAME TICK. A survey from an earlier tick describes a different base,
 * and the corridors would be drawn over a map they no longer match, which is the
 * same trap the `bus` command refuses at the command line.
 */
/**
 * The written plan for a save, with tonight's numbers read into it.
 *
 * Authored rather than derived, which is why it lives in `data/plans/` beside
 * the state files rather than in the repo: it is about one person's factory at
 * one tick. Absent is the normal case and the dashboard simply has no plan
 * section; a malformed one is reported by being absent too, because a plan that
 * half parses would put half a step on the page.
 */
function planFor(save: string, state: GameState): PlanView | null {
  const plan = readPlan(save);
  return plan ? planView(plan, state) : null;
}

/** The plan file for a save, or null when there is none or it does not parse. */
function planPath(save: string): string {
  return join(PROJECT_ROOT, "data", "plans", `${slug(save)}.json`);
}

function readPlan(save: string): Plan | null {
  const path = planPath(save);
  if (!existsSync(path)) return null;
  try {
    const plan = JSON.parse(readFileSync(path, "utf8")) as Plan;
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) return null;
    return plan;
  } catch {
    return null;
  }
}

/**
 * Re-derive the plan's completion markers against this report and write them back.
 *
 * Called once per report, AFTER the page has been rendered from the markers the
 * previous report left. That order is the whole design: the page shows movement
 * since the last report, and this call sets the anchor the next one will measure
 * against. Rendering first also means a crash here leaves a correct page and a
 * plan one report behind, which is the safe direction to fail in.
 *
 * The guard is not a formality. `data/plans/` is authored by hand and the one
 * property that makes an authored plan safe inside a measured page is that code
 * never touches the prose. So the write re-serialises the plan parsed off disk,
 * changes only the declared derived fields, and refuses outright if anything a
 * human wrote differs. A refusal is reported and the report still stands: a
 * stale marker is a small wrong number, a rewritten sentence is a lie about what
 * Soushi decided.
 */
export type MarkerOutcome = "written" | "unchanged" | "absent" | "refused";

export function planForReport(
  save: string,
  state: GameState,
): { view: PlanView | null; markers: MarkerOutcome; commit: () => void } {
  const noop = (): void => {};
  const before = readPlan(save);
  if (!before) return { view: null, markers: "absent", commit: noop };
  const { persist, render, changed } = advanceMarkers(before, state);
  if (!changed) return { view: planView(before, state), markers: "unchanged", commit: noop };
  if (authoredChanged(before, persist)) {
    return { view: planView(before, state), markers: "refused", commit: noop };
  }
  // Computed here, written by the caller once the report has actually been
  // rendered. A run that throws while rendering must not leave the markers
  // advanced for a report that does not exist, which is the same reason the
  // report files are written last (pm#119).
  return {
    view: planView(render, state),
    markers: "written",
    commit: () => writeFileSync(planPath(save), JSON.stringify(persist, null, 2) + "\n"),
  };
}

/**
 * What is holding the factory back, when the snapshot is loadable.
 *
 * Wrapped like `advisoryFor`: the dashboard must render from a state file even
 * on a machine whose prototype dump is missing, and a page with one card fewer
 * is a better answer than no page.
 */
function bottlenecksFor(state: GameState, previous: GameState | null = null): BottleneckReport | null {
  try {
    const data = load();
    return bottlenecks(data, new RecipeIndex(data), state, "player");
  } catch {
    return null;
  }
}

function protoData(): ReturnType<typeof load> | null {
  try {
    return load();
  } catch {
    return null;
  }
}

function modelFor(state: GameState, advisory: Advisory | null): ReturnType<typeof mapModel> | null {
  const surfaceMap = mapOf(state);
  if (!surfaceMap) return null;

  let corridors: Area[] = [];
  const surveys = readSurvey(state.save.name);
  const survey = surveys?.find((s) => s.surface === surfaceMap.name) ?? surveys?.[0];
  // Three outcomes, and the page is told which one rather than being handed an
  // empty array for all three (MAP-3). From MAP-3 on the survey travels inside
  // the state file and stale is unreachable for a fresh read; it stays because
  // a state file written before tonight still has its sidecar, and a layer
  // drawn from another tick is exactly the failure this unit exists to stop.
  const busSurvey: { state: "ok" | "none" | "stale"; tick?: number; stateTick?: number } = !survey
    ? { state: "none" }
    : survey.tick === state.save.tick
      ? { state: "ok", tick: survey.tick, stateTick: state.save.tick }
      : { state: "stale", tick: survey.tick, stateTick: state.save.tick };
  if (busSurvey.state === "ok" && survey) {
    corridors = busAreas(judgeBus(survey, state, load()));
  }

  const adviceAreas: Area[] = [];
  for (const item of advisory?.advice ?? []) {
    if (!item.focus) continue;
    adviceAreas.push({
      x: item.focus.x,
      y: item.focus.y,
      w: item.focus.w,
      h: item.focus.h,
      label: item.text,
      tone: "warn",
    });
  }

  return mapModel({
    state,
    map: surfaceMap,
    data: protoData(),
    icons: new Icons(protoData()),
    busAreas: corridors,
    busSurvey,
    // MAP-4. The blocks are clustered in map.ts beside the power blocks and the
    // ore fields, because grouping by proximity is geometry; the renderer draws
    // what it is handed. The belts come from the same survey the corridors do,
    // so they inherit the tick check rather than needing their own.
    recipeBlocks: recipeBlocks(surfaceMap),
    ...(busSurvey.state === "ok" && survey
      ? { belts: survey.belts.map((b) => ({ x: b.x, y: b.y, lanes: b.lanes })) }
      : {}),
    adviceAreas,
    powerAreas: advisory?.blocks ?? [],
    oreAreas: advisory?.fields?.slice(0, 12) ?? [],
  });
}

export async function watch(opts: { threshold?: number; once?: boolean } = {}): Promise<void> {
  const dir = savesDir();
  const say = (s: string): void => console.log(s);

  say(`Watching ${dir}`);
  say(`  reports  ${REPORTS_DIR}`);
  say(`  rule     a save is read once it has stopped changing for ${SETTLE_MS / 1000}s`);
  say(`  threshold ${opts.threshold ?? DEFAULT_RATE_THRESHOLD_PER_MIN}/min for a production change`);
  say(`  Your saves are never opened in place: each is copied into this project first.`);
  say("");

  let seen = scan(dir);
  const pending = new Map<string, Seen>();

  for (;;) {
    await Bun.sleep(POLL_MS);
    let now: Map<string, Seen>;
    try {
      now = scan(dir);
    } catch {
      continue; // the directory blinked; try again next tick
    }

    for (const [save, st] of now) {
      const before = seen.get(save);
      const changed = !before || before.mtimeMs !== st.mtimeMs || before.size !== st.size;
      if (changed) {
        pending.set(save, st);
        continue;
      }
      const wait = pending.get(save);
      if (!wait) continue;
      if (Date.now() - st.mtimeMs < SETTLE_MS) continue;

      pending.delete(save);
      const at = new Date().toLocaleTimeString();
      say(`[${at}] ${save} changed, reading it`);
      try {
        const written = await reportOn(save, { threshold: opts.threshold ?? undefined });
        if (!written) {
          say(`         same tick as the last report, nothing new to say`);
        } else {
          say(
            `         ${written.markdown}` +
              (written.firstForSave ? "  (first report for this save)" : written.quiet ? "  (quiet: nothing crossed a threshold)" : ""),
          );
          say(`         ${written.page}`);
        }
      } catch (err) {
        say(`         could not read it: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (opts.once) return;
    }
    seen = now;
  }
}
