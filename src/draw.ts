import type { Blueprint, BpEntity } from "./blueprint.ts";
import type { AuditResult, Box } from "./audit.ts";
import type { Data, Proto } from "./proto.ts";
import { EAST, NORTH, SOUTH, WEST, footprintOf } from "./layout.ts";

/**
 * Drawing a decoded print to scale (C29).
 *
 * The audit already resolves what a print IS: which machines, which recipes,
 * what it needs fed in. What it never showed is where any of that sits, so a
 * print that audits well and is laid out badly reads identically to one that is
 * laid out well. This draws the same decoded entities the audit read, at the
 * size and the position they declare, and asserts no number the audit does not
 * already produce.
 *
 * Three measured facts carry it, and all three were re-derived from the shipped
 * prints in `.local/` rather than recalled:
 *
 *   - **The footprint is `selection_box`.** `collision_box` is inset for
 *     movement, so drawing from it would make every machine smaller than the
 *     tiles it really occupies. `footprintOf` in `layout.ts` is the one reader.
 *
 *   - **Direction 4 is East and 12 is West**, so both swap width and height.
 *     Measured, not remembered: an underground belt pair in `bp39.txt` has its
 *     `input` at x 10.5 and its `output` at x 7.5 on direction 12, which is
 *     travel toward smaller x, and a pair in `bp0.txt` has input at -113.5 and
 *     output at -111.5 on direction 4, which is the opposite. The crusher
 *     confirms it from the other side: native 2 wide by 3 tall, placed on
 *     direction 4 at x 13.5 and y 1, which is the parity of a 3 by 2 box.
 *
 *   - **A diagonal direction is not a rotated box.** Factorio 2.0 has sixteen
 *     directions and rails use the odd ones; a rail at 45 degrees has no
 *     axis-aligned footprint the snapshot declares. Those are drawn at their
 *     unrotated box and COUNTED, because a silent guess on a rail yard is how a
 *     drawing starts lying.
 */

/** A display family, keyed to the prototype's declared type, never to its name. */
export interface Family {
  id: string;
  label: string;
  colour: string;
}

const FAMILIES: Family[] = [
  { id: "belt", label: "Belts and loaders", colour: "#d99a2b" },
  { id: "inserter", label: "Inserters", colour: "#4a90d9" },
  { id: "machine", label: "Machines", colour: "#4fbf72" },
  { id: "fluid", label: "Pipes and tanks", colour: "#3fc2d4" },
  { id: "power", label: "Power", colour: "#f2e37a" },
  { id: "heat", label: "Heat", colour: "#ff8c42" },
  { id: "beacon", label: "Beacons", colour: "#b07ad0" },
  { id: "storage", label: "Storage", colour: "#a99a78" },
  { id: "defence", label: "Defence", colour: "#d94f4f" },
  { id: "rail", label: "Rails and trains", colour: "#8a8f99" },
  { id: "circuit", label: "Circuits and lamps", colour: "#d06aa8" },
  { id: "other", label: "Everything else", colour: "#6a7280" },
];

/**
 * Which family a prototype type belongs to.
 *
 * The tests are on the TYPE string the snapshot declares, so a modded belt or a
 * turret this snapshot has never heard of still lands in the right family, and
 * two things that share a name and differ in kind never share a colour. A type
 * nothing matches is `other` rather than a guess.
 */
