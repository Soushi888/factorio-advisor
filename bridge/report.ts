import { flowOf, isLegacyFlows, type GameState } from "../src/state.ts";
import type { Advisory } from "../src/advise.ts";

/**
 * What changed since the last time we looked.
 *
 * The whole value of a report loop is that it does not restate the base. Soushi
 * knows he has 1399 solar panels; what he wants told is that eleven appeared and
 * that iron plate fell by 200 a minute. So a report is a diff, and a report with
 * nothing to say says that in one line rather than reprinting the world.
 *
 * `bridge/` may import `src/`; `src/` never imports this (AD-1). The rule is
 * checked by grep in the unit's criteria rather than promised here.
 */

/**
 * Production is noisy: a one-hour rolling average moves by a fraction of a
 * percent constantly, and a report that lists every twitch is a report nobody
 * reads. The threshold is stated in the output rather than buried here, because
 * a number that decides what Soushi is told about should be arguable.
 */
export const DEFAULT_RATE_THRESHOLD_PER_MIN = 60;

export interface Delta<T> {
  name: string;
  before: T;
  after: T;
}

export interface ReportData {
  save: string;
  tick: number;
  previousTick: number | null;
  hoursPlayed: number;
  hoursElapsed: number | null;
  /** Technologies finished since the previous report. */
  researched: string[];
  currentResearch: string | null;
  researchProgress: number | null;
  queue: string[];
  /** Production rate changes, per minute, above the threshold. */
  production: Array<Delta<number>>;
  /** Machine count changes, any size: a placed machine is always news. */
  machines: Array<Delta<number>>;
  power: { produced: number; consumed: number } | null;
  powerDelta: { produced: number; consumed: number } | null;
  evolution: number | null;
  evolutionDelta: number | null;
  pollution: number | null;
  threshold: number;
  /** True when nothing crossed a threshold, which is itself worth saying. */
  quiet: boolean;
  /** True when the rates above are consumption, from a pre-U7 state file. */
  legacyRates: boolean;
  /**
   * True when the previous state measured the other direction, so no production
   * delta is reported. One state file counting what was made against another
   * counting what was used produces a swing that never happened.
   */
  rateBasisChanged: boolean;
  /**
   * The advisory for this save, when one was computed. A report says what
   * moved; the advisory says what to do about it, and the loop is only worth
   * leaving running if it carries both.
   */
  advisory: Advisory | null;
}

/**
 * Production per minute, which is what a report about a factory is about.
 *
 * Until U7 this read the one rate the collector stored, and that rate was
 * consumption: the diff said "iron plate fell 200/min" when what fell was what
 * the base ate. A state file written before that change carries consumption
 * only, so it is read as consumption and the page says which it is.
 */
function ratesOf(state: GameState, force: string): Map<string, number> {
  const out = new Map<string, number>();
  const f = state.forces[force];
  if (!f) return out;
  const legacy = isLegacyFlows(state, force);
  for (const [name, flow] of Object.entries(f.production.item)) {
    const r = flowOf(flow);
    out.set(name, legacy ? r.consumedPerMinute : r.producedPerMinute);
  }
  return out;
}

function machinesOf(state: GameState, force: string): Map<string, number> {
  return new Map(Object.entries(state.forces[force]?.machines ?? {}));
}

function powerOf(state: GameState, force: string): { produced: number; consumed: number } | null {
  const el = state.forces[force]?.electric;
  if (!el) return null;
  const sum = (r: Record<string, number>): number =>
    Object.values(r).reduce((n, w) => n + w, 0);
  return { produced: sum(el.production), consumed: sum(el.consumption) };
}

