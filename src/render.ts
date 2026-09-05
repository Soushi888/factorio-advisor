/** Terminal formatting. Nothing here computes anything about the game. */

export function num(v: number, places = 2): string {
  if (!Number.isFinite(v)) return "inf";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(Math.min(1, places));
  if (abs < 0.01) return v.toExponential(1);
  return trimZeros(v.toFixed(places));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** "12.5/s" plus the per-minute figure, because Factorio players think in both. */
export function rate(perSecond: number): string {
  return `${num(perSecond)}/s (${num(perSecond * 60)}/min)`;
}

export function pct(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${num(v * 100, 1)}%`;
}

export interface Column {
  header: string;
  align?: "left" | "right";
}

export function table(columns: Column[], rows: string[][]): string {
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => {
        const w = widths[i] ?? cell.length;
        return columns[i]?.align === "right" ? cell.padStart(w) : cell.padEnd(w);
      })
      .join("  ")
      .trimEnd();

  const out = [line(columns.map((c) => c.header))];
  out.push(widths.map((w) => "-".repeat(w)).join("  ").trimEnd());
  for (const r of rows) out.push(line(r));
  return out.join("\n");
}

export function heading(text: string): string {
  return `\n${text}\n${"=".repeat(text.length)}`;
}

export function sub(text: string): string {
  return `\n${text}\n${"-".repeat(text.length)}`;
}

export function indent(depth: number): string {
  return depth === 0 ? "" : "  ".repeat(depth - 1) + "└ ";
}

export function bullet(lines: string[]): string {
  return lines.map((l) => `  - ${l}`).join("\n");
}
