import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { findCore } from "../src/paths.ts";

/**
 * The page as a live board: Soushi plays with it open, and the session watching
 * it wakes on every save and can answer him on the page.
 *
 * Nothing here is a second live layer. The SoushAI drawer, the chat, the
 * listener dot, the reload on a new build and the event tail are Niceboard's
 * live mode (`Live.ts`), loaded at runtime from the path in `NICEBOARD_LIVE`,
 * the way darkest-dungeon-advisor finds the Niceboard compiler through
 * `NICEBOARD`. Without it the loop runs as before and the page is served plain.
 *
 * What this module adds is what Niceboard cannot know about this page:
 *
 * - The page points at the game's own fonts and icons by `file://` URL, because
 *   that art is Wube's and is never copied here. A page served over http cannot
 *   load a `file://` URL, so the served copy rewrites the install prefix to
 *   `/install/`, which answers read-only from the install `paths.ts` found, and
 *   only for pictures and fonts under its `data/` folder. The file on disk keeps
 *   its `file://` URLs, so opening it directly still works offline.
 * - Every report the loop writes is one `SAVE` event in the folder's event log,
 *   in the format Niceboard's tail reads, so a session tailing the board wakes
 *   on a save without being told.
 */

export const BOARD = "index.html";

/** The fields of Niceboard's Live.ts this module uses; the rest of the module is its own business. */
interface LiveModule {
  inject(html: string, file: string, version: string, base?: string): string;
  liveResponse(
    dir: string,
    req: Request,
    path: string,
    lastSent: Map<string, { text: string; at: string; t: number }>,
  ): Promise<Response | null>;
  event(dir: string, e: Record<string, unknown>): void;
}

export function livePath(): string {
  return process.env.NICEBOARD_LIVE ?? join(homedir(), ".claude", "skills", "Niceboard", "Tools", "Live.ts");
}

let loaded: Promise<LiveModule | null> | null = null;

/** Niceboard's live module, or null when it is not installed: the board is then served without a drawer. */
export function loadLive(): Promise<LiveModule | null> {
  loaded ??= (async () => {
    const p = livePath();
    if (!existsSync(p)) return null;
    try {
      const m = (await import(p)) as Partial<LiveModule>;
      return m.inject && m.liveResponse && m.event ? (m as LiveModule) : null;
    } catch {
      return null;
    }
  })();
  return loaded;
}

/**
 * One line in the event log per report, the shape `Live.ts tail` prints as
 * `SAVE <time> index.html`. Written by hand when Niceboard is absent, since the
 * format is the contract and not the module.
 */
export async function saveEvent(dir: string, e: { save: string; tick: number; report: string; quiet: boolean; first: boolean }): Promise<void> {
  const body = { kind: "SAVE", board: BOARD, ...e };
  const live = await loadLive();
  if (live) {
    live.event(dir, body);
    return;
  }
  mkdirSync(join(dir, ".live"), { recursive: true });
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  appendFileSync(join(dir, ".live", "events.log"), JSON.stringify({ at: new Date().toISOString(), time, ...body }) + "\n");
}

/** The install prefixes the page writes: `pathToFileURL` for the fonts, a bare `file://` + path for the icons. */
function installPrefixes(core: string): string[] {
  const root = resolve(core);
  return [...new Set([`${pathToFileURL(root).href}/`, `file://${root}/`])];
}

/** The page with every install URL pointed at this server's read-only `/install/` instead. */
export function rewriteInstall(html: string, core: string): string {
  let out = html;
  for (const p of installPrefixes(core)) out = out.split(p).join("/install/");
  return out;
}

const INSTALL_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/** A picture or font under the install's data folder, or null for anything else. */
export function installFile(core: string, rel: string): { path: string; type: string } | null {
  let name: string;
  try {
    name = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const type = INSTALL_TYPES[extname(name).toLowerCase()];
  if (!type) return null;
  const data = resolve(core, "data");
  const p = resolve(core, name);
  if (!p.startsWith(data + sep) || !existsSync(p) || !statSync(p).isFile()) return null;
  // A symlink inside the install must not lead out of it.
  const real = realpathSync(p);
  if (!real.startsWith(realpathSync(data) + sep)) return null;
  return { path: real, type };
}

/**
 * The page and its live endpoints, for the loop's own server. Returns null for
 * a path it does not own, so the caller's other routes still answer.
 *
 * Loopback is no boundary for a browser, so the same rule as Niceboard's own
 * server holds here: only a loopback Host, and no request carrying another
 * site's Origin. The page is the only same-origin caller.
 */
export async function boardResponse(
  dir: string,
  req: Request,
  port: number,
  lastSent: Map<string, { text: string; at: string; t: number }>,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const ours = path === "/" || path === `/${BOARD}` || path.startsWith("/install/") || path.startsWith("/live/");
  if (!ours) return null;
  const origin = req.headers.get("origin");
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || (origin && origin !== `http://${url.hostname}:${String(port)}`)) {
    return new Response("forbidden", { status: 403 });
  }
  const nostore = { "cache-control": "no-store" };
  let core: string;
  try {
    core = findCore();
  } catch {
    core = "";
  }

  if (path.startsWith("/install/")) {
    const f = core ? installFile(core, path.slice("/install/".length)) : null;
    if (!f) return new Response("not found", { status: 404 });
    return new Response(Bun.file(f.path), { headers: { "content-type": f.type, "cache-control": "max-age=3600" } });
  }

  const live = await loadLive();
  if (path.startsWith("/live/")) {
    if (!live) return new Response("live mode is off: Niceboard's Live.ts was not found", { status: 404 });
    return (await live.liveResponse(dir, req, path, lastSent)) ?? new Response("not found", { status: 404 });
  }

  const file = join(dir, BOARD);
  if (!existsSync(file)) return new Response("no report yet: run bun run report", { status: 404, headers: nostore });
  let html = readFileSync(file, "utf8");
  if (core) html = rewriteInstall(html, core);
  if (live) html = live.inject(html, file, String(statSync(file).mtimeMs));
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...nostore } });
}