export function familyOf(type: string): string {
  if (type === "beacon") return "beacon";
  if (type === "inserter") return "inserter";
  if (type.endsWith("turret") || type === "wall" || type === "gate" || type === "land-mine") {
    return "defence";
  }
  if (
    type.includes("rail") ||
    type.includes("wagon") ||
    type === "locomotive" ||
    type === "train-stop"
  ) {
    return "rail";
  }
  if (
    type.includes("belt") ||
    type === "splitter" ||
    type === "loader" ||
    type === "loader-1x1"
  ) {
    return "belt";
  }
  if (type.includes("pipe") || type === "storage-tank" || type === "pump" || type === "offshore-pump") {
    return type.startsWith("heat") ? "heat" : "fluid";
  }
  if (type.includes("heat")) return "heat";
  if (type.includes("container") || type === "car" || type === "spider-vehicle") return "storage";
  if (
    type === "electric-pole" ||
    type === "power-switch" ||
    type === "generator" ||
    type === "boiler" ||
    type === "solar-panel" ||
    type === "accumulator" ||
    type === "reactor" ||
    type.includes("fusion") ||
    type.includes("generator") ||
    type.includes("energy-interface") ||
    type === "lightning-attractor"
  ) {
    return type === "reactor" ? "heat" : "power";
  }
  if (type.includes("combinator") || type === "lamp" || type === "display-panel" || type === "programmable-speaker") {
    return "circuit";
  }
  if (
    type.includes("machine") ||
    type === "furnace" ||
    type === "lab" ||
    type === "rocket-silo" ||
    type.includes("drill") ||
    type === "roboport" ||
    type === "asteroid-collector" ||
    type === "agricultural-tower" ||
    type === "thruster" ||
    type === "radar"
  ) {
    return "machine";
  }
  return "other";
}

/**
 * A direction that swaps width against height.
 *
 * The four cardinals are already declared and already measured in `layout.ts`,
 * so this reads them rather than writing a second compass that can drift from
 * the first.
 */
function rotates(direction: number): boolean {
  return direction === EAST || direction === WEST;
}

/** Anything off the four cardinals: no declared box describes it. */
function isDiagonal(direction: number): boolean {
  return direction !== NORTH && direction !== EAST && direction !== SOUTH && direction !== WEST;
}

export interface Placed {
  entity: BpEntity;
  family: string;
  box: Box;
  /** The prototype's own type, or the empty string when the snapshot lacks it. */
  type: string;
  /** No selection box in the snapshot: drawn as one tile and counted as a gap. */
  guessed: boolean;
  /** Drawn unrotated because the direction is diagonal. */
  diagonal: boolean;
  direction: number;
}

/** The entity prototype for a name: the one carrying a selection box, not the item. */
function entityProto(data: Data, name: string): Proto | null {
  const protos = data.all(name);
  return protos.find((p) => "selection_box" in p) ?? protos[0] ?? null;
}

/** Where an entity sits and how big it is, with the direction applied. */
export function place(data: Data, entity: BpEntity): Placed {
  const proto = entityProto(data, entity.name);
  const foot = proto ? footprintOf(proto) : null;
  const direction = Number(entity.direction ?? 0);
  const swap = rotates(direction);
  const w = (foot?.width ?? 1) * 1;
  const h = (foot?.height ?? 1) * 1;
  const bw = swap ? h : w;
  const bh = swap ? w : h;
  const x = Number(entity.position.x);
  const y = Number(entity.position.y);
  const type = proto ? String(proto.type ?? "") : "";
  return {
    entity,
    family: familyOf(type),
    type,
    guessed: foot === null,
    diagonal: isDiagonal(direction),
    direction,
    box: { x1: x - bw / 2, y1: y - bh / 2, x2: x + bw / 2, y2: y + bh / 2 },
  };
}

export interface DrawnPrint {
  label: string;
  svg: string;
  box: Box | null;
  entityCount: number;
  /** Per family, how many were drawn, best first. */
  families: Array<{ family: Family; count: number }>;
  /** Prototypes with no selection box in this snapshot, drawn as one tile. */
  guessed: Array<{ name: string; count: number }>;
  /** Entities on a diagonal direction, drawn at their unrotated box. */
  diagonal: Array<{ name: string; count: number }>;
  /** Names the snapshot does not know at all, copied from the audit. */
  unknown: string[];
  /** Machines the audit says are fed short, by the item they are short of. */
  starved: Array<{ item: string; shortfallPerSecond: number; entities: number }>;
}

