import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GameState, SurfaceMap } from "../src/state.ts";
import { mapOf } from "../src/map.ts";

/**
 * Defence removed between two reads, located (C6).
 *
 * The census says 15 gun turrets fewer; it does not say where. Two reads that
 * both carry positions say exactly which ones are gone, and the enemy chunks
 * the collector records say what is near them. What they cannot say is why: a
 * turret a biter killed and a turret Soushi picked up leave the same hole, so
 * this reports positions removed and never claims an attack or a deconstruction.
 *
 * Only a full state file carries positions; an archived report keeps none. So
 * the earlier read is the newest state file of the same map under `data/state`,
 * which with three rotating autosave slots is the read just before this one.
 */

/**
 * The snapshot classes whose instances are defence. `turret` is left out on
 * purpose: in vanilla it is the class of the biters' worms, not the player's.
 */
const DEFENCE_CLASSES = ["wall", "gate", "ammo-turret", "electric-turret", "fluid-turret", "artillery-turret"];

/** Two removed entities this many tiles apart or closer are one place. A choice, printed with the result. */
export const LOSS_GAP_TILES = 2;

export interface LossCluster {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  counts: Record<string, number>;
  /** Nearest enemy chunks holding nests, distance from the cluster's box to the chunk's, in tiles. */
  nests: Array<{ x: number; y: number; nests: number; distance: number }>;
}

export interface DefenceLosses {
  previousSave: string;
  previousTick: number;
  removed: number;
  placed: number;
  clusters: LossCluster[];
  gapTiles: number;
}

export type DefenceReading = { ok: true; losses: DefenceLosses } | { ok: false; why: string };

/** Defence prototype names, from the snapshot's own classes. */
export function defenceNames(data: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>();
  if (!data) return out;
  for (const cls of DEFENCE_CLASSES) {
    const protos = data[cls];
    if (protos && typeof protos === "object") for (const name of Object.keys(protos)) out.add(name);
  }
  return out;
}

/** The newest full state file of the same map, read before `now`. */
export function earlierFullRead(now: GameState, stateDir: string): GameState | null {
  if (!existsSync(stateDir) || typeof now.save.seed !== "number") return null;
  let best: GameState | null = null;
  for (const f of readdirSync(stateDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(stateDir, f), "utf8")) as GameState;
      if (s.save.seed !== now.save.seed || s.save.tick >= now.save.tick || !mapOf(s)) continue;
      if (!best || s.save.tick > best.save.tick) best = s;
    } catch {
      // A file mid-write or from an older collector is simply not a candidate.
    }
  }
  return best;
}

function key(x: number, y: number): string {
  return `${String(x)},${String(y)}`;
}

function positions(map: SurfaceMap, names: Set<string>): Map<string, { name: string; x: number; y: number }> {
  const out = new Map<string, { name: string; x: number; y: number }>();
  for (const [name, pts] of Object.entries(map.points)) {
    if (!names.has(name)) continue;
    for (const p of pts) out.set(`${name}@${key(p[0], p[1])}`, { name, x: p[0], y: p[1] });
  }
  return out;
}

