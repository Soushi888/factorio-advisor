/**
 * The plan, as a thing the dashboard can hold rather than a document beside it.
 *
 * Everything else in this project is derived: the advisor computes what is
 * short and says so. A plan is the one artefact that is written rather than
 * computed, because ordering steps by cost and reversibility, and arguing with
 * what Soushi already decided, is judgment. This file is the contract that lets
 * written judgment sit inside a measured dashboard without either one pretending
 * to be the other.
 *
 * Three rules hold that line.
 *
 * **A step's prose is authored; a step's numbers are not.** Every figure a step
 * wants to show is declared as a path into the state file and read at render
 * time, so a plan written an hour ago shows tonight's numbers or says it cannot.
 * A number typed into the prose is a number that rots; the checks are how a step
 * knows it is half done.
 *
 * **A step points at a place the same way advice does.** `where` is the same
 * shape the advisor's `focus` is, so clicking a step flies the one map to the
 * same coordinates and turns on the same layer. The plan gets the interactive
 * map for free and the map needs to know nothing about plans.
 *
 * **A plan is per save and lives outside the repo.** It is about one person's
 * factory at one tick, it is rewritten as he plays, and `data/plans/` is
 * ignored like the rest of `data/`.
 */

import type { GameState } from "./state.ts";

/**
 * How much of a step has to have happened before it reads as started.
 *
 * A reporting cut-off for wording, not a game fact: production rates move by a
 * fraction of a percent between two reads of the same base, and without this
 * every step would light up as started the moment it was written.
 */
const STARTED_FRACTION = 0.05;

/** A number the dashboard reads out of the state file rather than off the page. */
export interface PlanCheck {
  label: string;
  /** Dotted path into the state file, e.g. `forces.player.machines.boiler`. */
  path: string;
  /** The value that means this step is done. */
  target: number;
  /** Where it stood when the step was written, so progress has a baseline. */
  from?: number;
  /** Fewer is better: a deficit being closed rather than a count being raised. */
  down?: boolean;
  /**
   * Derived, rewritten at every report: this check's value at the PREVIOUS
   * report, so the page can show movement since the last save rather than only
   * movement since the plan was written.
   *
   * `from` is the authored anchor and never moves; this one moves every time,
   * and the two answer different questions. A step that has been running for
   * six reports shows the whole climb against `from` and tonight's step against
   * this.
   */
  atLastReport?: number;
  /**
   * Derived: the tick at which this check first met its target, cleared if it
   * stops meeting it.
   *
   * It means "met since this tick", not "was met once". A base can lose
   * boilers, and a marker that remembered a target met an hour ago would
   * describe a factory that no longer exists. State follows the artifact.
   */
  closedAtTick?: number;
}

/** Where on the map a step happens, in the shape the map's focus already takes. */
export interface PlanPlace {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The layer that explains the place, turned on by the same click. */
  layer?: string;
  label?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  /** What it costs, in machines and items. One line. */
  cost: string;
  /** How reversible it is, in the player's terms. */
  reversible: string;
  /** What it buys. One line, with the number in it. */
  buys: string;
  /** Why it sits where it sits in the order. */
  why: string;
  /** The body, one paragraph per entry. */
  detail: string[];
  where?: PlanPlace;
  checks?: PlanCheck[];
  /** The dashboard section this step belongs beside. */
  section?: string;
}

export interface Plan {
  save: string;
  /** The tick the plan was written against, so a reader can see its age. */
  writtenAtTick: number;
  writtenAt: string;
  /** The one sentence that leads. */
  lead: string;
  /** What the save says that the player's own plan does not. */
  corrections: string[];
  steps: PlanStep[];
  /**
   * Derived: the tick the markers were last rewritten at.
   *
   * Separate from `writtenAtTick` because the age of authored prose and the age
   * of derived numbers are two different facts. A plan written two hours ago
   * whose markers were rewritten on the last save is current in the only sense
   * that matters to a player, and a page that reported one age for both would
   * be lying about its own freshness.
   */
  markersAtTick?: number;
  /** The long form, when one exists beside it. */
  source?: string;
}

