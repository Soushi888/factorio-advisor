/**
 * Factorio writes energy as a suffixed string: "375kW", "1.5MW", "0.2kJ", "60J".
 * The unit letter says which quantity it is, so a value is either a power (W) or
 * an amount of energy (J), and mixing them up is a real class of bug.
 */

const SI: Record<string, number> = {
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Z: 1e21,
  Y: 1e24,
};

const ENERGY_RE = /^\s*(-?[\d.]+)\s*([kKMGTPEZY]?)\s*([WJ])\s*$/;

export interface ParsedEnergy {
  value: number;
  /** "W" is a rate, "J" is a quantity. */
  unit: "W" | "J";
}

export function parseEnergy(raw: unknown): ParsedEnergy | null {
  if (typeof raw !== "string") return null;
  const m = ENERGY_RE.exec(raw);
  if (!m) return null;
  const [, num, prefix, unit] = m;
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  const mult = SI[prefix ?? ""];
  if (mult === undefined) return null;
  return { value: n * mult, unit: unit === "W" ? "W" : "J" };
}

/** Watts, or 0 when the prototype declares no draw. */
export function watts(raw: unknown): number {
  const p = parseEnergy(raw);
  if (!p || p.unit !== "W") return 0;
  return p.value;
}

/** Joules, or 0 when the prototype declares none. */
export function joules(raw: unknown): number {
  const p = parseEnergy(raw);
  if (!p || p.unit !== "J") return 0;
  return p.value;
}

const POWER_STEPS: Array<[number, string]> = [
  [1e12, "TW"],
  [1e9, "GW"],
  [1e6, "MW"],
  [1e3, "kW"],
  [1, "W"],
];

export function formatWatts(w: number): string {
  if (w === 0) return "0 W";
  const abs = Math.abs(w);
  for (const [scale, label] of POWER_STEPS) {
    if (abs >= scale) {
      const v = w / scale;
      return `${trim(v)} ${label}`;
    }
  }
  return `${trim(w)} W`;
}

function trim(v: number): string {
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
