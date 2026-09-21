import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findCore, PROJECT_ROOT } from "./paths.ts";
import type { Data, Proto } from "./proto.ts";

/**
 * The game's own sprites, cut out of the game's own files.
 *
 * A drawing made of coloured rectangles tells you where things are and nothing
 * about what they are, which is why the first version of `--draw` was useless to
 * look at. Every prototype declares exactly where its picture lives and how to
 * find the right cell in it, so the picture is as derivable as the footprint
 * was, and this file derives it.
 *
 * Nothing here writes to the game directory: the install is opened read only,
 * and every cut-out lands under this project's `.local/sprites/`. The sprites
 * are Wube's, so they stay out of git (`.local/` is ignored) and out of the
 * public repository, and a page that embeds them is for Soushi's screen.
 *
 * Two facts make the cell arithmetic safe rather than a guess:
 *
 *   - **The row length is measured, not defaulted.** A sprite sheet declares a
 *     cell size and sometimes a `line_length`, and the default when it is absent
 *     differs between an animation and a rotated sprite. Reading the PNG header
 *     gives the sheet's real width, so the row length is a division rather than
 *     a convention: `floor(sheetWidth / cellWidth)`.
 *
 *   - **A tile is 32 pixels at scale 1.** The assembling machine 3 sheet is 1712
 *     by 948 for a declared 214 by 237 cell, which is 8 columns by 4 rows for the
 *     32 frames it declares, and 214 * 0.5 / 32 is 3.34 tiles across a machine
 *     whose footprint is 3. Sprites overhang their footprint, which is why the
 *     drawing places them by their own shift and size rather than by the box.
 */

/**
 * Factorio draws one tile as this many sprite pixels at scale 1.
 *
 * Confirmed against the snapshot rather than recalled: assembling machine 3
 * declares a 214 by 237 cell at scale 0.5 for a footprint of 3 by 3, and
 * 214 * 0.5 / 32 is 3.34 tiles, which is a 3 tile machine whose art overhangs.
 * At 64 it would be a 1.7 tile machine, which no sprite in the game is.
 */
export const PIXELS_PER_TILE = 32;

/** Where the cut-out sprites are cached, inside this project. */
const SPRITE_CACHE = join(PROJECT_ROOT, ".local", "sprites");

export interface SpriteCut {
  /** Absolute path of the sheet in the game install. */
  file: string;
  /** The cell, in sheet pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Declared scale: sprite pixels per screen pixel. */
  scale: number;
  /** Declared shift from the entity's centre, in tiles. */
  shiftX: number;
  shiftY: number;
  /** Drawn under everything, flattened and dark. */
  shadow: boolean;
  /** A tint the prototype declares and this tool does not apply. */
  tint: boolean;
}

/** Resolve `__base__/graphics/...` against the install, or null when it is not there. */
export function resolvePath(declared: string): string | null {
  const m = /^__([a-z0-9-]+)__\/(.*)$/.exec(declared);
  if (!m) return null;
  const [, mod, rest] = m;
  const file = join(findCore(), "data", mod!, rest!);
  return existsSync(file) ? file : null;
}