/** A step with tonight's numbers in it. */
export interface StepProgress {
  label: string;
  /** Null when the path resolves to nothing: a gap, never a zero. */
  value: number | null;
  from: number | null;
  target: number;
  /** 0 to 1, or null when it cannot be computed. */
  fraction: number | null;
  done: boolean;
  /** This check's value at the previous report, or null on the first one. */
  atLastReport: number | null;
  /** Movement since the previous report, signed, or null when there was none. */
  sinceLastReport: number | null;
  /** The tick this check has been meeting its target since, when it is. */
  closedAtTick: number | null;
}

export interface StepView extends PlanStep {
  progress: StepProgress[];
  /** True when every check that could be read is met. */
  done: boolean;
  /** True when a check moved off its baseline but is not there yet. */
  started: boolean;
}

export interface PlanView extends Omit<Plan, "steps"> {
  steps: StepView[];
  /** How old the plan is against the state it is being shown with. */
  ticksBehind: number;
  /** The tick of the state this view was rendered against. */
  atTick: number;
  /** How old the derived markers are against that state, in ticks. */
  markersBehind: number | null;
}

/**
 * Resolve a dotted path against the state file.
 *
 * Returns null rather than zero for anything missing, because a machine class
 * the census has never heard of and a machine class with none placed are
 * different answers and a plan that shows the second for the first is lying.
 */
export function valueAt(state: GameState, path: string): number | null {
  let node: unknown = state;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "number" && Number.isFinite(node) ? node : null;
}

function progressOf(state: GameState, check: PlanCheck): StepProgress {
  const value = valueAt(state, check.path);
  const from = check.from ?? null;
  let fraction: number | null = null;
  if (value !== null && from !== null && check.target !== from) {
    fraction = Math.max(0, Math.min(1, (value - from) / (check.target - from)));
  } else if (value !== null && check.target !== 0) {
    fraction = Math.max(0, Math.min(1, value / check.target));
  }
  const done = value !== null && (check.down ? value <= check.target : value >= check.target);
  const atLastReport = check.atLastReport ?? null;
  return {
    label: check.label,
    value,
    from,
    target: check.target,
    fraction,
    done,
    atLastReport,
    sinceLastReport: value !== null && atLastReport !== null ? value - atLastReport : null,
    closedAtTick: check.closedAtTick ?? null,
  };
}

export function planView(plan: Plan, state: GameState): PlanView {
  const steps: StepView[] = plan.steps.map((step) => {
    const progress = (step.checks ?? []).map((c) => progressOf(state, c));
    const readable = progress.filter((p) => p.value !== null);
    return {
      ...step,
      progress,
      done: readable.length > 0 && readable.every((p) => p.done),
      // Started means visibly moved, not moved at all: a line that drifts by a
      // tenth of an item a minute between two reads is noise, and a plan that
      // called that progress would light up every step on every read.
      started:
        readable.length > 0 &&
        !readable.every((p) => p.done) &&
        readable.some((p) => p.fraction !== null && p.fraction > STARTED_FRACTION),
    };
  });
  return {
    ...plan,
    steps,
    ticksBehind: Math.max(0, state.save.tick - plan.writtenAtTick),
    atTick: state.save.tick,
    // Null rather than zero when no report has ever rewritten them: never
    // marked and marked at this very tick are different facts, and a page that
    // showed the second for the first would claim a freshness it does not have.
    markersBehind:
      plan.markersAtTick === undefined ? null : Math.max(0, state.save.tick - plan.markersAtTick),
  };
}

/**
 * The fields code is allowed to write into a plan file.
 *
 * Named here rather than inline because the guard below is the whole reason
 * PLAN-1 is safe: an authored plan sitting inside a measured page works only
 * while the measuring half cannot touch the written half. Adding a field to
 * this list is the moment to ask whether it is a number or a sentence.
 */
export const DERIVED_CHECK_FIELDS = ["atLastReport", "closedAtTick"] as const;
export const DERIVED_PLAN_FIELDS = ["markersAtTick"] as const;