export function defenceLosses(now: GameState, before: GameState | null, names: Set<string>): DefenceReading {
  if (!before) return { ok: false, why: "no earlier read of this map carries positions" };
  if (names.size === 0) return { ok: false, why: "no prototype snapshot, so no defence classes" };
  const a = mapOf(before);
  const b = mapOf(now);
  if (!a || !b) return { ok: false, why: "one of the two reads carries no map" };
  for (const [m, which] of [[a, "earlier"], [b, "this"]] as const) {
    const cut = (m.pointsDropped ?? []).filter((d) => names.has(d.name));
    if (cut.length > 0) {
      return { ok: false, why: `the ${which} read trimmed ${cut.map((d) => d.name).join(", ")} from its points, so a missing position proves nothing` };
    }
  }

  const was = positions(a, names);
  const is = positions(b, names);
  const lost = [...was].filter(([k]) => !is.has(k)).map(([, v]) => v);
  const placed = [...is.keys()].filter((k) => !was.has(k)).length;

  // Single-link clustering on a grid of gap-sized buckets.
  const parent = lost.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const bucket = new Map<string, number[]>();
  const g = LOSS_GAP_TILES;
  lost.forEach((p, i) => {
    const k = key(Math.floor(p.x / g), Math.floor(p.y / g));
    const list = bucket.get(k) ?? [];
    list.push(i);
    bucket.set(k, list);
  });
  lost.forEach((p, i) => {
    const bx = Math.floor(p.x / g), by = Math.floor(p.y / g);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of bucket.get(key(bx + dx, by + dy)) ?? []) {
          const q = lost[j]!;
          if (Math.abs(q.x - p.x) <= g && Math.abs(q.y - p.y) <= g) parent[find(i)] = find(j);
        }
      }
    }
  });
  const groups = new Map<number, typeof lost>();
  lost.forEach((p, i) => {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(p);
    groups.set(r, list);
  });

  const nestChunks = (b.enemy ?? []).filter((c) => c.nests > 0);
  const size = b.cellTiles;
  const clusters: LossCluster[] = [];
  for (const group of groups.values()) {
    const x0 = Math.floor(Math.min(...group.map((p) => p.x)));
    const y0 = Math.floor(Math.min(...group.map((p) => p.y)));
    const x1 = Math.ceil(Math.max(...group.map((p) => p.x)));
    const y1 = Math.ceil(Math.max(...group.map((p) => p.y)));
    const counts: Record<string, number> = {};
    for (const p of group) counts[p.name] = (counts[p.name] ?? 0) + 1;
    const nests = nestChunks
      .map((c) => {
        const cx0 = c.cx * size, cy0 = c.cy * size;
        const dx = Math.max(cx0 - x1, x0 - (cx0 + size), 0);
        const dy = Math.max(cy0 - y1, y0 - (cy0 + size), 0);
        return { x: cx0, y: cy0, nests: c.nests, distance: Math.round(Math.hypot(dx, dy)) };
      })
      .sort((p, q) => p.distance - q.distance)
      .slice(0, 3);
    clusters.push({ x0, y0, x1, y1, counts, nests });
  }
  clusters.sort((p, q) => sum(q.counts) - sum(p.counts));

  return {
    ok: true,
    losses: {
      previousSave: before.save.name,
      previousTick: before.save.tick,
      removed: lost.length,
      placed,
      clusters,
      gapTiles: g,
    },
  };
}

function sum(c: Record<string, number>): number {
  return Object.values(c).reduce((n, v) => n + v, 0);
}

export function describeCounts(c: Record<string, number>): string {
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([n, v]) => `${String(v)} ${n}`)
    .join(", ");
}

/** The defence section, as markdown. Says nothing when nothing was removed. */
export function defenceLines(d: DefenceReading | null | undefined): string[] {
  if (!d) return [];
  if (!d.ok) return [];
  const l = d.losses;
  if (l.removed === 0) return [];
  const lines = [
    `## Defence removed since ${l.previousSave} at tick ${l.previousTick}`,
    "",
    `${l.removed} wall, gate or turret positions present then are empty now, and ${l.placed} new ones appeared. Removed says nothing about why: an attack and a pickup leave the same hole.`,
    "",
  ];
  for (const c of l.clusters) {
    const near = c.nests.length
      ? `; nearest nests ${c.nests.map((n) => `${String(n.nests)} at chunk x ${n.x}, y ${n.y} (${n.distance} tiles)`).join(", ")}`
      : "; no nest charted";
    lines.push(`- x ${c.x0} to ${c.x1}, y ${c.y0} to ${c.y1}: ${describeCounts(c.counts)}${near}`);
  }
  lines.push("");
  return lines;
}
