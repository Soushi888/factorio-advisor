import type { GameState } from "../src/state.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/paths.ts";

/**
 * Milestones: moments of a playthrough the page keeps for when they happen.
 *
 * Every predicate reads the state file, nothing else, and every threshold below is a choice of what is worth marking, not a game fact. A milestone is celebrated only when a read finds it newly true: the first evaluation of a map records whatever is already true as its baseline, silently, so a long game does not open on a flood of old news. The ledger lives at `data/milestones/<seed>.json`, keyed by seed so an autosave and its save share one.
 */

/** Hours on one map worth marking. A choice. */
const HOUR_MARKS = [100, 150, 200, 250, 300, 400, 500, 750, 1000];
/** Technologies researched, as counts worth marking. A choice. */
const TECH_COUNT_MARKS = [150, 175, 200, 225, 250];
/** Lifetime items made, across every item, worth marking. A choice. */
const ITEM_MARKS = [50e6, 100e6, 250e6, 500e6, 1e9];
/** Lifetime iron plates worth marking. A choice. */
const IRON_MARKS = [10e6, 25e6, 50e6, 100e6];
/** Rockets launched worth marking. A choice. */
const ROCKET_MARKS = [1, 10, 100, 1000];

/**
 * Technologies that change what the game is, each with the one line said when it lands. Names checked against the snapshot's `technology` class; a name the snapshot lacks simply never fires.
 */
const KEY_TECHS: Record<string, string> = {
  "rocket-silo": "The silo is yours. Everything until now was the run-up.",
  "space-platform": "A factory with no ground under it. The map just got bigger than the map.",
  "space-science-pack": "Science from orbit. The labs will ask for things the planet cannot give.",
  "planet-discovery-vulcanus": "Vulcanus is on the charts. Lava, and more metal than a lifetime of drills.",
  "planet-discovery-fulgora": "Fulgora is on the charts. Lightning, ruins, and an ocean of scrap.",
  "planet-discovery-gleba": "Gleba is on the charts. A factory that rots if you let it.",
  "planet-discovery-aquilo": "Aquilo is on the charts. The cold edge, where everything must be shipped in.",
  "nuclear-power": "Nuclear power. Steam engines will start to look quaint.",
  "kovarex-enrichment-process": "Kovarex. The uranium question is answered for good.",
  "fusion-reactor": "Fusion. The grid stops being a problem you solve and becomes one you forget.",
  "quantum-processor": "Quantum processors. Few factories get this far.",
  "foundry": "Foundry. Molten metal changes every smelter column you ever built.",
  "recycling": "Recycling. Nothing is waste anymore, only input.",
  "biolab": "The biolab. Even research is grown now.",
  "captive-biter-spawner": "A biter nest, in a cage, working for you. Turnabout.",
  "railgun": "The railgun. Whatever is out there, it now has a reason to worry.",
  "spidertron": "Spidertron. The base will never be walked the same way again.",
  "epic-quality": "Epic quality. The same machines, but better than they have any right to be.",
  "legendary-quality": "Legendary quality. Perfection, in a crafting queue.",
  "atomic-bomb": "The atomic bomb. Please aim carefully.",
  "promethium-science-pack": "Promethium science. The shattered planet's edge, and back.",
  "research-productivity": "Research productivity. Infinite now means something.",
};

export interface Milestone {
  id: string;
  /** The giant word or number. */
  big: string;
  /** The smaller word after it. */
  unit: string;
  lede: string;
  icon?: string;
  /** The hour marks get the whole retrospective; the rest a compact card. */
  full: boolean;
}

export interface Earned extends Milestone {
  tick: number;
  hours: number;
}

function pretty(id: string): string {
  const s = id.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  return Math.round(n).toLocaleString("en-US");
}

function round(n: number): string {
  if (n >= 1e9) return `${String(n / 1e9)} billion`;
  if (n >= 1e6) return `${String(n / 1e6)} million`;
  return n.toLocaleString("en-US");
}

/**
 * Every milestone true of this state. `planets` is the snapshot's `planet` class, which is how a surface named after a planet is told apart from a space platform.
 */