/** A plan with every derived marker removed, for comparing what was authored. */
function authoredOnly(plan: Plan): unknown {
  const strip = (o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
    return out;
  };
  const steps = plan.steps.map((step) => ({
    ...step,
    checks: (step.checks ?? []).map((c) => strip(c as unknown as Record<string, unknown>, DERIVED_CHECK_FIELDS)),
  }));
  return { ...strip(plan as unknown as Record<string, unknown>, DERIVED_PLAN_FIELDS), steps };
}

/**
 * True when two plans differ anywhere a human wrote.
 *
 * The comparison is over the whole authored surface rather than over a list of
 * prose fields, because a list would have to be kept in step with the interface
 * and would silently stop covering a field somebody added. Everything that is
 * not a declared derived marker is authored, which is the right default: a new
 * field is a sentence until someone says otherwise.
 */
export function authoredChanged(before: Plan, after: Plan): boolean {
  return JSON.stringify(authoredOnly(before)) !== JSON.stringify(authoredOnly(after));
}

/**
 * Re-derive a plan's completion markers against the state of a new report.
 *
 * Pure: it returns a new plan and touches no disk, so the caller decides whether
 * this read deserves a rewrite. `bun run report` does; `bun run report --page`
 * does not, because that is a redraw of a tick already read and moving the
 * previous-report anchor without a save between two reports would make the
 * marker measure from a moment that is not a report.
 *
 * What moves, and why each one moves when it does:
 *
 * - `closedAtTick` is stamped the first time a check meets its target and
 *   cleared the moment it stops meeting it. The page can then say "done since"
 *   with a tick rather than rendering a finished step as a step, which is the
 *   defect this unit exists for: on 2026-09-21 the boiler step reached 205 of
 *   204 and only said so because its title was rewritten by hand.
 * - `atLastReport` is set to this report's value, for the NEXT report to
 *   measure against. The page renders against the value the previous report
 *   left, which is what "movement since the last report" means, so this call
 *   returns two copies: `render` keeps the old anchor, `persist` carries the new
 *   one. An earlier version returned one plan and advanced it after rendering,
 *   and the falsifier caught it: the page then rendered a step that was closed
 *   with no tick beside it, because the stamp had not landed yet.
 * - `markersAtTick` records the tick all of the above were taken at.
 *
 * A check whose path resolves to nothing is left alone entirely: a missing
 * reading is a gap, and stamping a marker from a gap would invent a fact.
 */
export function advanceMarkers(
  plan: Plan,
  state: GameState,
): { persist: Plan; render: Plan; changed: boolean } {
  const tick = state.save.tick;
  let changed = false;

  const advance = (keepAnchor: boolean) =>
    plan.steps.map((step) => {
      if (!step.checks) return step;
      const checks = step.checks.map((check) => {
        const value = valueAt(state, check.path);
        if (value === null) return check;
        const done = check.down ? value <= check.target : value >= check.target;
        const closedAtTick = done ? (check.closedAtTick ?? tick) : undefined;
        if (closedAtTick !== check.closedAtTick || value !== check.atLastReport) changed = true;
        const next: PlanCheck = { ...check };
        // The two markers move at different moments, which is the whole trick.
        // `closedAtTick` describes THIS report and the page must show it now, so
        // it is stamped in both copies. `atLastReport` is the anchor the NEXT
        // report measures from, so the copy the page renders keeps the value the
        // previous report left and only the persisted copy moves it forward.
        if (!keepAnchor) next.atLastReport = value;
        if (closedAtTick === undefined) delete next.closedAtTick;
        else next.closedAtTick = closedAtTick;
        return next;
      });
      return { ...step, checks };
    });

  const render: Plan = { ...plan, markersAtTick: tick, steps: advance(true) };
  const persist: Plan = { ...plan, markersAtTick: tick, steps: advance(false) };
  if (plan.markersAtTick !== tick) changed = true;
  return { persist, render, changed };
}
