import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, findUserdata } from "../src/paths.ts";
import { readState, type GameState } from "../src/state.ts";
import { buildReport, renderMarkdown, DEFAULT_RATE_THRESHOLD_PER_MIN } from "./report.ts";
import { advise, type Advisory } from "../src/advise.ts";
import type { SectionView } from "../src/sections.ts";
import { load } from "../src/proto.ts";
import { RecipeIndex } from "../src/recipes.ts";
import { researchable } from "../src/next.ts";
import { sections } from "../src/sections.ts";
import { renderPage } from "./page.ts";

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

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
}

/**
 * The advisory for a state, or null when the snapshot cannot answer.
 *
 * A missing or stale snapshot is a reason to report less, never a reason to
 * fail the report: the diff is still true without it. The loop runs unattended,
 * so it says what it could not compute rather than stopping.
 */
function advisoryFor(state: GameState): { advisory: Advisory; views: SectionView[] } | null {
  try {
    const data = load();
    const index = new RecipeIndex(data);
    const techs = researchable(data, state, "player").available.map((c) => c.tech);
    const advisory = advise(data, index, state, techs, { force: "player" });
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
  const state = await readState({ save, quiet: opts.quiet ?? true });
  const tick = state.save.tick;
  mkdirSync(REPORTS_DIR, { recursive: true });

  const base = `${slug(save)}-${String(tick)}`;
  const mdPath = join(REPORTS_DIR, `${base}.md`);
  // Re-reading an unchanged save must not produce a second report: the tick is
  // the identity, which is why the file is named by tick and not by wall clock.
  if (existsSync(mdPath)) return null;

  const previous = previousState(save, tick);
  const derived = advisoryFor(state);
  const report = buildReport(
    state,
    previous,
    "player",
    opts.threshold ?? DEFAULT_RATE_THRESHOLD_PER_MIN,
    derived?.advisory ?? null,
  );
  const stateFile = `data/state/${slug(save)}.json`;

  writeFileSync(mdPath, renderMarkdown(report, stateFile));
  // The archived state drops the map. A report is kept forever and the map is
  // 800 KB of coordinates that the diff never reads; the live state file under
  // `data/state/` keeps it, and that is the one the dashboard renders from.
  const jsonPath = join(REPORTS_DIR, `${base}.json`);
  const { map: _map, ...archived } = state;
  writeFileSync(jsonPath, JSON.stringify(archived, null, 2) + "\n");

  const pagePath = join(REPORTS_DIR, "index.html");
  writeFileSync(
    pagePath,
    renderPage({
      report,
      state,
      stateFile,
      sections: derived?.views ?? [],
      history: historyFor(save).filter((f) => f !== `${base}.md`),
    }),
  );

  return {
    save,
    tick,
    markdown: mdPath,
    json: jsonPath,
    page: pagePath,
    quiet: report.quiet,
    firstForSave: previous === null,
  };
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
