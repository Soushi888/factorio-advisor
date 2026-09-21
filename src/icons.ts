/**
 * The game's own icons, resolved out of the installed game.
 *
 * Soushi asked for the dashboard to use the game's assets so it feels like the
 * game rather than a spreadsheet about it. The icons are not copied into this
 * project and never will be: they are Wube's art, this repo is public, and
 * copying them in would be redistributing it. The page points at the files in
 * his own installation instead, by a `file://` URL, which is the same thing the
 * game does when it loads them.
 *
 * Nothing here is guessed. A prototype declares its own icon path, in the mod
 * notation the data stage uses (`__base__/graphics/icons/iron-plate.png`), and
 * `__base__` is the `base` directory of the install `paths.ts` already located.
 * A prototype with no icon field, or an icon whose file is not on disk, gets no
 * icon and the name stands on its own, because an icon invented for an item is
 * the same class of error as a number invented for one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { findCore } from "./paths.ts";
import type { Data, Raw } from "./proto.ts";

/**
 * Classes to read first, because a name can live in several.
 *
 * `iron-plate` is an item and an ingredient; `locomotive` is an item with
 * entity data AND a locomotive entity, and only one of the two carries the icon
 * a player recognises. These win, and then every remaining class is read in
 * turn, so a prototype class this list has never heard of still gets its icon
 * rather than being silently dropped. The order is the preference, not the
 * inventory.
 */
const ICON_CLASSES = [
  "item",
  "item-with-entity-data",
  "tool",
  "capsule",
  "ammo",
  "module",
  "gun",
  "armor",
  "rail-planner",
  "repair-tool",
  "fluid",
  "recipe",
  "technology",
  "resource",
];

/**
 * The mod a path names, mapped onto the directory it lives in.
 *
 * The three that ship with Space Age, derived from the same install root rather
 * than listed anywhere else in this project. A path naming any other mod is left
 * unresolved on purpose: this snapshot is vanilla, so a `__somemod__` path means
 * the snapshot and the state file have drifted apart, which the commands already
 * report as a mismatch.
 */
function modDir(core: string, mod: string): string | null {
  const known = ["base", "core", "space-age", "elevated-rails", "quality"];
  return known.includes(mod) ? join(core, "data", mod) : null;
}

function pathOf(icon: string, core: string): string | null {
  const m = /^__([a-z0-9-]+)__\/(.+)$/.exec(icon);
  if (!m) return null;
  const dir = modDir(core, m[1]!);
  if (!dir) return null;
  const file = join(dir, m[2]!);
  return existsSync(file) ? file : null;
}

function iconField(proto: Raw): string | null {
  const icon = proto["icon"];
  if (typeof icon === "string") return icon;
  // A layered icon draws several files on top of each other. The first layer is
  // the base image and is what a 16 pixel row needs; the rest are overlays the
  // page has no way to compose and no reason to.
  const icons = proto["icons"];
  if (Array.isArray(icons) && icons.length > 0) {
    const first = icons[0] as Record<string, unknown>;
    if (typeof first["icon"] === "string") return first["icon"];
  }
  return null;
}

/**
 * Every icon the page could want, resolved once.
 *
 * Built as a whole map rather than looked up per row because a dashboard names
 * the same twenty items in six places, and because a miss should cost nothing:
 * an absent name is absent from the map and the caller renders the word alone.
 */
export class Icons {
  private readonly urls = new Map<string, string>();
  readonly available: boolean;

  constructor(data: Data | null) {
    let core: string | null = null;
    try {
      core = findCore();
    } catch {
      core = null;
    }
    this.available = core !== null && data !== null;
    if (!core || !data) return;

    const ordered = [...ICON_CLASSES, ...Object.keys(data.raw).filter((k) => !ICON_CLASSES.includes(k))];
    for (const klass of ordered) {
      for (const [name, proto] of Object.entries(data.klass(klass))) {
        if (this.urls.has(name)) continue;
        const icon = iconField(proto);
        if (!icon) continue;
        const file = pathOf(icon, core);
        if (file) this.urls.set(name, `file://${file}`);
      }
    }
  }

  /** The icon for a prototype name, or null when the install has none. */
  url(name: string): string | null {
    return this.urls.get(name) ?? null;
  }

  get size(): number {
    return this.urls.size;
  }
}