function n(v: number): string {
  return v.toFixed(2).replace(/\.?0+$/, "");
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/**
 * The travel arrow, for belt-family entities only.
 *
 * Direction is sixteenths of a turn clockwise from north, which is why the
 * angle is `direction * 22.5` degrees and north is negative y. It is drawn only
 * where travel direction was actually measured: an underground pair states which
 * way it carries, and an inserter's direction names one of its two ends without
 * the print saying which, so inserters get their rotation and no arrow.
 */
function arrow(p: Placed): string {
  const cx = (p.box.x1 + p.box.x2) / 2;
  const cy = (p.box.y1 + p.box.y2) / 2;
  const a = (p.direction * 22.5 * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const r = Math.min(p.box.x2 - p.box.x1, p.box.y2 - p.box.y1) * 0.35;
  const tx = cx + dx * r;
  const ty = cy + dy * r;
  // A chevron rather than a bare line: a line segment shows an axis and leaves
  // which way it carries to the reader's imagination, which is the one thing a
  // drawing of a belt exists to settle.
  const b = r * 0.7;
  const px = -dy;
  const py = dx;
  return (
    `M${n(cx - dx * r)} ${n(cy - dy * r)}L${n(tx)} ${n(ty)}` +
    `M${n(tx - dx * b + px * b * 0.7)} ${n(ty - dy * b + py * b * 0.7)}` +
    `L${n(tx)} ${n(ty)}` +
    `L${n(tx - dx * b - px * b * 0.7)} ${n(ty - dy * b - py * b * 0.7)}`
  );
}

/**
 * The shapes' own stylesheet, carried INSIDE the svg element.
 *
 * `--svg` writes the same string as a file of its own, and a file whose colours
 * live in the page that embedded it renders as a black rectangle anywhere else.
 * One copy, inside the thing it styles.
 */
const SVG_CSS = `
  .grid { fill:none; stroke:#232830; stroke-width:1; vector-effect:non-scaling-stroke; }
  .fp { fill:var(--c); fill-opacity:.55; stroke:var(--c); stroke-width:1.1;
        vector-effect:non-scaling-stroke; stroke-linejoin:round; }
  .dir { fill:none; stroke:#14161a; stroke-width:1.4; stroke-linecap:round;
         vector-effect:non-scaling-stroke; opacity:.8; }
  .starved { fill:none; stroke:#ffffff; stroke-width:2.2; stroke-dasharray:4 2.5;
             vector-effect:non-scaling-stroke; }
`;

function rect(b: Box): string {
  return `M${n(b.x1)} ${n(b.y1)}h${n(b.x2 - b.x1)}v${n(b.y2 - b.y1)}h${n(b.x1 - b.x2)}z`;
}

/**
 * Draw one decoded print.
 *
 * Takes the `Blueprint` object, so it works the same on a pasted string and on
 * what `bun run gen` just built, with no round trip through the encoder. The
 * audit is passed in rather than recomputed: every figure on the page comes from
 * it, and this function's own output is geometry only.
 */
export function drawPrint(data: Data, bp: Blueprint, result: AuditResult): DrawnPrint {
  const entities = bp.entities ?? [];
  const placed = entities.map((e) => place(data, e));

  let box: Box | null = null;
  for (const p of placed) {
    box = box
      ? {
          x1: Math.min(box.x1, p.box.x1),
          y1: Math.min(box.y1, p.box.y1),
          x2: Math.max(box.x2, p.box.x2),
          y2: Math.max(box.y2, p.box.y2),
        }
      : { ...p.box };
  }

  // Which entities the audit's own shortfalls land on. This is a join over the
  // audit's flows and the recipes it already resolved, never a second opinion
  // about what is short: if the audit reports no import, nothing is marked.
  const shortfalls = result.flows.filter((f) => f.net < -1e-9);
  const starvedNumbers = new Set<number>();
  const starved = shortfalls.map((f) => {
    let count = 0;
    for (const m of result.machines) {
      // The audit already resolved what every machine eats per second, so the
      // join is a lookup rather than a second reading of the recipe.
      if (!m.run.inputPerSecond.has(f.item)) continue;
      count += 1;
      starvedNumbers.add(m.entity.entity_number);
    }
    return { item: f.item, shortfallPerSecond: -f.net, entities: count };
  });

  const byFamily = new Map<string, Placed[]>();
  const guessed = new Map<string, number>();
  const diagonal = new Map<string, number>();
  for (const p of placed) {
    const list = byFamily.get(p.family) ?? [];
    list.push(p);
    byFamily.set(p.family, list);
    if (p.guessed) guessed.set(p.entity.name, (guessed.get(p.entity.name) ?? 0) + 1);
    if (p.diagonal) diagonal.set(p.entity.name, (diagonal.get(p.entity.name) ?? 0) + 1);
  }

  const parts: string[] = [];
  const families: Array<{ family: Family; count: number }> = [];
  for (const family of FAMILIES) {
    const list = byFamily.get(family.id) ?? [];
    if (list.length === 0) continue;
    families.push({ family, count: list.length });
    const titles = new Map<string, number>();
    for (const p of list) titles.set(p.entity.name, (titles.get(p.entity.name) ?? 0) + 1);
    const tip = [...titles]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} x${String(count)}`)
      .join(", ");
    parts.push(
      `<g class="fam" data-family="${family.id}" style="--c:${family.colour}">` +
        `<title>${esc(family.label)}: ${esc(tip)}</title>` +
        `<path class="fp" d="${list.map((p) => rect(p.box)).join("")}"/>` +
        `</g>`,
    );
    if (family.id === "belt") {
      const ticks = list.map((p) => arrow(p)).join("");
      if (ticks) parts.push(`<path class="dir" style="--c:${family.colour}" d="${ticks}"/>`);
    }
  }

  const marks = placed.filter((p) => starvedNumbers.has(p.entity.entity_number));
  if (marks.length > 0) {
    parts.push(`<path class="starved" d="${marks.map((p) => rect(p.box)).join("")}"/>`);
  }

  const pad = 1;
  const view = box
    ? `${n(box.x1 - pad)} ${n(box.y1 - pad)} ${n(box.x2 - box.x1 + pad * 2)} ${n(box.y2 - box.y1 + pad * 2)}`
    : "0 0 1 1";
  const svg =
    // The namespace is redundant inside an HTML document and load-bearing in a
    // file of its own, which is exactly the case `--svg` writes.
    `<svg xmlns="http://www.w3.org/2000/svg" class="print" viewBox="${view}" ` +
    `preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="${esc(result.label)} drawn to scale">` +
    `<style>${SVG_CSS}</style>` +
    `<defs><pattern id="tiles" width="1" height="1" patternUnits="userSpaceOnUse">` +
    `<path class="grid" d="M1 0V1H0"/></pattern></defs>` +
    // Two rectangles over the same area: the dark ground, then the tile grid.
    // The ground is in the svg rather than in the page because `--svg` writes
    // this string as a file, and every colour in it is chosen against dark.
    (box
      ? `<rect x="${n(box.x1 - pad)}" y="${n(box.y1 - pad)}" width="${n(box.x2 - box.x1 + pad * 2)}" ` +
        `height="${n(box.y2 - box.y1 + pad * 2)}" fill="#0f1114"/>` +
        `<rect x="${n(box.x1 - pad)}" y="${n(box.y1 - pad)}" width="${n(box.x2 - box.x1 + pad * 2)}" ` +
        `height="${n(box.y2 - box.y1 + pad * 2)}" fill="url(#tiles)"/>`
      : "") +
    parts.join("") +
    `</svg>`;

  return {
    label: result.label,
    svg,
    box,
    entityCount: entities.length,
    families,
    guessed: [...guessed].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    diagonal: [...diagonal].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    unknown: result.unknownEntities,
    starved: starved.filter((s) => s.entities > 0),
  };
}

const PAGE_CSS = `
  :root { color-scheme: dark; --bg:#14161a; --fg:#d8dde3; --dim:#8b949e; --line:#262b33; --warn:#e0745a; }
  body { margin:0; padding:2rem; background:var(--bg); color:var(--fg);
         font:15px/1.6 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 74rem; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  h2 { font-size:1.05rem; margin:2rem 0 .5rem; font-weight:600; }
  p.meta { color:var(--dim); margin:0 0 1.5rem; }
  figure { margin:0; background:#0f1114; border:1px solid var(--line); border-radius:8px; padding:1rem; }
  svg.print { display:block; width:100%; height:auto; max-height:78vh; }
  ul.key { list-style:none; padding:0; margin:1rem 0 0; display:flex; flex-wrap:wrap; gap:.4rem 1.25rem; }
  ul.key li { display:flex; align-items:center; gap:.45rem; font-size:.9em; }
  ul.key i { width:.85rem; height:.85rem; border-radius:2px; display:inline-block; }
  table { border-collapse:collapse; width:100%; font-size:.92em; }
  th, td { text-align:left; padding:.35rem .75rem .35rem 0; border-bottom:1px solid var(--line); }
  td.n, th.n { text-align:right; }
  .gap { color:var(--dim); font-size:.92em; }
  .warn { color:var(--warn); }
`;

export interface PageInput {
  drawings: DrawnPrint[];
  results: AuditResult[];
  snapshot: string;
  source: string;
}

/**
 * The page.
 *
 * Everything numeric on it is the audit's, and the gaps are stated rather than
 * absorbed: prototypes with no declared footprint, entities the snapshot has
 * never heard of, and diagonal directions drawn unrotated each get a line. A
 * drawing that quietly defaulted those would look exactly as confident as one
 * that had measured them.
 */
export function printPage(input: PageInput): string {
  const body = input.drawings
    .map((d, i) => {
      const result = input.results[i];
      const size = d.box
        ? `${String(Math.round(d.box.x2 - d.box.x1))} x ${String(Math.round(d.box.y2 - d.box.y1))} tiles`
        : "empty";
      const key = d.families
        .map(
          (f) =>
            `<li><i style="background:${f.family.colour}"></i>${esc(f.family.label)} ` +
            `<span class="gap">${String(f.count)}</span></li>`,
        )
        .join("");

      const gaps: string[] = [];
      if (d.entityCount === 0) {
        gaps.push(
          `<p class="warn">This print decodes and holds no entities, so there is nothing to draw. ` +
            `It may be a tile-only print, a book entry, or a deconstruction planner.</p>`,
        );
      }
      if (d.guessed.length > 0) {
        gaps.push(
          `<p class="gap">Drawn as one tile because this snapshot declares no selection box for them: ` +
            d.guessed.map((g) => `${esc(g.name)} x${String(g.count)}`).join(", ") +
            `. The size is a placeholder, not a measurement.</p>`,
        );
      }
      if (d.diagonal.length > 0) {
        gaps.push(
          `<p class="gap">Drawn at their unrotated footprint because their direction is diagonal, ` +
            `which no declared box describes: ` +
            d.diagonal.map((g) => `${esc(g.name)} x${String(g.count)}`).join(", ") +
            `.</p>`,
        );
      }
      if (d.unknown.length > 0) {
        gaps.push(
          `<p class="warn">Not in this snapshot at all, so they carry no footprint and no type: ` +
            d.unknown.map((u) => esc(u)).join(", ") +
            `. That usually means a modded print.</p>`,
        );
      }

      const starved =
        d.starved.length > 0 && result
          ? `<h2>Outlined on the drawing: what the audit says is fed short</h2>` +
            `<table><tr><th>item</th><th class="n">shortfall per second</th>` +
            `<th class="n">machines eating it</th></tr>` +
            d.starved
              .map(
                (s) =>
                  `<tr><td>${esc(s.item)}</td><td class="n">${n(s.shortfallPerSecond)}</td>` +
                  `<td class="n">${String(s.entities)}</td></tr>`,
              )
              .join("") +
            `</table>` +
            `<p class="gap">Both numbers are the audit's own. The dashed outline marks the machines ` +
            `the shortfall lands on, which is a join over what the audit already resolved rather ` +
            `than a second opinion about what is short.</p>`
          : "";

      return (
        `<h1>${esc(d.label)}</h1>` +
        `<p class="meta">${String(d.entityCount)} entities, ${size}, drawn at the footprint each ` +
        `prototype declares and the position the print states.</p>` +
        `<figure>${d.svg}<ul class="key">${key}</ul></figure>` +
        gaps.join("") +
        starved
      );
    })
    .join("<hr>");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(input.drawings[0]?.label ?? "Blueprint")} drawn to scale</title>
<style>${PAGE_CSS}</style></head>
<body><main>
${body}
<h2>Where this comes from</h2>
<p class="gap">${esc(input.snapshot)}<br>Decoded from ${esc(input.source)}.
Every footprint is the prototype's <code>selection_box</code>, never its collision box, which is
inset for movement. Direction 4 is East and 12 is West, measured from underground belt pairs in
the shipped prints rather than recalled, and both swap width against height. An arrow is a belt's
travel direction; inserters carry a direction and no arrow, because the print does not say which
of an inserter's two ends that direction names.</p>
</main></body></html>
`;
}