export function milestonesTrue(state: GameState, planets: string[]): Milestone[] {
  const out: Milestone[] = [];
  const f = state.forces["player"];
  const items = f?.production.item ?? {};
  const made = (n: string): number => items[n]?.produced ?? 0;
  const h = state.save.hoursPlayed;

  for (const m of HOUR_MARKS)
    if (h >= m)
      out.push({ id: `hours-${String(m)}`, big: String(m), unit: "hours", full: true,
        lede: m === 100 ? "One hundred hours on one map." : `${String(m)} hours on one map.` });

  const researched = new Set(f?.technologies.researched ?? []);
  for (const m of TECH_COUNT_MARKS)
    if (researched.size >= m)
      out.push({ id: `techs-${String(m)}`, big: String(m), unit: "technologies", icon: "lab", full: false,
        lede: `${String(m)} technologies researched. Every one of them paid for in packs you made.` });
  for (const [tech, line] of Object.entries(KEY_TECHS))
    if (researched.has(tech))
      out.push({ id: `tech-${tech}`, big: pretty(tech), unit: "", icon: tech, full: false, lede: line });

  for (const [name, e] of Object.entries(items))
    if (name.endsWith("-science-pack") && e.produced > 0)
      out.push({ id: `pack-${name}`, big: "First", unit: pretty(name).toLowerCase(), icon: name, full: false,
        lede: `The first ${pretty(name).toLowerCase()} came off the line. A new colour on the belts, a new branch of the tree.` });

  const total = Object.values(items).reduce((n, e) => n + (e.produced ?? 0), 0);
  for (const m of ITEM_MARKS)
    if (total >= m)
      out.push({ id: `items-${String(m)}`, big: compact(m), unit: "items made", icon: "assembling-machine-3", full: false,
        lede: `${round(m)} items, every one crafted, smelted or mined by this factory.` });
  for (const m of IRON_MARKS)
    if (made("iron-plate") >= m)
      out.push({ id: `iron-${String(m)}`, big: compact(m), unit: "iron plates", icon: "iron-plate", full: false,
        lede: `${round(m)} iron plates. The bus has been fed that many times.` });

  const rockets = typeof f?.rocketsLaunched === "number" ? f.rocketsLaunched : 0;
  for (const m of ROCKET_MARKS)
    if (rockets >= m)
      out.push({ id: `rockets-${String(m)}`, big: m === 1 ? "Liftoff" : String(m), unit: m === 1 ? "" : "rockets launched", icon: "rocket-silo", full: false,
        lede: m === 1 ? "The first rocket left the ground. Nauvis is no longer the whole story." : `${String(m)} rockets launched. Orbit is just another stop on the line.` });

  // A surface counts once the force has built on it: the collector maps every surface it can see, and only the force's own things give one bounds.
  const built = (state.map ?? []).filter((s) => s.bounds && Object.keys(s.points ?? {}).length > 0).map((s) => s.name);
  let platform = false;
  for (const name of built) {
    if (name === "nauvis") continue;
    if (planets.includes(name))
      out.push({ id: `surface-${name}`, big: pretty(name), unit: "", icon: name, full: false,
        lede: `First foothold on ${pretty(name)}. A second home, built from nothing, under another sky.` });
    else platform = true;
  }
  if (platform)
    out.push({ id: "surface-platform", big: "In orbit", unit: "", icon: "space-platform-starter-pack", full: false,
      lede: "The first space platform is built. A factory floating above the factory." });

  return out;
}

interface Ledger {
  baseline: string[];
  earned: Array<{ id: string; tick: number; hours: number }>;
}

/**
 * Records what this read newly makes true and returns everything earned so far, oldest first, described by the current definitions.
 *
 * The first read of a map writes the baseline and earns nothing. A milestone, once earned, stays earned even when an older autosave of the same map is read afterwards.
 */
