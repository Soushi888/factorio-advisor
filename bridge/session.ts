import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flowOf, isLegacyFlows, type GameState } from "../src/state.ts";
import { mapOf, patches, type Patch } from "../src/map.ts";
import { occupancy } from "../src/saturation.ts";
import type { Data } from "../src/proto.ts";

/**
 * The session trend (C4): what moved across every read of tonight's play, not
 * only since the previous read of the same slot.
 *
 * Factorio rotates three autosave slots beside the named save, and the report
 * diffs each slot against its own previous read. A decline that runs all
 * evening therefore reads as five unrelated drops, and one upgrade pass is
 * announced again on every slot that had not seen it yet (234 bulk inserters,
 * three times, on 2026-11-08). The session folds every slot of one map, ordered
 * by tick, into one series.
 */

/**
 * The idle time that ends a session, in minutes. A choice, not a game fact.
 *
 * Between two reads of one session the game advances about as fast as the wall
 * clock; across a break the wall clock runs on while the tick stands still. A
 * read starts a new session when the wall clock between it and the read before
 * it exceeds the game time between them by more than this. Thirty minutes keeps
 * a watcher restart or a slow engine read inside the session and puts a night
 * between games outside it. Printed in the report so it can be argued with.
 */
export const SESSION_BREAK_MINUTES = 30;

/** What one read contributes to a trend, small enough to cache for every read. */
export interface ReadSummary {
  file: string;
  save: string;
  tick: number;
  /** Wall-clock time of the read, ms since epoch. */
  readAt: number;
  seed: number;
  legacy: boolean;
  rates: Record<string, number>;
  machines: Record<string, number>;
  powerProduced: number | null;
  evolution: number | null;
  /** Fluid made and used per minute, from production.fluid. */
  fluids?: Record<string, { made: number; used: number }>;
  /**
   * What the tanks held, per fluid. Null when this read carries no fluid
   * reading at all: an archive written before U7 keeps no containers, and a 2.1
   * read before U1 has every tank unread. Null is "not read", never zero.
   */
  stock?: Record<string, FluidStock> | null;
}

/** Stored volume of one fluid across the tanks that hold it, by saturation.ts's own reading. */
export interface FluidStock {
  stored: number;
  capacity: number;
  tanks: number;
  full: number;
}

export interface FluidTrend {
  name: string;
  startMade: number;
  nowMade: number;
  nowUsed: number;
  fell: number;
  rose: number;
  stockStart: FluidStock | null;
  stockNow: FluidStock | null;
}

export interface RateTrend {
  name: string;
  start: number;
  now: number;
  /** Steps between consecutive reads where the rate fell or rose. */
  fell: number;
  rose: number;
}

export interface MachineTrend {
  name: string;
  start: number;
  now: number;
  /** True when the count moved since the immediately preceding read of any slot. */
  newThisRead: boolean;
}

/** Where a raw resource that fell across the session is mined, and where it is not (C5). */
export interface RawFinding {
  resource: string;
  start: number;
  now: number;
  mined: Patch[];
  /** The largest field of this resource nothing stands on, or null when every field is mined. */
  unmined: Patch | null;
}

export interface SessionTrend {
  startTick: number;
  startSave: string;
  startReadAt: number;
  reads: number;
  slots: string[];
  breakMinutes: number;
  threshold: number;
  rates: RateTrend[];
  machines: MachineTrend[];
  power: { start: number; now: number } | null;
  evolution: { start: number; now: number } | null;
  raw: RawFinding[];
  fluids: FluidTrend[];
}

/**
 * Stored fluid per fluid name, through `occupancy()` so the session and the
 * bottleneck reading agree on what a full tank is. Null when no tank in the
 * read answered, which is a read that cannot speak about stock.
 */
export function fluidStockOf(state: GameState, data: Data | null): Record<string, FluidStock> | null {
  if (!data) return null;
  const tanks = (state.map ?? []).flatMap((m) => m.containers ?? []);
  const fluidNames = new Set(tanks.filter((c) => c.fluid).map((c) => c.fluid!.name));
  if (fluidNames.size === 0) return null;
  const rows = occupancy(state, data);
  const out: Record<string, FluidStock> = {};
  for (const name of fluidNames) {
    const r = rows.get(name);
    if (!r || r.holders === 0) continue;
    out[name] = { stored: r.stored, capacity: r.stored + r.room, tanks: r.holders, full: r.holdersFull };
  }
  return out;
}

/**
 * The same extractor list `advise.ts` and `sections.ts` hand to `patches()`, so
 * the three readings agree on which fields are mined.
 */