export function buildReport(
  now: GameState,
  previous: GameState | null,
  force = "player",
  threshold = DEFAULT_RATE_THRESHOLD_PER_MIN,
  advisory: Advisory | null = null,
): ReportData {
  const f = now.forces[force];
  if (!f) throw new Error(`No force "${force}" in ${now.save.name}.`);

  const prevResearched = new Set(previous?.forces[force]?.technologies.researched ?? []);
  const researched = previous
    ? f.technologies.researched.filter((t) => !prevResearched.has(t)).sort()
    : [];

  const nowRates = ratesOf(now, force);
  const prevRates = previous ? ratesOf(previous, force) : new Map<string, number>();
  const production: Array<Delta<number>> = [];
  // A pre-U7 state file measured consumption and a later one measures
  // production. Subtracting one from the other reported iron ore falling
  // 262/min across a save where mining never changed.
  const rateBasisChanged =
    previous !== null && isLegacyFlows(previous, force) !== isLegacyFlows(now, force);
  if (previous && !rateBasisChanged) {
    for (const [name, after] of nowRates) {
      const before = prevRates.get(name) ?? 0;
      if (Math.abs(after - before) >= threshold) production.push({ name, before, after });
    }
    for (const [name, before] of prevRates) {
      if (!nowRates.has(name) && before >= threshold) {
        production.push({ name, before, after: 0 });
      }
    }
  }
  production.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));

  const nowMachines = machinesOf(now, force);
  const prevMachines = previous ? machinesOf(previous, force) : new Map<string, number>();
  const machines: Array<Delta<number>> = [];
  if (previous) {
    const names = new Set([...nowMachines.keys(), ...prevMachines.keys()]);
    for (const name of names) {
      const before = prevMachines.get(name) ?? 0;
      const after = nowMachines.get(name) ?? 0;
      if (before !== after) machines.push({ name, before, after });
    }
  }
  machines.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));

  const power = powerOf(now, force);
  const prevPower = previous ? powerOf(previous, force) : null;

  const surface = now.save.surfaceState?.[0] ?? null;
  const prevSurface = previous?.save.surfaceState?.[0] ?? null;

  const hoursElapsed = previous ? now.save.hoursPlayed - previous.save.hoursPlayed : null;

  return {
    save: now.save.name,
    tick: now.save.tick,
    previousTick: previous?.save.tick ?? null,
    hoursPlayed: now.save.hoursPlayed,
    hoursElapsed,
    researched,
    currentResearch: f.technologies.current,
    researchProgress: f.research?.progress ?? null,
    queue: f.technologies.queue,
    production,
    machines,
    power,
    powerDelta:
      power && prevPower
        ? { produced: power.produced - prevPower.produced, consumed: power.consumed - prevPower.consumed }
        : null,
    evolution: surface?.evolution ?? null,
    evolutionDelta:
      surface?.evolution != null && prevSurface?.evolution != null
        ? surface.evolution - prevSurface.evolution
        : null,
    pollution: surface?.pollution ?? null,
    threshold,
    legacyRates: isLegacyFlows(now, force),
    rateBasisChanged,
    advisory,
    quiet:
      previous !== null &&
      !rateBasisChanged &&
      researched.length === 0 &&
      production.length === 0 &&
      machines.length === 0,
  };
}

/** The advisory, as markdown. Empty when no advisory was computed. */
function adviceLines(r: ReportData): string[] {
  const a = r.advisory;
  if (!a || a.advice.length === 0) return [];
  const lines: string[] = ["## What to do about it", ""];
  for (const item of a.advice) {
    lines.push(`- **${item.text}**  `);
    lines.push(`  ${item.because}`);
  }
  lines.push("");
  if (a.limiting && a.researchPerMinute !== null) {
    lines.push(
      `Science is running at ${a.researchPerMinute.toFixed(1)}/min, set by ${a.limiting}.` +
        (a.labs ? ` Labs are at ${(a.labs.utilisation * 100).toFixed(1)}% of what they could eat.` : ""),
    );
    lines.push("");
  }
  return lines;
}