export function recordMilestones(state: GameState, planets: string[], dir = join(DATA_DIR, "milestones")): Earned[] {
  const now = milestonesTrue(state, planets);
  const path = join(dir, `${String(state.save.seed ?? state.save.name.replace(/[^\w-]+/g, "-"))}.json`);
  let ledger: Ledger | null = null;
  try {
    if (existsSync(path)) ledger = JSON.parse(readFileSync(path, "utf8")) as Ledger;
  } catch {
    ledger = null;
  }
  if (!ledger) {
    ledger = { baseline: now.map((m) => m.id), earned: [] };
  } else {
    const known = new Set([...ledger.baseline, ...ledger.earned.map((e) => e.id)]);
    for (const m of now)
      if (!known.has(m.id)) ledger.earned.push({ id: m.id, tick: state.save.tick, hours: state.save.hoursPlayed });
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n");
  } catch {
    /* an unwritable ledger costs the celebration, never the page */
  }
  const byId = new Map(now.map((m) => [m.id, m]));
  return ledger.earned
    .map((e) => {
      const m = byId.get(e.id);
      return m ? { ...m, tick: e.tick, hours: e.hours } : null;
    })
    .filter((e): e is Earned => e !== null);
}

/**
 * The earliest report on record for the same map, found by seed rather than by save name, because an autosave and the save it belongs to are the same game under two names.
 *
 * Reports written before the collector recorded a seed carry none, and those are matched by save name instead, which is how the advisor's first weeks on a map still count.
 *
 * Reads only archived reports, never a save, and returns null when there is none or when the oldest one is this very read.
 */
export function earliestReadFor(state: GameState, reportsDir: string): GameState | null {
  const seed = state.save.seed;
  const sameMap = (s: GameState): boolean =>
    s.save.seed !== undefined ? s.save.seed === seed : s.save.name === state.save.name;
  let names: string[];
  try {
    names = readdirSync(reportsDir).filter((n) => n.endsWith(".json"));
  } catch {
    return null;
  }
  let best: GameState | null = null;
  for (const n of names) {
    try {
      const s = JSON.parse(readFileSync(join(reportsDir, n), "utf8")) as GameState;
      if (typeof s.save?.tick !== "number" || !sameMap(s)) continue;
      if (!best || s.save.tick < best.save.tick) best = s;
    } catch {
      continue;
    }
  }
  return best && best.save.tick < state.save.tick ? best : null;
}