const EXTRACTORS = ["electric-mining-drill", "burner-mining-drill", "big-mining-drill", "pumpjack"];

/**
 * For every resource whose made rate fell across the session, the fields it is
 * mined from and the largest one nothing stands on. A resource is raw here when
 * the map holds a field of it, which is the save's own answer and needs no list.
 * The finding names places and amounts; it never says why the rate fell.
 */
function rawFindings(now: GameState, rates: Array<{ name: string; start: number; now: number }>): RawFinding[] {
  const map = mapOf(now);
  if (!map) return [];
  const fields = patches(map, EXTRACTORS);
  const out: RawFinding[] = [];
  for (const r of rates) {
    if (r.now >= r.start) continue;
    const mine = fields.filter((f) => f.resource === r.name);
    if (mine.length === 0) continue;
    out.push({
      resource: r.name,
      start: r.start,
      now: r.now,
      mined: mine.filter((f) => f.extractors > 0),
      unmined: mine.find((f) => f.extractors === 0) ?? null,
    });
  }
  return out;
}

// The engine runs 60 ticks a second at normal speed (the same constant belts.ts
// declares); a session compares game time against the wall clock in minutes.
const TICKS_PER_MINUTE = 3600;

export function summarise(state: GameState, file: string, force = "player", data: Data | null = null): ReadSummary | null {
  const f = state.forces[force];
  const seed = state.save.seed;
  const readAt = Date.parse(state.save.readAt ?? "");
  if (!f || typeof seed !== "number" || !Number.isFinite(readAt)) return null;
  const legacy = isLegacyFlows(state, force);
  const rates: Record<string, number> = {};
  for (const [name, flow] of Object.entries(f.production.item)) {
    const r = flowOf(flow);
    rates[name] = legacy ? r.consumedPerMinute : r.producedPerMinute;
  }
  const el = f.electric;
  return {
    file,
    save: state.save.name,
    tick: state.save.tick,
    readAt,
    seed,
    legacy,
    rates,
    machines: { ...(f.machines ?? {}) },
    powerProduced: el ? Object.values(el.production).reduce((n, w) => n + w, 0) : null,
    evolution: state.save.surfaceState?.[0]?.evolution ?? null,
    fluids: Object.fromEntries(
      Object.entries(f.production.fluid ?? {}).map(([name, flow]) => {
        const r = flowOf(flow);
        return [name, { made: r.producedPerMinute, used: r.consumedPerMinute }];
      }),
    ),
    // An archive carries the stock it was written with; a full read is priced here.
    stock: (state as GameState & { fluidStock?: Record<string, FluidStock> }).fluidStock ?? fluidStockOf(state, data),
  };
}

/** Bumped when ReadSummary gains a field, so a cached summary without it is read again. */
const INDEX_VERSION = 2;

interface IndexFile {
  version?: number;
  /** file name to its mtime and summary; a null summary is a file that cannot carry one. */
  entries: Record<string, { mtimeMs: number; summary: ReadSummary | null }>;
}

/**
 * Every archived read in `reportsDir`, summarised once and cached.
 *
 * An archived state file is about 13 MB and a night of play writes dozens, so
 * parsing all of them on every save would make the report slower each time it
 * runs. The cache is keyed by file name and mtime, so a rewritten file is read
 * again rather than trusted.
 */
export function readSummaries(reportsDir: string, indexPath: string): ReadSummary[] {
  if (!existsSync(reportsDir)) return [];
  let index: IndexFile = { entries: {} };
  try {
    if (existsSync(indexPath)) index = JSON.parse(readFileSync(indexPath, "utf8")) as IndexFile;
  } catch {
    index = { entries: {} };
  }
  if (index.version !== INDEX_VERSION) index = { entries: {} };
  const files = readdirSync(reportsDir).filter((f) => /-\d+\.json$/.test(f));
  const next: IndexFile = { version: INDEX_VERSION, entries: {} };
  let changed = false;
  for (const file of files) {
    const mtimeMs = statSync(join(reportsDir, file)).mtimeMs;
    const cached = index.entries[file];
    if (cached && cached.mtimeMs === mtimeMs) {
      next.entries[file] = cached;
      continue;
    }
    let summary: ReadSummary | null = null;
    try {
      summary = summarise(JSON.parse(readFileSync(join(reportsDir, file), "utf8")) as GameState, file);
    } catch {
      summary = null;
    }
    next.entries[file] = { mtimeMs, summary };
    changed = true;
  }
  if (changed || Object.keys(index.entries).length !== files.length) {
    writeFileSync(indexPath, JSON.stringify(next) + "\n");
  }
  return Object.values(next.entries)
    .map((e) => e.summary)
    .filter((s): s is ReadSummary => s !== null);
}

