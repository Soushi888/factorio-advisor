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
  return { label: check.label, value, from, target: check.target, fraction, done };
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
  };
}