/** Width and height from a PNG's IHDR, without decoding the image. */
export function pngSize(file: string): { w: number; h: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(24);
    readSync(fd, head, 0, 24, 0);
    if (head.toString("latin1", 1, 4) !== "PNG") return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

type Rec = Record<string, unknown>;

function num(o: Rec, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rec(v: unknown): Rec | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null;
}

function shiftOf(o: Rec): [number, number] {
  const s = o["shift"];
  if (Array.isArray(s) && s.length === 2) return [Number(s[0]) || 0, Number(s[1]) || 0];
  const r = rec(s);
  if (r) return [Number(r["x"]) || 0, Number(r["y"]) || 0];
  return [0, 0];
}

/**
 * The sixteenth of a turn this entity faces, as an index into a rotated sheet.
 *
 * Factorio 2.0 counts sixteen directions and a sheet declares how many of them
 * it draws, so a four-direction sheet takes every fourth one. Belts are the
 * exception and are handled where they are read, because their twenty rows are
 * not twenty angles: they are four straights, eight curves and eight ends.
 */
function directionIndex(direction: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round((direction * count) / 16) % count;
}

/**
 * One leaf of the sprite tree: something carrying a filename and a cell size.
 *
 * `frame` and `dir` select the cell. The row length comes from the sheet itself
 * rather than from the declaration's default, because that default is one value
 * for an animation and another for a rotated sprite, and reading the file is
 * cheaper than being right about which one applies.
 */
function cutOf(leaf: Rec, direction: number): SpriteCut | null {
  const declared =
    typeof leaf["filename"] === "string"
      ? (leaf["filename"] as string)
      : Array.isArray(leaf["filenames"]) && typeof leaf["filenames"][0] === "string"
        ? (leaf["filenames"][0] as string)
        : null;
  if (!declared) return null;
  const file = resolvePath(declared);
  if (!file) return null;

  const size = num(leaf, "size");
  const w = num(leaf, "width") ?? size;
  const h = num(leaf, "height") ?? size;
  if (w === null || h === null || w <= 0 || h <= 0) return null;

  const sheet = pngSize(file);
  if (!sheet) return null;

  const baseX = num(leaf, "x") ?? 0;
  const baseY = num(leaf, "y") ?? 0;
  const frames = num(leaf, "frame_count") ?? 1;
  const dirs = num(leaf, "direction_count") ?? 1;
  const perRow = Math.max(1, Math.floor((sheet.w - baseX) / w));

  // Frames of one direction are contiguous, and a sheet wraps at its own width.
  const index = directionIndex(direction, dirs) * frames;
  const col = index % perRow;
  const row = Math.floor(index / perRow);

  const x = baseX + col * w;
  const y = baseY + row * h;
  if (x + w > sheet.w || y + h > sheet.h) return null;

  const [sx, sy] = shiftOf(leaf);
  return {
    file,
    x,
    y,
    w,
    h,
    scale: num(leaf, "scale") ?? 1,
    shiftX: sx,
    shiftY: sy,
    shadow: leaf["draw_as_shadow"] === true || leaf["draw_as_glow"] === true,
    tint: "tint" in leaf || leaf["apply_runtime_tint"] === true,
  };
}

/** A field whose name contains one of these holds a picture of something. */
const PICTURE_WORDS = ["picture", "sprite", "animation", "graphics", "structure", "visualisation"] as const;

const DIRECTION_KEYS = ["north", "east", "south", "west"] as const;

/**
 * The two ways a prototype names its four sides.
 *
 * A machine's structure is keyed by compass point and a pipe's ends are keyed
 * by screen direction, and both mean the same four rotations in the same order
 * starting at north.
 */
const COMPASSES = [DIRECTION_KEYS, ["up", "right", "down", "left"] as const] as const;


/**
 * Where a prototype keeps its picture, in the order worth trying.
 *
 * Ordered by how much of the entity the field draws. `structure` comes before
 * `belt_animation_set` on purpose: an underground belt and a loader declare
 * both, and the one that makes them recognisable is the mouth, not the belt
 * surface they share with every other belt in the game. The list is field names
 * rather than prototype types, which is why it covers prototypes this tool has
 * never been told about.
 */
const GRAPHICS_FIELDS = [
  "structure",
  "base",
  "graphics_set",
  "belt_animation_set",
  "animation_set",
  "animation",
  "idle_animation",
  "sprite",
  "sheet",
  "rotated",
  "idle",
  "animations",
  "picture",
  "pictures",
  "platform_picture",
  "base_picture",
  "sprites",
  "connection_sprites",
  "vertical_animation",
  "idle_animation",
  "folded_animation",
  "off_animation",
] as const;

/**
 * Walk whatever shape a graphics field happens to be.
 *
 * The prototypes use half a dozen shapes for the same idea: a leaf with a
 * filename, `layers` stacked back to front, `sheet` or `sheets` as a shorthand
 * for the same thing, a four-way object keyed by compass name, an in-and-out
 * pair for anything with a mouth, and a set of named connection variants for a
 * pipe. They nest, so this recurses and flattens, and anything it does not
 * recognise returns nothing rather than a guess.
 */
function walk(node: unknown, direction: number, kind: string, depth = 0): SpriteCut[] {
  if (depth > 8) return [];

  // A bare array is a list of VARIATIONS of one thing, so it contributes one
  // picture and not all of them. `layers` and `sheets` are the opposite, are
  // reached by their own key below, and are all drawn.
  if (Array.isArray(node)) return walk(node[0], direction, kind, depth + 1);

  const o = rec(node);
  if (!o) return [];

  // A leaf wins over anything nested inside it: a sprite that declares its own
  // file IS the sprite, and the nested keys below are containers for one.
  const leaf = cutOf(o, direction);
  if (leaf) return [leaf];

  for (const stack of ["layers", "sheets"] as const) {
    const list = o[stack];
    if (Array.isArray(list)) {
      return list.flatMap((l) => walk(l, direction, kind, depth + 1));
    }
  }

  // An underground belt or a loader draws its mouth, and which mouth depends on
  // whether the print says this end takes items in or puts them out.
  if ("direction_in" in o || "direction_out" in o) {
    const key = kind === "output" ? "direction_out" : "direction_in";
    return walk(o[key] ?? o["direction_in"] ?? o["direction_out"], direction, kind, depth + 1);
  }

  // A pipe's picture depends on its neighbours, which a print states and this
  // tool does not yet read, so it draws the straight run its own direction
  // implies and the page says that connections are not inferred.
  if ("straight_vertical" in o || "straight_horizontal" in o) {
    const vertical = directionIndex(direction, 4) % 2 === 0;
    const key = vertical ? "straight_vertical" : "straight_horizontal";
    return walk(o[key] ?? o["straight_vertical"] ?? o["single"], direction, kind, depth + 1);
  }

  for (const compass of COMPASSES) {
    const present = compass.find((k) => k in o);
    if (!present) continue;
    const key = compass[directionIndex(direction, 4)]!;
    return walk(o[key] ?? o[present], direction, kind, depth + 1);
  }

  // The same ordered field list the resolver uses at the top level, because a
  // container nests: an electromagnetic plant keeps its picture at
  // `graphics_set.idle_animation`, and a descent list that knew only
  // `animation` left it with no sprite at all while every other machine had one.
  for (const nested of GRAPHICS_FIELDS) {
    if (!(nested in o)) continue;
    const cuts = walk(o[nested], direction, kind, depth + 1);
    if (cuts.length > 0) return cuts;
  }

  // Last resort, and the reason the list above stays short: any field whose own
  // NAME says it holds a picture. An accumulator keeps one under
  // `chargable_graphics`, a beacon under `graphics_set.animation_list`, a lamp
  // under `picture_off`, and naming each of those is how a list rots one
  // Factorio version later. This is the same move `proto.ts` makes with classes:
  // group by the fields a prototype carries, never by a table of names.
  for (const [key, value] of Object.entries(o)) {
    if (!PICTURE_WORDS.some((w) => key.includes(w))) continue;
    const cuts = walk(value, direction, kind, depth + 1);
    if (cuts.length > 0) return cuts;
  }
  return [];
}


/** What the drawing knows about one placed thing: enough to pick its picture. */
export interface SpriteSubject {
  name: string;
  direction?: number;
  /** An underground belt or loader end: "input" or "output", as the print says. */
  kind?: string;
}

function entityProto(data: Data, name: string): Proto | null {
  const list = data.all(name);
  return list.find((p) => "selection_box" in p) ?? null;
}

/**
 * Every layer to draw for one entity, back to front, or an empty list.
 *
 * A belt is read from `belt_animation_set.animation_set`, whose twenty rows are
 * the straights, the curves and the ends rather than twenty angles, so the row
 * is the direction over four and a curved belt is drawn straight. Everything
 * else goes through the generic walk.
 */
export function spritesFor(data: Data, entity: SpriteSubject): SpriteCut[] {
  const proto = entityProto(data, entity.name);
  if (!proto) return [];
  const direction = entity.direction ?? 0;
  const kind = entity.kind ?? "input";

  // A belt's twenty rows are four straights, eight curves and eight ends rather
  // than twenty angles, so the row is the direction over four. A curved belt is
  // drawn straight: which way it bends depends on its neighbours, and the page
  // says so rather than the drawing guessing.
  if (String(proto["type"] ?? "") === "transport-belt") {
    const set = rec(rec(proto["belt_animation_set"])?.["animation_set"]);
    const cut = set ? cutOf({ ...set, direction_count: 4 }, direction) : null;
    if (cut) return [cut];
  }

  // The prototype itself is the last node walked, which is what lets the name
  // scan inside `walk` reach a field nobody listed: an accumulator's
  // `chargable_graphics`, a lamp's `picture_off`, a mine's `picture_safe`.
  return walk(proto, direction, kind);
}

/**
 * One of the game's own interface sprites, by the name the engine knows it as.
 *
 * `utility-sprites` is a single prototype holding every sprite the game draws
 * that does not belong to an entity: the arrow it puts over a belt to show which
 * way it runs, the lines it draws between an underground pair, the alert
 * markers. Drawing our own arrow instead was a small lie about whose picture it
 * was, and the real one is one lookup away.
 */
export function utilityCut(data: Data, name: string): SpriteCut | null {
  for (const proto of Object.values(data.klass("utility-sprites"))) {
    const leaf = rec((proto as Rec)[name]);
    if (!leaf) continue;
    const cut = cutOf(leaf, 0);
    if (cut) return cut;
  }
  return null;
}

/**
 * The item icon for a name, as a cut like any other.
 *
 * An icon file is a strip of mipmaps, the full size first and then each half
 * beside it, which is why this takes the leading square rather than the whole
 * file: a legend that used the file would show the icon and three shrinking
 * copies of it. The square's side is the prototype's own `icon_size`, and 64
 * only when it declares none.
 */
export function iconCut(data: Data, name: string): SpriteCut | null {
  for (const proto of data.all(name)) {
    const icon = proto["icon"];
    const icons = proto["icons"];
    const declared =
      typeof icon === "string"
        ? icon
        : Array.isArray(icons) && rec(icons[0]) && typeof rec(icons[0])!["icon"] === "string"
          ? (rec(icons[0])!["icon"] as string)
          : null;
    if (!declared) continue;
    const file = resolvePath(declared);
    if (!file) continue;
    const sheet = pngSize(file);
    if (!sheet) continue;
    const side = num(proto as Rec, "icon_size") ?? Math.min(sheet.w, sheet.h);
    return {
      file,
      x: 0,
      y: 0,
      w: Math.min(side, sheet.w),
      h: Math.min(side, sheet.h),
      scale: 1,
      shiftX: 0,
      shiftY: 0,
      shadow: false,
      tint: false,
    };
  }
  return null;
}

/**
 * Cut one cell out and return it as a PNG, cached on disk.
 *
 * ImageMagick does the pixels. It is the one piece of this that is not a
 * derivation, so it is isolated here: the arithmetic that can be wrong lives
 * above, in TypeScript, and the part that only moves bytes is a subprocess.
 * Arguments are passed as an array, never interpolated into a shell.
 */
export function cutFile(cut: SpriteCut): string | null {
  mkdirSync(SPRITE_CACHE, { recursive: true });
  const stem = cut.file.replace(/^.*\/data\//, "").replace(/[^a-zA-Z0-9]+/g, "-");
  const out = join(SPRITE_CACHE, `${stem}-${String(cut.x)}-${String(cut.y)}-${String(cut.w)}x${String(cut.h)}.png`);
  if (existsSync(out)) return out;

  const proc = Bun.spawnSync([
    "convert",
    cut.file,
    "-crop",
    `${String(cut.w)}x${String(cut.h)}+${String(cut.x)}+${String(cut.y)}`,
    "+repage",
    out,
  ]);
  if (proc.exitCode !== 0 || !existsSync(out)) return null;
  return out;
}

/** True when the cutter is available at all, so a missing one is a stated gap. */
export function cutterAvailable(): boolean {
  return Bun.spawnSync(["convert", "-version"]).exitCode === 0;
}

const dataUris = new Map<string, string>();

/** One cell as a `data:` URI, so the page is a single file Soushi can move. */
export function dataUri(cut: SpriteCut): string | null {
  const key = `${cut.file}|${String(cut.x)}|${String(cut.y)}|${String(cut.w)}|${String(cut.h)}`;
  const hit = dataUris.get(key);
  if (hit !== undefined) return hit || null;

  const file = cutFile(cut);
  if (!file) {
    dataUris.set(key, "");
    return null;
  }
  const uri = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  dataUris.set(key, uri);
  return uri;
}

/** Bytes written under `.local/sprites/` so far, for the page to report. */
export function cacheDir(): string {
  return SPRITE_CACHE;
}

/** Write a sprite out under a chosen name, for probes that want to look at one. */
export function writeCut(cut: SpriteCut, to: string): boolean {
  const file = cutFile(cut);
  if (!file) return false;
  writeFileSync(to, readFileSync(file));
  return true;
}