/** True when `b` follows `a` without a break: the wall clock did not outrun the game. */
function continuous(a: ReadSummary, b: ReadSummary, breakMinutes: number): boolean {
  const wallMin = (b.readAt - a.readAt) / 60000;
  const gameMin = (b.tick - a.tick) / TICKS_PER_MINUTE;
  return wallMin - gameMin <= breakMinutes;
}

/**
 * The trend from the first read of the current session to `now`.
 *
 * `now` is the read being reported, which is not on disk yet when the report is
 * built. Reads of other maps are ignored by seed; reads at or after `now`'s
 * tick are ignored, so a redraw of an older read never sees its own future.
 * Null when the session holds no read before `now`.
 */
export function sessionTrend(
  now: GameState,
  history: ReadSummary[],
  threshold: number,
  breakMinutes = SESSION_BREAK_MINUTES,
  data: Data | null = null,
): SessionTrend | null {
  const cur = summarise(now, "(this read)", "player", data);
  if (!cur) return null;
  const series = history
    .filter((s) => s.seed === cur.seed && s.tick < cur.tick && s.legacy === cur.legacy)
    .sort((a, b) => a.tick - b.tick);
  // Two files of one tick are one read (a manual save and an autosave can land
  // on the same tick); keep the first.
  const reads: ReadSummary[] = [];
  for (const s of series) if (reads.length === 0 || reads[reads.length - 1]!.tick !== s.tick) reads.push(s);
  reads.push(cur);

  let start = reads.length - 1;
  while (start > 0 && continuous(reads[start - 1]!, reads[start]!, breakMinutes)) start--;
  if (start === reads.length - 1) return null;
  const session = reads.slice(start);
  const first = session[0]!;
  const prev = session[session.length - 2]!;

  const names = new Set([...Object.keys(first.rates), ...Object.keys(cur.rates)]);
  const rates: RateTrend[] = [];
  for (const name of names) {
    const s = first.rates[name] ?? 0;
    const n = cur.rates[name] ?? 0;
    if (Math.abs(n - s) < threshold) continue;
    let fell = 0;
    let rose = 0;
    for (let i = 1; i < session.length; i++) {
      const d = (session[i]!.rates[name] ?? 0) - (session[i - 1]!.rates[name] ?? 0);
      if (d < 0) fell++;
      else if (d > 0) rose++;
    }
    rates.push({ name, start: s, now: n, fell, rose });
  }
  rates.sort((a, b) => Math.abs(b.now - b.start) - Math.abs(a.now - a.start));

  const fnames = new Set([...Object.keys(first.fluids ?? {}), ...Object.keys(cur.fluids ?? {})]);
  const fluids: FluidTrend[] = [];
  for (const name of fnames) {
    const s = first.fluids?.[name]?.made ?? 0;
    const n = cur.fluids?.[name]?.made ?? 0;
    const used = cur.fluids?.[name]?.used ?? 0;
    // Moved across the session, or drawing on stock now: heavy oil made at 253
    // against 528 used is the case no made-only trend shows.
    if (Math.abs(n - s) < threshold && used - n < threshold) continue;
    let fell = 0;
    let rose = 0;
    for (let i = 1; i < session.length; i++) {
      const d = (session[i]!.fluids?.[name]?.made ?? 0) - (session[i - 1]!.fluids?.[name]?.made ?? 0);
      if (d < 0) fell++;
      else if (d > 0) rose++;
    }
    const stockAt = (r: ReadSummary): FluidStock | null => (r.stock ? (r.stock[name] ?? null) : null);
    fluids.push({ name, startMade: s, nowMade: n, nowUsed: used, fell, rose, stockStart: stockAt(first), stockNow: stockAt(cur) });
  }
  fluids.sort((a, b) => b.nowUsed - b.nowMade - (a.nowUsed - a.nowMade));

  const mnames = new Set([...Object.keys(first.machines), ...Object.keys(cur.machines)]);
  const machines: MachineTrend[] = [];
  for (const name of mnames) {
    const s = first.machines[name] ?? 0;
    const n = cur.machines[name] ?? 0;
    if (s === n) continue;
    machines.push({ name, start: s, now: n, newThisRead: (prev.machines[name] ?? 0) !== n });
  }
  machines.sort((a, b) => Math.abs(b.now - b.start) - Math.abs(a.now - a.start));

  return {
    startTick: first.tick,
    startSave: first.save,
    startReadAt: first.readAt,
    reads: session.length,
    slots: [...new Set(session.map((s) => s.save))].sort(),
    breakMinutes,
    threshold,
    rates,
    machines,
    power:
      first.powerProduced !== null && cur.powerProduced !== null
        ? { start: first.powerProduced, now: cur.powerProduced }
        : null,
    evolution:
      first.evolution !== null && cur.evolution !== null ? { start: first.evolution, now: cur.evolution } : null,
    raw: rawFindings(now, [...rates, ...fluids.map((f) => ({ name: f.name, start: f.startMade, now: f.nowMade }))]),
    fluids,
  };
}

