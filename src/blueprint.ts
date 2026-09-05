import { deflateSync, inflateSync } from "node:zlib";

/**
 * Blueprint strings.
 *
 * The format is documented and stable: one version character, then base64 of a
 * zlib deflate of a JSON object. The local blueprint library
 * (`blueprint-storage-2.dat`) is a different, undocumented binary format and is
 * deliberately never read.
 */

export interface BpPosition {
  x: number;
  y: number;
}

export interface BpEntity {
  entity_number: number;
  name: string;
  position: BpPosition;
  direction?: number;
  recipe?: string;
  recipe_quality?: string;
  quality?: string;
  items?: unknown;
  [key: string]: unknown;
}

export interface Blueprint {
  item: string;
  label?: string;
  description?: string;
  entities?: BpEntity[];
  tiles?: Array<{ name: string; position: BpPosition }>;
  icons?: unknown[];
  version?: number;
  [key: string]: unknown;
}

export interface BlueprintBook {
  item: string;
  label?: string;
  blueprints?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export type Decoded = Record<string, unknown>;

export function decode(text: string): Decoded {
  const s = text.trim().replace(/\s+/g, "");
  if (s.length === 0) throw new Error("Empty blueprint string.");
  const version = s[0]!;
  if (version !== "0") {
    throw new Error(
      `Unsupported blueprint string version "${version}". Only version 0 exists so far.`,
    );
  }
  const payload = s.slice(1);
  let json: string;
  try {
    json = inflateSync(Buffer.from(payload, "base64")).toString("utf8");
  } catch (err) {
    throw new Error(
      `That does not decode as a blueprint string (${(err as Error).message}). Paste the whole string, starting with 0.`,
    );
  }
  return JSON.parse(json) as Decoded;
}

export function encode(obj: Decoded): string {
  return "0" + deflateSync(Buffer.from(JSON.stringify(obj), "utf8"), { level: 9 }).toString("base64");
}

/** Flatten a book into the blueprints it holds, keeping a readable path. */
export function flatten(decoded: Decoded, path = ""): Array<{ path: string; bp: Blueprint }> {
  const out: Array<{ path: string; bp: Blueprint }> = [];

  const bp = decoded["blueprint"];
  if (bp && typeof bp === "object") {
    const b = bp as Blueprint;
    out.push({ path: path || b.label || "blueprint", bp: b });
    return out;
  }

  const book = decoded["blueprint_book"];
  if (book && typeof book === "object") {
    const bk = book as BlueprintBook;
    const label = bk.label ?? "book";
    const kids = Array.isArray(bk.blueprints) ? bk.blueprints : [];
    for (const kid of kids) {
      if (!kid || typeof kid !== "object") continue;
      const sub = flatten(kid as Decoded, path ? `${path} / ${label}` : label);
      out.push(...sub);
    }
    return out;
  }

  // Upgrade and deconstruction planners carry no entities to audit.
  return out;
}

/** What kind of thing the string held, for a clear message when it holds nothing. */
export function describeKind(decoded: Decoded): string {
  for (const k of Object.keys(decoded)) return k.replace(/_/g, " ");
  return "unknown";
}

export interface ModuleSlotUse {
  name: string;
  quality: string;
  count: number;
}

/**
 * Modules inside an entity. Factorio 2.0 writes an `items` array of
 * `{id: {name, quality}, items: {in_inventory: [...]}}`; 1.x wrote a plain
 * `{name: count}` map. Both are read so an older export still audits.
 */
export function entityModules(entity: BpEntity): ModuleSlotUse[] {
  const items = entity.items;
  if (!items) return [];

  if (Array.isArray(items)) {
    const out: ModuleSlotUse[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const id = rec["id"];
      let name: string | null = null;
      let quality = "normal";
      if (id && typeof id === "object") {
        const idr = id as Record<string, unknown>;
        if (typeof idr["name"] === "string") name = idr["name"];
        if (typeof idr["quality"] === "string") quality = idr["quality"];
      } else if (typeof rec["item"] === "string") {
        name = rec["item"];
      }
      if (!name) continue;

      let count = 0;
      const holder = rec["items"];
      if (holder && typeof holder === "object") {
        const inv = (holder as Record<string, unknown>)["in_inventory"];
        if (Array.isArray(inv)) {
          for (const slot of inv) {
            if (!slot || typeof slot !== "object") continue;
            const c = (slot as Record<string, unknown>)["count"];
            count += typeof c === "number" ? c : 1;
          }
        }
        const grid = (holder as Record<string, unknown>)["grid_count"];
        if (typeof grid === "number") count += grid;
      }
      if (count === 0 && typeof rec["count"] === "number") count = rec["count"];
      if (count === 0) count = 1;
      out.push({ name, quality, count });
    }
    return out;
  }

  if (typeof items === "object") {
    const out: ModuleSlotUse[] = [];
    for (const [name, count] of Object.entries(items as Record<string, unknown>)) {
      out.push({ name, quality: "normal", count: typeof count === "number" ? count : 1 });
    }
    return out;
  }

  return [];
}
