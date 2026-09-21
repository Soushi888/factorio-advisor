import type { Blueprint, BpEntity } from "./blueprint.ts";
import type { AuditResult } from "./audit.ts";
import type { Data, Proto } from "./proto.ts";
import { place as placeOf, type Box, type Placed as Geometry } from "./layout.ts";

/**
 * What the drawing needs on top of the geometry: which family a thing belongs
 * to, for the colour behind it and for the legend. The geometry itself is
 * `layout.ts`'s, so the audit and the page cannot disagree about a size.
 */
export interface Placed extends Geometry {
  family: string;
}

/** The geometry, plus the display family this drawing sorts by. */
export function place(data: Data, entity: BpEntity): Placed {
  const geometry = placeOf(data, entity);
  return { ...geometry, family: familyOf(geometry.type) };
}
import { PIXELS_PER_TILE, beltCut, dataUri, iconCut, spritesFor, type SpriteCut } from "./sprites.ts";
import { beltShapes } from "./belt-shape.ts";

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
  /** One row per prototype in the print, with its own item icon. */
  census: Array<{ name: string; count: number; icon: string | null }>;
  /** Entities drawn with the game's own sprite. */
  sprited: number;
  /** Prototypes the install has no resolvable sprite for, drawn as a box. */
  spriteless: Array<{ name: string; count: number }>;
  /** Sprites that declare a tint this tool does not apply. */
  tinted: number;
}