interface Stat {
  value: number;
  label: string;
  note?: string;
  icon?: string;
  field: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/**
 * Every earned milestone as one overlay: a card each, markup, style and script in one string.
 *
 * Every number on a card is read from the state file at render time, the same contract as the rest of the page. A card opens once per viewer (remembered per map and milestone in the browser, and silently repeated when storage is unavailable), unseen ones play in the order they were earned, and a chip in the header brings the newest back. Null when nothing has been earned, so the page is unchanged until something is.
 */
export function milestoneOverlay(
  state: GameState,
  src: string,
  icon: (name: string) => string | null,
  earned: Earned[],
  first: GameState | null,
): { chip: string; overlay: string } | null {
  if (earned.length === 0) return null;
  const f = state.forces["player"];
  const items = f?.production.item ?? {};
  const made = (name: string): number => items[name]?.produced ?? 0;
  const seconds = state.save.hoursPlayed * 3600;

  const totalItems = Object.values(items).reduce((n, e) => n + (e.produced ?? 0), 0);
  const packs = Object.keys(items).filter((k) => k.endsWith("-science-pack") && made(k) > 0);
  const packTotal = packs.reduce((n, k) => n + made(k), 0);
  const belts = ["transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt"].reduce((n, k) => n + made(k), 0);
  const ammo = ["firearm-magazine", "piercing-rounds-magazine", "uranium-rounds-magazine"].reduce((n, k) => n + made(k), 0);
  const machines = Object.values(f?.machines ?? {}).reduce((n, c) => n + c, 0);
  const researched = f?.technologies.researched.length ?? 0;
  const trains = f?.trains?.length ?? 0;
  const stops = f?.stops?.length ?? 0;
  const rockets = typeof f?.rocketsLaunched === "number" ? f.rocketsLaunched : 0;
  const evolution = state.save.surfaceState?.find((s) => s.surface === "nauvis")?.evolution ?? null;
  const ironPerSecond = seconds > 0 ? made("iron-plate") / seconds : 0;

  const S = {
    hours: { value: state.save.hoursPlayed, label: "hours played", icon: "rocket-silo", field: "save.hoursPlayed" },
    items: { value: totalItems, label: "items made", note: "everything, every belt, every chest", field: "forces.player.production.item.*.produced" },
    iron: { value: made("iron-plate"), label: "iron plates", note: `${ironPerSecond.toFixed(1)} every second, for ${String(Math.floor(state.save.hoursPlayed))} hours`, icon: "iron-plate", field: "forces.player.production.item.iron-plate.produced" },
    cable: { value: made("copper-cable"), label: "copper cables", icon: "copper-cable", field: "forces.player.production.item.copper-cable.produced" },
    circuits: { value: made("electronic-circuit"), label: "green circuits", icon: "electronic-circuit", field: "forces.player.production.item.electronic-circuit.produced" },
    packs: { value: packTotal, label: "science packs", note: `${String(packs.length)} colours`, icon: "automation-science-pack", field: "forces.player.production.item.*-science-pack.produced" },
    techs: { value: researched, label: "technologies", icon: "lab", field: "forces.player.technologies.researched" },
    machines: { value: machines, label: "machines standing", icon: "assembling-machine-3", field: "forces.player.machines" },
    belts: { value: belts, label: "belts crafted", icon: "express-transport-belt", field: "forces.player.production.item.*transport-belt.produced" },
    ammo: { value: ammo, label: "magazines for the wall", icon: "piercing-rounds-magazine", field: "forces.player.production.item.*-magazine.produced" },
    trains: { value: trains, label: "trains running", note: `${String(stops)} stops you named`, icon: "locomotive", field: "forces.player.trains" },
    rockets: { value: rockets, label: "rockets launched", icon: "rocket-silo", field: "forces.player.rocketsLaunched" },
  } satisfies Record<string, Stat>;

  const grid = (list: Stat[]): string =>
    `<div class="ms-grid">` +
    list
      .filter((s) => s.value > 0)
      .map((s, i) => {
        const url = s.icon ? icon(s.icon) : null;
        return (
          `<div class="ms-stat" style="--i:${String(i)}" data-source="${esc(src)}" data-field="${esc(s.field)}">` +
          (url ? `<img src="${esc(url)}" alt="">` : `<span class="ms-noico"></span>`) +
          `<b data-to="${String(Math.round(s.value))}">${esc(compact(s.value))}</b>` +
          `<span class="ms-l">${esc(s.label)}</span>` +
          (s.note ? `<span class="ms-n">${esc(s.note)}</span>` : "") +
          `</div>`
        );
      })
      .join("") +
    `</div>`;

  let journey = "";
  if (first) {
    const ff = first.forces["player"];
    const dTech = researched - (ff?.technologies.researched.length ?? 0);
    const dMach = machines - Object.values(ff?.machines ?? {}).reduce((n, c) => n + c, 0);
    const parts = [
      dTech > 0 ? `<b>${String(dTech)}</b> more ${dTech === 1 ? "technology" : "technologies"}` : "",
      dMach > 0 ? `<b>${dMach.toLocaleString("en-US")}</b> more machines` : "",
    ].filter(Boolean);
    if (parts.length > 0)
      journey = `<p class="ms-journey">Since this advisor first read the map, at ${first.save.hoursPlayed.toFixed(1)} h: ${parts.join(" and ")}.</p>`;
  }
  const evo = evolution !== null ? ` The biters noticed: evolution stands at <b>${(evolution * 100).toFixed(0)}%</b>, and they are still outside.` : "";

  const seedKey = String(state.save.seed ?? state.save.name);
  const ordered = [...earned].sort((a, b) => a.tick - b.tick);
  const switcher = ordered.length > 1
    ? `<div class="ms-earned" aria-label="Milestones earned">${ordered.map((e) => `<button type="button" data-goto="${esc(e.id)}">${esc(e.unit ? `${e.big} ${e.unit}` : e.big)}</button>`).join("")}</div>`
    : "";

  const cards = ordered
    .map((m) => {
      const url = m.icon ? icon(m.icon) : null;
      const numeric = /^[\d.]+[kMB]?$/.test(m.big);
      const body = m.full
        ? `<p class="ms-lede">${esc(m.lede)} Every plate on those belts went where you decided: the bus, the patches, the trains, the wall.${evo}</p>` +
          grid([S.items, S.iron, S.cable, S.circuits, S.packs, S.techs, S.machines, S.belts, S.ammo, S.trains, S.rockets]) +
          journey +
          `<p class="ms-sign">I only read the save. You built the factory. Here is to the next ${m.big === "100" ? "hundred" : "stretch"}.<span>SoushAI</span></p>`
        : `<p class="ms-lede">${esc(m.lede)}</p>` +
          grid([S.hours, S.techs, S.machines, m.id.startsWith("rockets-") ? S.rockets : S.items]) +
          `<p class="ms-sign">Noted, and kept for you.<span>SoushAI</span></p>`;
      return `<div class="ms-card" data-id="${esc(m.id)}" data-full="${m.full ? "1" : "0"}" data-key="${esc(`factorio-advisor:milestone:${seedKey}:${m.id}`)}" hidden>
  <div class="ms-kicker">${esc(state.save.name)} &middot; reached by tick ${String(m.tick)}, ${m.hours.toFixed(1)} h</div>
  ${!m.full && url ? `<img class="ms-icon" src="${esc(url)}" alt="">` : ""}
  <h2><span class="ms-big${numeric ? "" : " ms-word"}">${esc(m.big)}</span>${m.unit ? `<span class="ms-unit">${esc(m.unit)}</span>` : ""}</h2>
  ${body}
  ${switcher}
  <button type="button" class="ms-go">Back to the factory</button>
</div>`;
    })
    .join("\n");

  const confetti = ["iron-plate", "copper-plate", "iron-gear-wheel", "electronic-circuit", "advanced-circuit", "processing-unit",
    "automation-science-pack", "logistic-science-pack", "military-science-pack", "chemical-science-pack", "production-science-pack", "utility-science-pack",
    ...ordered.map((m) => m.icon ?? "")]
    .map((n) => (n ? icon(n) : null))
    .filter((u): u is string => u !== null);

  const latest = ordered[ordered.length - 1]!;
  const chip = `<button type="button" class="chip ms-chip" id="ms-open" title="Milestones earned on this map"><b>${esc(latest.unit ? `${latest.big} ${latest.unit}` : latest.big)}</b>${ordered.length > 1 ? ` +${String(ordered.length - 1)}` : ""}</button>`;

  const overlay = `<div class="ms" id="ms" role="dialog" aria-modal="true" aria-label="Milestone" hidden>
<canvas class="ms-sky" aria-hidden="true"></canvas>
${cards}
</div>
<script type="application/json" id="ms-icons">${JSON.stringify([...new Set(confetti)]).replace(/</g, "\\u003c")}</script>
<style>${MS_CSS}</style>
<script>(${MS_SCRIPT})();</script>`;

  return { chip, overlay };
}

const MS_CSS = `
.ms-chip{border:0;font:inherit;color:var(--dim);cursor:pointer;background:linear-gradient(90deg,#3a2a10,#5a3d0e)!important;color:var(--head)!important;box-shadow:var(--bevel),0 0 10px rgba(255,159,28,.35)}
.ms-chip:hover{filter:brightness(1.2)}
.ms[hidden]{display:none}
.ms{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:radial-gradient(ellipse at 50% 30%,rgba(60,40,10,.92),rgba(10,10,11,.97) 70%);animation:ms-fade .5s ease both;overflow:auto}
.ms-sky{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
.ms-card{position:relative;max-width:62rem;width:100%;background:var(--panel);border:1px solid var(--edge);border-radius:.3rem;box-shadow:var(--bevel),0 0 0 1px rgba(255,159,28,.25),0 20px 60px rgba(0,0,0,.7);padding:1.4rem 1.6rem 1.5rem;text-align:center;animation:ms-rise .7s cubic-bezier(.2,.9,.3,1.2) both .15s}
.ms-kicker{color:var(--dim);font-size:.8rem;letter-spacing:.12em;text-transform:uppercase}
.ms h2{display:flex;justify-content:center;align-items:baseline;gap:.6rem;margin:.2rem 0 .4rem;border:0;padding:0;background:none}
.ms-big{font-size:clamp(4rem,14vw,8.5rem);line-height:1;font-weight:700;color:var(--accent);text-shadow:0 0 30px rgba(255,159,28,.45),0 4px 0 #6b3d00;animation:ms-glow 2.4s ease-in-out infinite}
.ms-unit{font-size:clamp(1.4rem,4vw,2.2rem);color:var(--head);font-weight:600}
.ms-lede{max-width:44rem;margin:0 auto 1rem;color:var(--fg);font-size:1.02rem}
.ms-lede b,.ms-journey b{color:var(--head)}
.ms-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr));gap:.55rem;margin:0 0 1rem}
.ms-stat{background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem;padding:.6rem .5rem .55rem;display:flex;flex-direction:column;align-items:center;gap:.1rem;animation:ms-pop .45s cubic-bezier(.2,.9,.3,1.4) both;animation-delay:calc(.5s + var(--i) * .08s)}
.ms-stat img,.ms-noico{width:2rem;height:2rem}
/* A game icon file is the full-size icon followed by its mipmaps in one strip; cover plus a left anchor shows the first, as the page does for its own icons. */
.ms-stat img,.ms-icon{object-fit:cover;object-position:0 50%}
@media (max-width:40rem){.ms-card{padding:1rem .8rem 1.1rem}.ms-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ms-stat b{font-size:1.2rem}}
.ms-stat b{font-size:1.45rem;color:var(--head);font-variant-numeric:tabular-nums;line-height:1.15}
.ms-l{color:var(--fg);font-size:.85rem}
.ms-n{color:var(--dim);font-size:.72rem}
.ms-journey{color:var(--dim);margin:.2rem 0 .9rem}
.ms-sign{font-style:italic;color:var(--head);margin:.4rem 0 1rem}
.ms-sign span{display:block;font-style:normal;color:var(--dim);font-size:.8rem;margin-top:.2rem;letter-spacing:.1em}
.ms-go{font:inherit;font-weight:700;font-size:1rem;color:#1b1a1b;background:var(--go);border:1px solid var(--edge);border-radius:.2rem;padding:.5rem 1.4rem;cursor:pointer;box-shadow:var(--bevel),0 2px 0 var(--edge)}
.ms-card[hidden]{display:none}
.ms-icon{width:4.5rem;height:4.5rem;display:block;margin:.4rem auto 0;filter:drop-shadow(0 0 14px rgba(255,159,28,.5));animation:ms-pop .6s cubic-bezier(.2,.9,.3,1.4) both .3s}
.ms-big.ms-word{font-size:clamp(2.4rem,8vw,4.6rem)}
.ms-earned{display:flex;flex-wrap:wrap;justify-content:center;gap:.3rem;margin:0 0 1rem}
.ms-earned button{font:inherit;font-size:.75rem;color:var(--dim);background:var(--deep);box-shadow:var(--sunk);border:0;border-radius:.2rem;padding:.12rem .5rem;cursor:pointer}
.ms-earned button[aria-current]{color:var(--head);box-shadow:var(--sunk),0 0 0 1px var(--accent)}
.ms-earned button:hover{color:var(--fg)}
.ms-go:hover,.ms-go:focus-visible{background:var(--go-hi);outline:none}
@keyframes ms-fade{from{opacity:0}}
@keyframes ms-rise{from{opacity:0;transform:translateY(40px) scale(.96)}}
@keyframes ms-pop{from{opacity:0;transform:scale(.6)}}
@keyframes ms-glow{50%{text-shadow:0 0 50px rgba(255,184,77,.7),0 4px 0 #6b3d00}}
@media (prefers-reduced-motion:reduce){.ms,.ms-card,.ms-stat,.ms-big{animation:none}}
`;

// Plain browser JavaScript as a string, like the page's other scripts: this repo compiles without the DOM library, and the page carries no build step.
const MS_SCRIPT = `function () {
  var box = document.getElementById("ms");
  if (!box) return;
  var cards = Array.prototype.slice.call(box.querySelectorAll(".ms-card"));
  var canvas = box.querySelector("canvas");
  var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var srcs = [];
  try { srcs = JSON.parse((document.getElementById("ms-icons") || {}).textContent || "[]"); } catch (e) { srcs = []; }
  var imgs = srcs.map(function (s) { var im = new Image(); im.src = s; return im; });
  var frame = 0, last = null, queue = [], current = null;

  function seen(card) { try { return localStorage.getItem(card.dataset.key) === "seen"; } catch (e) { return false; } }
  function mark(card) { try { localStorage.setItem(card.dataset.key, "seen"); } catch (e) { /* storage unavailable: it plays again next time */ } }

  function count(card) {
    card.querySelectorAll(".ms-stat b[data-to]").forEach(function (el, i) {
      var to = Number(el.dataset.to);
      var final = el.dataset.final || (el.dataset.final = el.textContent || "");
      if (still || !isFinite(to)) { el.textContent = final; return; }
      var t0 = performance.now() + 500 + i * 80;
      el.textContent = "0";
      function step(t) {
        var p = Math.min(1, Math.max(0, (t - t0) / 1400));
        var e = 1 - Math.pow(1 - p, 3);
        el.textContent = p >= 1 ? final : Math.round(to * e).toLocaleString("en-US");
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  function rain(full) {
    cancelAnimationFrame(frame);
    if (!canvas || still) return;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    var colours = ["#ff9f1c", "#ffe6c0", "#8ed16a", "#5eb663", "#ffcc4a", "#ff6a4d", "#6fb3ff"];
    var ps = [];
    function burst(n) {
      for (var i = 0; i < n; i++) {
        var im = imgs.length > 0 && Math.random() < 0.55 ? imgs[Math.floor(Math.random() * imgs.length)] : null;
        ps.push({
          x: Math.random() * canvas.width, y: -Math.random() * canvas.height * 0.5,
          vx: (Math.random() - 0.5) * 2 * dpr, vy: (1.5 + Math.random() * 3) * dpr,
          r: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.15,
          s: (im ? 22 + Math.random() * 14 : 6 + Math.random() * 6) * dpr,
          im: im, c: colours[Math.floor(Math.random() * colours.length)]
        });
      }
    }
    burst(full ? 160 : 70);
    var started = performance.now(), span = full ? 4000 : 1500;
    function tick(t) {
      if (box.hidden) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (t - started < span && ps.length < 400 && Math.random() < 0.25) burst(6);
      for (var i = ps.length - 1; i >= 0; i--) {
        var p = ps[i];
        p.x += p.vx + Math.sin((t + i * 97) / 600) * 0.6 * dpr;
        p.y += p.vy;
        p.r += p.vr;
        if (p.y > canvas.height + 40) { ps.splice(i, 1); continue; }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        if (p.im && p.im.complete && p.im.naturalWidth > 0) ctx.drawImage(p.im, 0, 0, p.im.naturalHeight, p.im.naturalHeight, -p.s / 2, -p.s / 2, p.s, p.s);
        else { ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); }
        ctx.restore();
      }
      if (ps.length > 0) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  }

  function show(card) {
    if (box.hidden) { last = document.activeElement; box.hidden = false; document.body.style.overflow = "hidden"; }
    cards.forEach(function (c) { c.hidden = c !== card; });
    current = card;
    card.querySelectorAll("[data-goto]").forEach(function (b) {
      if (b.dataset.goto === card.dataset.id) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    });
    var go = card.querySelector(".ms-go");
    if (go) go.focus();
    count(card);
    rain(card.dataset.full === "1");
  }
  function next() {
    if (current) mark(current);
    var n = queue.shift();
    if (n) { show(n); return; }
    box.hidden = true;
    current = null;
    cancelAnimationFrame(frame);
    document.body.style.overflow = "";
    if (last && last.focus) last.focus();
  }

  box.addEventListener("click", function (e) {
    var t = e.target;
    if (t === box || (t.classList && t.classList.contains("ms-go"))) { next(); return; }
    var id = t.dataset && t.dataset.goto;
    if (id) { var c = cards.filter(function (x) { return x.dataset.id === id; })[0]; if (c) { if (current) mark(current); show(c); } }
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !box.hidden) { queue = []; next(); } });
  var o = document.getElementById("ms-open");
  if (o) o.addEventListener("click", function () { queue = []; show(cards[cards.length - 1]); });

  queue = cards.filter(function (c) { return !seen(c); });
  if (queue.length > 0) show(queue.shift());
}`;