function signed(v: number, places = 1): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(places)}`;
}

/** Pumpjacks stand on a fluid field and drills on an ore field. */
export function extractorWord(resource: string, t: SessionTrend): string {
  return t.fluids.some((f) => f.name === resource) ? "pumpjacks" : "drills";
}

export function stockText(s: FluidStock | null): string {
  if (!s) return "not read";
  const pct = s.capacity > 0 ? ` (${((s.stored / s.capacity) * 100).toFixed(0)}% of ${amount(s.capacity)})` : "";
  return `${amount(s.stored)}${pct}, ${s.full} of ${s.tanks} tanks full`;
}

function area(p: Patch): string {
  return `${p.x}..${p.x + p.w},${p.y}..${p.y + p.h} (${p.w} by ${p.h} tiles)`;
}

function amount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}

function localTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The session section, as markdown. Empty when there is no session to speak of. */
export function sessionLines(t: SessionTrend | null): string[] {
  if (!t) return [];
  const lines: string[] = ["## This session", ""];
  lines.push(
    `Since tick ${t.startTick} (${t.startSave}, read ${localTime(t.startReadAt)}), ${t.reads} reads across ${t.slots.join(", ")}. ` +
      `A session ends where the wall clock outran game time by more than ${t.breakMinutes} min.`,
  );
  lines.push("");
  if (t.rates.length > 0) {
    lines.push(`Production, session changes of ${t.threshold}/min or more:`);
    lines.push("");
    for (const r of t.rates) {
      const steps = r.fell + r.rose;
      lines.push(
        `- ${r.name}: ${signed(r.now - r.start)}/min (${r.start.toFixed(1)} to ${r.now.toFixed(1)}), fell in ${r.fell} of ${steps} steps`,
      );
    }
    lines.push("");
  }
  if (t.fluids.length > 0) {
    lines.push(`Fluids, moved ${t.threshold}/min or used faster than made (stock is what the tanks hold; not read means that read carries no tank reading):`);
    lines.push("");
    for (const f of t.fluids) {
      lines.push(
        `- ${f.name}: made ${f.startMade.toFixed(1)} to ${f.nowMade.toFixed(1)}/min, used ${f.nowUsed.toFixed(1)}/min now, fell in ${f.fell} of ${f.fell + f.rose} steps; ` +
          `stock ${stockText(f.stockStart)} at start, ${stockText(f.stockNow)} now`,
      );
    }
    lines.push("");
  }
  if (t.raw.length > 0) {
    lines.push(`Raw resources that fell, and where they are mined:`);
    lines.push("");
    for (const f of t.raw) {
      lines.push(`- ${f.resource}, ${f.start.toFixed(1)} to ${f.now.toFixed(1)}/min:`);
      if (f.mined.length === 0) lines.push(`  - no field of it has a drill standing on it`);
      for (const p of f.mined) {
        lines.push(`  - mined at ${area(p)}, ${amount(p.amount)} left under ${p.extractors} ${extractorWord(f.resource, t)}`);
      }
      if (f.unmined) lines.push(`  - largest unmined field ${area(f.unmined)}, ${amount(f.unmined.amount)}`);
      else lines.push(`  - every field of it on the map already has a drill`);
    }
    lines.push("");
  }
  if (t.machines.length > 0) {
    lines.push(`Machines, net since the session began (* moved since the read before this one):`);
    lines.push("");
    for (const m of t.machines) {
      lines.push(`- ${m.name}: ${signed(m.now - m.start, 0)} (${m.start} to ${m.now})${m.newThisRead ? " *" : ""}`);
    }
    lines.push("");
  }
  if (t.power) {
    lines.push(`Power delivered ${(t.power.start / 1e6).toFixed(1)} to ${(t.power.now / 1e6).toFixed(1)} MW (${signed((t.power.now - t.power.start) / 1e6)} MW).`);
  }
  if (t.evolution) {
    lines.push(`Evolution ${(t.evolution.start * 100).toFixed(2)}% to ${(t.evolution.now * 100).toFixed(2)}%.`);
  }
  if (t.power || t.evolution) lines.push("");
  return lines;
}