function signed(v: number, places = 1): string {
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(places)}`;
}

function mw(w: number): string {
  return `${(w / 1e6).toFixed(1)} MW`;
}

/** The prose report. A first report describes; every later one only differs. */
export function renderMarkdown(r: ReportData, stateFile: string): string {
  const lines: string[] = [];
  const when = `tick ${r.tick}, ${r.hoursPlayed.toFixed(1)} h played`;
  lines.push(`# ${r.save}: ${when}`);
  lines.push("");

  if (r.previousTick === null) {
    lines.push(
      `First report for this save. Nothing to compare against yet, so this one describes rather than differs; the next will name only what moved.`,
    );
    lines.push("");
    lines.push(`- ${r.currentResearch ?? "nothing"} being researched` +
      (r.researchProgress !== null ? `, ${(r.researchProgress * 100).toFixed(1)}% done` : ""));
    if (r.power) lines.push(`- grid delivering ${mw(r.power.produced)}, drawing ${mw(r.power.consumed)}`);
    if (r.evolution !== null) lines.push(`- evolution ${(r.evolution * 100).toFixed(1)}%`);
    lines.push("");
    lines.push(...adviceLines(r));
    lines.push(`Source: \`${stateFile}\`.`);
    return lines.join("\n") + "\n";
  }

  const gap = r.hoursElapsed !== null ? `${r.hoursElapsed.toFixed(2)} h of game time` : "an unknown gap";
  lines.push(`Since tick ${r.previousTick}, ${gap}.`);
  lines.push("");
  lines.push(...adviceLines(r));

  if (r.quiet) {
    lines.push(
      `Nothing crossed a threshold. No technology finished, no machine was placed or removed, and no item's rate moved by ${r.threshold}/min or more.`,
    );
    lines.push("");
    lines.push(...adviceLines(r));
    lines.push(`Source: \`${stateFile}\`.`);
    return lines.join("\n") + "\n";
  }

  if (r.researched.length > 0) {
    lines.push(`## Research finished`);
    lines.push("");
    for (const t of r.researched) lines.push(`- ${t}`);
    lines.push("");
    lines.push(
      `Now researching ${r.currentResearch ?? "nothing"}` +
        (r.researchProgress !== null ? `, ${(r.researchProgress * 100).toFixed(1)}% done` : "") +
        (r.queue.length > 1 ? `, then ${r.queue.slice(1).join(" then ")}` : "") +
        ".",
    );
    lines.push("");
  }

  if (r.machines.length > 0) {
    lines.push(`## Machines placed and removed`);
    lines.push("");
    for (const m of r.machines) {
      const d = m.after - m.before;
      lines.push(`- ${m.name}: ${signed(d, 0)} (${m.before} to ${m.after})`);
    }
    lines.push("");
  }

  if (r.rateBasisChanged) {
    lines.push(`## Production`);
    lines.push("");
    lines.push(
      `No comparison this time. The previous report measured what the base consumed and this one measures what it produced, so a delta between them would be an artefact. The next report compares like with like.`,
    );
    lines.push("");
  }

  if (r.production.length > 0) {
    lines.push(`## Production, changes of ${r.threshold}/min or more`);
    lines.push("");
    for (const p of r.production) {
      lines.push(
        `- ${p.name}: ${signed(p.after - p.before)}/min (${p.before.toFixed(1)} to ${p.after.toFixed(1)})`,
      );
    }
    lines.push("");
  }

  if (r.powerDelta && r.power) {
    lines.push(`## Power`);
    lines.push("");
    lines.push(
      `- delivered ${mw(r.power.produced)} (${signed(r.powerDelta.produced / 1e6)} MW), ` +
        `drawn ${mw(r.power.consumed)} (${signed(r.powerDelta.consumed / 1e6)} MW)`,
    );
    lines.push("");
  }

  if (r.evolutionDelta !== null && r.evolution !== null && Math.abs(r.evolutionDelta) > 0) {
    lines.push(`## Evolution`);
    lines.push("");
    lines.push(
      `- ${(r.evolution * 100).toFixed(2)}% (${signed(r.evolutionDelta * 100, 2)} points)` +
        (r.pollution !== null ? `, pollution ${r.pollution.toFixed(0)}` : ""),
    );
    lines.push("");
  }

  lines.push(`Source: \`${stateFile}\`. Rate threshold ${r.threshold}/min.`);
  return lines.join("\n") + "\n";
}