function n(v: number): string {
  return v.toFixed(2).replace(/\.?0+$/, "");
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

const SVG_CSS = `
  .grid { fill:none; stroke:#232830; stroke-width:1; vector-effect:non-scaling-stroke; }
  .fp { fill:var(--c); fill-opacity:.55; stroke:var(--c); stroke-width:1.1;
        vector-effect:non-scaling-stroke; stroke-linejoin:round; }
  .dir { fill:none; stroke:#f2e37a; stroke-width:1.3; stroke-linecap:round;
         vector-effect:non-scaling-stroke; opacity:.75; }
  .arrows { opacity:.9; }
  /* The category boxes are the fallback, not the drawing: a prototype with a
     sprite is shown as itself, and the boxes are a layer the page turns on. */
  .schematic { display:none; }
  .shadows { opacity:.5; }
  image { image-rendering:auto; }
  .starved { fill:none; stroke:#ffffff; stroke-width:2.2; stroke-dasharray:4 2.5;
             vector-effect:non-scaling-stroke; }
`;

function rect(b: Box): string {
  return `M${n(b.x1)} ${n(b.y1)}h${n(b.x2 - b.x1)}v${n(b.y2 - b.y1)}h${n(b.x1 - b.x2)}z`;
}

/**
 * One entity's game sprites, placed in tile coordinates.
 *
 * A sprite is not the footprint and is not meant to be: an assembling machine
 * occupies three tiles and its picture is 3.34 tiles across, because the art
 * overhangs on purpose. So the placement is the sprite's own declared size and
 * shift around the entity's centre, never the box, and the two disagreeing is
 * the drawing being right rather than a bug.
 *
 * A tile is 32 pixels at scale 1, which is why the size divides by that and by
 * nothing else.
 */
function spriteShapes(cuts: SpriteCut[], cx: number, cy: number, shadow: boolean): string {
  const out: string[] = [];
  for (const cut of cuts) {
    if (cut.shadow !== shadow) continue;
    const uri = dataUri(cut);
    if (!uri) continue;
    const w = (cut.w * cut.scale) / PIXELS_PER_TILE;
    const h = (cut.h * cut.scale) / PIXELS_PER_TILE;
    out.push(
      `<image href="${uri}" x="${n(cx + cut.shiftX - w / 2)}" y="${n(cy + cut.shiftY - h / 2)}" ` +
        `width="${n(w)}" height="${n(h)}"/>`,
    );
  }
  return out.join("");
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

  // One lookup from a prototype name to its declared type, for the belt pass.
  const placedType = new Map<string, string>();
  for (const p of placed) placedType.set(p.entity.name, p.type);

  const byName = new Map<string, number>();
  for (const p of placed) byName.set(p.entity.name, (byName.get(p.entity.name) ?? 0) + 1);
  // The legend is the print's own census with the game's icons beside it, so a
  // row on the page and a silhouette on the drawing are the same thing.
  const census = [...byName]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => {
      const cut = iconCut(data, name);
      return { name, count, icon: cut ? dataUri(cut) : null };
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

  // The sprites, in the order the game itself draws them: every shadow first,
  // flattened onto the ground, then the entities from the back of the picture
  // to the front, so a tall machine overlaps the belt behind it rather than the
  // other way round. Sorting by y and then x is the whole of that rule.
  const painter = [...placed].sort(
    (a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1,
  );
  const shadows: string[] = [];
  const bodies: string[] = [];
  const spriteless = new Map<string, number>();
  let sprited = 0;
  let tinted = 0;
  // Every belt's picture comes from what its neighbours do, which is the whole
  // print, so it is worked out once before anything is drawn.
  const shapes = beltShapes(entities, (name) => placedType.get(name) ?? "");

  for (const p of painter) {
    const shape = shapes.get(p.entity.entity_number);
    const cuts = spritesFor(data, {
      name: p.entity.name,
      direction: p.direction,
      kind: String(p.entity["type"] ?? ""),
      beltRow: shape?.row,
    });
    if (cuts.length === 0) {
      spriteless.set(p.entity.name, (spriteless.get(p.entity.name) ?? 0) + 1);
      continue;
    }
    const cx = (p.box.x1 + p.box.x2) / 2;
    const cy = (p.box.y1 + p.box.y2) / 2;
    const shadow = spriteShapes(cuts, cx, cy, true);
    const body = spriteShapes(cuts, cx, cy, false);
    if (!body) {
      spriteless.set(p.entity.name, (spriteless.get(p.entity.name) ?? 0) + 1);
      continue;
    }
    sprited += 1;
    tinted += cuts.filter((c) => c.tint).length;
    if (shadow) shadows.push(shadow);
    // The start and end caps are extra rows of the same sheet, drawn over the
    // tile's own surface exactly as the game stacks them.
    const caps = (shape?.caps ?? [])
      .map((row) => beltCut(data, p.entity.name, row))
      .filter((c): c is SpriteCut => c !== null);
    const capArt = caps.length > 0 ? spriteShapes(caps, cx, cy, false) : "";
    bodies.push(`<g><title>${esc(p.entity.name)}</title>${body}${capArt}</g>`);
  }

  const parts: string[] = [];
  if (shadows.length > 0) parts.push(`<g class="shadows">${shadows.join("")}</g>`);
  if (bodies.length > 0) parts.push(`<g class="art">${bodies.join("")}</g>`);

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
    // Two box layers, and the difference between them is the honest part. The
    // `gap` one is for entities that have no sprite: it is what the drawing has
    // instead of a picture, so it is always on. The `schematic` one is every
    // entity, off by default, there for reading a layout by category rather
    // than by silhouette.
    const missing = list.filter((p) => spriteless.has(p.entity.name));
    parts.push(
      `<g class="fam schematic" data-family="${family.id}" style="--c:${family.colour}">` +
        `<title>${esc(family.label)}: ${esc(tip)}</title>` +
        `<path class="fp" d="${list.map((p) => rect(p.box)).join("")}"/>` +
        `</g>`,
    );
    if (missing.length > 0) {
      parts.push(
        `<g class="fam gap" data-family="${family.id}" style="--c:${family.colour}">` +
          `<path class="fp" d="${missing.map((p) => rect(p.box)).join("")}"/>` +
          `</g>`,
      );
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
    census,
    sprited,
    spriteless: [...spriteless].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    tinted,
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
  ul.key img.ico { width:1.15rem; height:1.15rem; display:inline-block; }
  input.toggle { position:absolute; opacity:0; pointer-events:none; }
  label[for^="sch"] { cursor:pointer; text-decoration:underline dotted; }
  .swatches { display:none; margin-left:.75rem; }
  .swatches ul.key { display:inline-flex; margin:0; }
  input.toggle:checked + figure .schematic { display:inline; }
  input.toggle:checked + figure .swatches { display:inline-block; }
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
      const key = d.census
        .map(
          (c) =>
            `<li>` +
            (c.icon ? `<img class="ico" src="${c.icon}" alt="">` : `<i></i>`) +
            `${esc(c.name)} <span class="gap">${String(c.count)}</span></li>`,
        )
        .join("");
      const colours = d.families
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
      if (d.spriteless.length > 0) {
        gaps.push(
          `<p class="gap">Drawn as a category box because this installation has no sprite this ` +
            `tool could resolve for them: ` +
            d.spriteless.map((g) => `${esc(g.name)} x${String(g.count)}`).join(", ") +
            `. The box is the fallback, not a failure.</p>`,
        );
      }
      if (d.sprited > 0) {
        gaps.push(
          `<p class="gap">${String(d.sprited)} of ${String(d.entityCount)} entities are drawn with ` +
            `the game's own art, read out of the installation and cut to the cell each prototype ` +
            `declares. Belts are shaped the way the engine shapes them: a belt fed from the side is ` +
            `drawn as the curve, one nothing feeds gets its start cap, one whose output goes nowhere ` +
            `gets its end cap, and only a belt fed from behind is the plain straight, so a corner ` +
            `reads as a corner and a dead end as a dead end. Two things the drawing still does not ` +
            `do: a pipe is drawn as a straight run rather than a junction, and an inserter is drawn ` +
            `as its base without its hand, because the string says which way it faces and not which ` +
            `of its two ends that names.` +
            (d.tinted > 0
              ? ` ${String(d.tinted)} layers declare a tint this tool does not apply.`
              : "") +
            `</p>`,
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
        `<input type="checkbox" class="toggle" id="sch${String(i)}">` +
        `<figure>${d.svg}` +
        `<ul class="key">${key}</ul>` +
        // A div and not a paragraph: a list inside a `p` is invalid, the parser
        // closes the paragraph at the `ul`, and the swatches escape the element
        // whose rule was hiding them. Measured on this page, not assumed.
        `<div class="gap"><label for="sch${String(i)}">Show the category boxes over the art</label>` +
        `<span class="swatches"><ul class="key">${colours}</ul></span></div>` +
        `</figure>` +
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
the shipped prints rather than recalled, and both swap width against height. A belt's own picture
carries its direction, because a belt sheet holds four straights, eight curves and eight end caps
and the right one is chosen from what the tile's neighbours do, which is how the engine chooses
it. Inserters carry a direction and no marker, because the print does not say which of an
inserter's two ends that direction names.</p>
</main></body></html>
`;
}
