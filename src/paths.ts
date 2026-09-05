import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Locating the game. Every path is discovered, never assumed, and both roots can
 * be overridden so this works on a machine that is not Soushi's.
 *
 *   FACTORIO_CORE      the install root, the directory holding `data/` and `bin/`
 *   FACTORIO_USERDATA  the user data dir, normally ~/.factorio
 *
 * Nothing here writes. `dump.ts` is the only module that runs the binary, and it
 * redirects the engine's write-data into this project.
 */

const HOME = homedir();

const CORE_CANDIDATES = [
  join(HOME, ".steam/steam/steamapps/common/Factorio"),
  join(HOME, ".steam/debian-installation/steamapps/common/Factorio"),
  join(HOME, ".local/share/Steam/steamapps/common/Factorio"),
  join(HOME, "Steam/steamapps/common/Factorio"),
  "/usr/share/factorio",
  join(HOME, "factorio"),
];

const USERDATA_CANDIDATES = [
  join(HOME, ".factorio"),
  join(HOME, ".local/share/factorio"),
];

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** An install root is real when it carries the base mod's prototypes. */
function looksLikeCore(root: string): boolean {
  return isDir(join(root, "data", "base", "prototypes"));
}

export function findCore(): string {
  const override = process.env.FACTORIO_CORE;
  if (override) {
    const root = resolve(override);
    if (!looksLikeCore(root)) {
      throw new Error(
        `FACTORIO_CORE is set to ${root} but there is no data/base/prototypes there.`,
      );
    }
    return root;
  }
  for (const c of CORE_CANDIDATES) {
    if (looksLikeCore(c)) return c;
  }
  throw new Error(
    "Could not find a Factorio install. Set FACTORIO_CORE to the directory holding data/ and bin/.",
  );
}

/** The user data dir is only needed to report on it, never to write to it. */
export function findUserdata(): string | null {
  const override = process.env.FACTORIO_USERDATA;
  if (override) {
    const dir = resolve(override);
    return isDir(dir) ? dir : null;
  }
  for (const c of USERDATA_CANDIDATES) {
    if (isDir(c)) return c;
  }
  return null;
}

export function findBinary(core: string): string {
  const candidates = [
    join(core, "bin", "x64", "factorio"),
    join(core, "bin", "linux64", "factorio"),
    join(core, "factorio"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`No factorio executable under ${join(core, "bin")}.`);
}

/** Everything this project writes lives under here, and nowhere else. */
export const PROJECT_ROOT = resolve(import.meta.dir, "..");
export const DATA_DIR = join(PROJECT_ROOT, "data");
export const SNAPSHOT_PATH = join(DATA_DIR, "data-raw.json");
export const MANIFEST_PATH = join(DATA_DIR, "manifest.json");
/** The engine's redirected write-data. Keeps ~/.factorio untouched. */
export const RUNTIME_DIR = join(PROJECT_ROOT, ".factorio-runtime");
