import type { ReportData } from "./report.ts";
import type { GameState } from "../src/state.ts";
import type { SectionView } from "../src/sections.ts";
import type { Advice } from "../src/advise.ts";
import type { MapModel, MapLayer, LayerGroup } from "../src/layers.ts";
import type { PlanView, StepView } from "../src/plan.ts";
import { readAtLocal } from "../src/state.ts";
import type { Icons } from "../src/icons.ts";
import type { BottleneckReport } from "../src/bottlenecks.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findCore } from "../src/paths.ts";
import { milestoneOverlay, type Earned } from "./milestone.ts";

/**
 * The dashboard.
 *
 * A dashboard is a dense horizontal grid a glance can scan, not a tall page that
 * has to be scrolled to be understood: 104rem wide, `auto-fit` columns, no
 * reading measure. Vertical space is the scarce resource, so the state is above
 * the fold and the header is one line.
 *
 * It is cut into sections, one per part of the base a player thinks in, because
 * Soushi asked for it that way on 2026-09-21 and because a single column of
 * forty figures is a log rather than a dashboard. Each section carries its own
 * numbers, its own advice, and its own view of the map, so a recommendation and
 * the place it applies to sit in the same card. The sections are derived in
 * `src/sections.ts`; this file only lays them out.
 *
 * Every figure carries `data-source` and `data-field`, naming the state file and
 * the path inside it that produced the number. That is the same discipline the
 * CLI follows by printing the snapshot in its header: a number with no
 * provenance is not an answer, and here the provenance survives into the DOM
 * where it can be checked without reading this file.
 */

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/**
 * The icon set for the page being rendered.
 *
 * Module state, set once at the top of `renderPage`, because the thing that
 * wants an icon is a table cell six calls down and threading the set through
 * every signature between here and there would buy nothing. Null is the normal
 * case on a machine with no game installed.
 */
let ICONS: Icons | null = null;

/**
 * A name with the game's own icon in front of it.
 *
 * The icon is decoration, so it carries an empty alt and the name stays the
 * text: a reader with images off, or a copy and paste, gets exactly what it got
 * before. A name the install has no icon for renders as it always did.
 */
function withIcon(name: string, label?: string): string {
  const url = ICONS?.url(name) ?? null;
  const text = esc(label ?? name);
  if (!url) return text;
  return `<span class="named"><img class="ico" src="${esc(url)}" alt="" decoding="sync">${text}</span>`;
}

/**
 * The game's own typeface, read from the install the way the icons are, by `file://` URL.
 *
 * Titillium Web ships with Factorio under `data/core/fonts`; nothing is copied into this repo and nothing is fetched from the network. Without an install the declaration is empty and the stack falls back to the system sans.
 */
function fontFaces(): string {
  let core: string | null = null;
  try {
    core = findCore();
  } catch {
    return "";
  }
  const faces: Array<[string, number]> = [
    ["TitilliumWeb-Regular.ttf", 400],
    ["TitilliumWeb-SemiBold.ttf", 600],
    ["TitilliumWeb-Bold.ttf", 700],
  ];
  return faces
    .map(([file, weight]) => {
      const path = join(core!, "data", "core", "fonts", file);
      if (!existsSync(path)) return "";
      const url = pathToFileURL(path).href.replace(/["\\]/g, "");
      return `@font-face{font-family:"Titillium Factorio";src:url("${url}") format("truetype");font-weight:${String(weight)};font-display:block}`;
    })
    .join("");
}

function fig(value: string, source: string, field: string, label: string, tone = ""): string {
  return (
    `<div class="fig${tone ? ` ${tone}` : ""}" data-source="${esc(source)}" data-field="${esc(field)}">` +
    `<span class="v">${esc(value)}</span><span class="l">${esc(label)}</span></div>`
  );
}

function signed(v: number, places = 1): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(places)}`;
}

const CSS = `
/* The game's own GUI, approximated in CSS: gunmetal windows with a bevelled edge, darker "deep" frames inset into them for anything that holds data, cream headings, and orange for what can be clicked. Factorio has no light GUI, so neither does this page. */
:root{color-scheme:dark;
  --bg:#1b1a1b;--panel:#313031;--panel-hi:#3d3c3d;--deep:#242324;--deeper:#1c1b1c;
  --fg:#e6e6e6;--head:#ffe6c0;--dim:#a39f99;--faint:#6f6b66;--line:#454345;--edge:#0d0c0d;
  --card:var(--panel);--up:#8ed16a;--down:#ff6a4d;--warn:#ffcc4a;--accent:#ff9f1c;--accent-hi:#ffb84d;
  --go:#5eb663;--go-hi:#77cc7b;--void:#0f0f10;
  --bevel:inset 1px 1px 0 rgba(255,255,255,.09),inset -1px -1px 0 rgba(0,0,0,.55);
  --sunk:inset 0 1px 3px rgba(0,0,0,.75),inset 0 0 0 1px rgba(0,0,0,.6);
  --lift:0 2px 0 var(--edge),0 4px 14px rgba(0,0,0,.45);
  --font:"Titillium Factorio","Titillium Web",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:3.4rem}
body{margin:0;color:var(--fg);font:14.5px/1.45 var(--font);
  background:radial-gradient(ellipse at 50% -10%,#2a2829 0,var(--bg) 60%) fixed,var(--bg)}
code{font-family:ui-monospace,"DejaVu Sans Mono",monospace;font-size:.9em;color:var(--head)}
a{color:var(--accent)}
.wrap{max-width:120rem;margin:0 auto;padding:.9rem 1.25rem 3rem}

/* A window is the panel, its bevel, and a title set the way the game sets one. */

header,section,.mappane,.overview{background:var(--panel);border:1px solid var(--edge);border-radius:.25rem;
  box-shadow:var(--bevel),var(--lift)}
header{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;padding:.5rem .8rem;margin-bottom:.75rem}
h1{font-size:1.25rem;margin:0;font-weight:700;color:var(--head);letter-spacing:.01em;display:flex;align-items:center;gap:.5rem}
h1 .ico{width:1.6rem;height:1.6rem;min-width:1.6rem;margin:0}
.meta{color:var(--dim);font-size:.82rem;font-variant-numeric:tabular-nums;display:flex;flex-wrap:wrap;gap:.35rem}
.meta .chip{background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem;padding:.08rem .5rem;white-space:nowrap}
.meta .chip b{color:var(--fg);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(30rem,1fr));gap:.9rem;align-items:start}
section{padding:.7rem .85rem .85rem;min-width:0}
section>*{min-width:0}
/* Below the fold the browser may skip a card's layout and paint until it is near the viewport; the intrinsic size keeps the scrollbar honest meanwhile. */
.readpane>section{content-visibility:auto;contain-intrinsic-size:auto 32rem}
h2{font-size:1rem;color:var(--head);margin:-.7rem -.85rem .65rem;padding:.42rem .85rem;font-weight:700;letter-spacing:.01em;
  display:flex;align-items:center;gap:.45rem;border-bottom:1px solid var(--edge);
  background:linear-gradient(var(--panel-hi),var(--panel));border-radius:.25rem .25rem 0 0;box-shadow:inset 0 -1px 0 rgba(255,255,255,.05)}
h2 .ico{width:1.3rem;height:1.3rem;min-width:1.3rem;min-height:1.3rem;margin:0}
h2 .count{margin-left:auto;font-size:.72rem;font-weight:600;color:var(--dim)}
.lead{font-size:.95rem;margin:0 0 .45rem;font-weight:600}
.tcap{font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:.8rem 0 .3rem;font-weight:700}
.carry{font-size:.84rem;margin:0 0 .7rem;color:var(--dim);border-left:3px solid var(--accent);padding:.15rem 0 .15rem .6rem;
  background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 9%,transparent),transparent 70%)}
/* Figures sit in the game's slot frames: sunk, dark, the value large. */
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.4rem;margin:.2rem 0 .1rem}
.fig{display:flex;flex-direction:column;gap:.05rem;background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem;padding:.4rem .55rem .45rem;min-width:0}
.fig .v{font-size:1.3rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.15;overflow-wrap:anywhere}
.fig .l{font-size:.72rem;color:var(--dim);line-height:1.25}
.fig.warn{box-shadow:var(--sunk),inset 3px 0 0 var(--down)}
.fig.warn .v{color:var(--down)}
.fig.good{box-shadow:var(--sunk),inset 3px 0 0 var(--up)}
.fig.good .v{color:var(--up)}
/* Tables live in a deep frame. Numbers hug the right edge with their headings over them; the name column absorbs the slack so figures stay together. */
.tframe{background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem;padding:.15rem .55rem;margin-top:.35rem;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;table-layout:auto}
td,th{text-align:left;padding:.24rem 0;border-bottom:1px solid rgba(255,255,255,.055);font-size:.86rem;overflow-wrap:anywhere;vertical-align:middle}
th{color:var(--dim);font-weight:700;font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;border-bottom-color:var(--line)}
td:first-child,th:first-child{width:100%;padding-right:.9rem}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:1.1rem}
tr:last-child td{border-bottom:0}
tr:hover td{background:rgba(255,255,255,.035)}

/* A share is drawn as well as written: the number is the cell and the bar sits under it. */

td.n .meter{display:block;height:3px;margin-top:2px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;min-width:3.2rem}
td.n .meter i{display:block;height:100%;background:var(--accent)}
td.n .meter.low i{background:var(--faint)}
.up{color:var(--up)}.down{color:var(--down)}
.cols{columns:17.5rem;column-gap:1.25rem}
.cols li{break-inside:avoid}
ul{margin:0;padding-left:1.1rem}
li{font-size:.86rem;margin:.1rem 0;overflow-wrap:anywhere}
.quiet{color:var(--dim);font-style:italic;font-size:.88rem}
/* Factorio icons are mipmap strips: the 64 px picture with its 32, 16 and 8 px reductions beside it, 120 by 64 in all. Covering a square from the left shows the first picture alone; containing it showed all four, squeezed. */
img.ico,#pin h4 img{object-fit:cover;object-position:0 50%}
.ico{width:1.2rem;height:1.2rem;min-width:1.2rem;min-height:1.2rem;vertical-align:-.3em;margin-right:.35rem;flex:0 0 auto}
.named{display:inline-flex;align-items:center;min-width:0}
.named .ico{margin-right:.4rem}
td .named{max-width:100%}
.fig .l .ico{width:.95rem;height:.95rem;min-width:.95rem;min-height:.95rem;vertical-align:-.2em;margin-right:.2rem}

/* The overview: one slot per section, its headline figure, how much advice it carries, and a click that goes there. Every figure is the section's own. */
.overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.4rem;padding:.45rem;margin-bottom:.75rem}
.ov{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:.55rem;align-items:center;text-decoration:none;color:inherit;
  background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem;padding:.4rem .6rem;border-left:3px solid var(--faint);min-width:0}
.ov:hover,.ov:focus-visible{background:var(--deeper);outline:1px solid var(--accent);outline-offset:-1px}
.ov.warn{border-left-color:var(--down)}.ov.good{border-left-color:var(--up)}
.ov .ico{grid-row:1/3;width:2rem;height:2rem;min-width:2rem;min-height:2rem;margin:0}
.ov .t{font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--head);font-weight:700;display:flex;gap:.4rem;align-items:center;min-width:0}
.ov .t .nadv{margin-left:auto;font-size:.66rem;color:#1b1a1b;background:var(--accent);border-radius:.6rem;padding:0 .38rem;letter-spacing:0}
.ov .x{font-size:1.15rem;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ov.warn .x{color:var(--down)}.ov.good .x{color:var(--up)}
.ov .x small{font-size:.7rem;font-weight:400;color:var(--dim);margin-left:.35rem}

/* Tabs along the top of the reading pane, as the game draws them: a dark rail, the current one raised and lit. They stay put while the cards scroll. */
.tabs{position:sticky;top:0;z-index:5;grid-column:1/-1;display:flex;gap:.2rem;overflow-x:auto;scrollbar-width:thin;
  padding:.3rem;background:var(--deeper);border:1px solid var(--edge);border-radius:.25rem;box-shadow:var(--sunk),0 6px 12px rgba(0,0,0,.4)}
.tabs a{flex:0 0 auto;font-size:.82rem;font-weight:600;color:var(--dim);text-decoration:none;padding:.22rem .7rem;border-radius:.2rem;
  background:var(--panel);box-shadow:var(--bevel);white-space:nowrap;display:flex;align-items:center;gap:.35rem}
.tabs a:hover,.tabs a:focus-visible{color:var(--fg);background:var(--panel-hi)}
.tabs a[aria-current=true]{color:#1b1a1b;background:linear-gradient(var(--accent-hi),var(--accent))}
.tabs a .dot{width:.45rem;height:.45rem;border-radius:50%;background:var(--faint)}
.tabs a .dot.warn{background:var(--down)}.tabs a .dot.good{background:var(--up)}
.tabs a[aria-current=true] .dot{box-shadow:0 0 0 1px #1b1a1b}

/* The bottleneck card. Two tables that must never be blended: what the machines did with their time, and what the lines have left. */
.holding{grid-column:1/-1}
.holding .find{margin:.25rem 0 .45rem;font-size:.9rem;font-weight:600;padding:.35rem .55rem;background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem}
.holding .find .because{display:block;font-weight:400;color:var(--dim);font-size:.8rem;margin-top:.1rem}
.holding .pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(22rem,1fr));gap:0 1rem}
/* The caveats are the fine print the readings rest on: every word kept, folded away until asked for, one per line instead of one paragraph. */
details.limits{margin:.7rem 0 0;font-size:.78rem;color:var(--dim)}
details.limits summary{cursor:pointer;font-weight:600;color:var(--dim);list-style:none;display:inline-flex;gap:.35rem;align-items:center}
details.limits summary::-webkit-details-marker{display:none}
details.limits summary::before{content:"\\25B8";color:var(--accent);transition:transform .15s}
details.limits[open] summary::before{transform:rotate(90deg)}
details.limits summary:hover{color:var(--fg)}
details.limits ul{margin:.4rem 0 0;padding:.45rem .6rem .45rem 1.5rem;background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem}
details.limits li{font-size:.8rem;margin:.2rem 0;color:var(--dim)}
.holding .bar{grid-template-columns:8rem 1fr auto}
.plan{grid-column:1/-1}
.plan .why{color:var(--dim);font-size:.82rem;margin:.15rem 0 0}
.steps{list-style:none;margin:.6rem 0 0;padding:0 0 0 .6rem;display:grid;gap:.45rem}
.step{border-radius:.2rem;padding:.5rem .7rem;position:relative;background:var(--deep);box-shadow:var(--sunk);border-left:3px solid var(--accent)}
.step[data-fx]{cursor:pointer}
.step[data-fx]:hover,.step[data-fx]:focus-visible{background:var(--deeper);outline:1px solid var(--accent);outline-offset:-1px}
.step.done{opacity:.6;border-left-color:var(--up)}
.step.started{border-left-color:var(--warn)}
.step .n{position:absolute;left:-.75rem;top:.45rem;width:1.35rem;height:1.35rem;border-radius:.2rem;
  background:linear-gradient(var(--accent-hi),var(--accent));color:#1b1a1b;font-size:.72rem;font-weight:700;
  display:flex;align-items:center;justify-content:center;box-shadow:0 1px 0 var(--edge)}
.step.done .n{background:linear-gradient(var(--go-hi),var(--go))}
.step.started .n{background:var(--deeper);color:var(--warn);box-shadow:inset 0 0 0 1.5px var(--warn)}
.step h3{margin:0 0 .1rem .75rem;font-size:.93rem;font-weight:700;color:var(--head)}
.step .chips{display:flex;flex-wrap:wrap;gap:.3rem;margin:.3rem 0 .1rem .75rem;font-size:.74rem;color:var(--dim)}
.step .chips span{background:var(--panel);box-shadow:var(--bevel);border-radius:.2rem;padding:.05rem .45rem}
.step .chips b{font-weight:600;color:var(--fg)}
.step .body{margin:.45rem 0 0 .75rem;font-size:.86rem;display:none}
.step.open .body{display:block}
.step .body p{margin:0 0 .4rem}
.step .bars{margin:.4rem 0 0 .75rem;display:grid;gap:.3rem}
/* Progress the way the game draws research: a dark trough, an orange fill. */
.bar{display:grid;grid-template-columns:12rem 1fr 10rem;gap:.6rem;align-items:center;font-size:.76rem;color:var(--dim)}
.bar>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar .track{position:relative;display:block;height:.75rem;border-radius:.15rem;overflow:hidden;background:var(--deeper);box-shadow:var(--sunk)}
.bar .fill{position:absolute;top:1px;bottom:1px;left:0;background:color-mix(in srgb,var(--accent) 55%,#000)}
.bar .gain{position:absolute;top:1px;bottom:1px;background:linear-gradient(var(--accent-hi),var(--accent))}
.bar .loss{position:absolute;top:1px;bottom:1px;background:color-mix(in srgb,var(--down) 75%,transparent)}
.bar .base{position:absolute;top:-1px;bottom:-1px;width:2px;margin-left:-1px;background:var(--head);opacity:.8}
.bar.done .fill,.bar.done .gain{background:linear-gradient(var(--go-hi),var(--go))}
.bar .val{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--fg)}
.bar .pct{display:inline-block;min-width:2.6rem;margin-left:.4rem;font-weight:700;color:var(--head)}
.bar.done .pct{color:var(--up)}

/* Buttons come in the game's kinds: grey for a tool, lit orange on hover, and green for the one that does something. */

button{font-family:inherit}
.step .more,.seemap,.maptools button,.planlink{font:inherit;font-size:.74rem;font-weight:600;color:var(--fg);cursor:pointer;
  background:linear-gradient(#4a484a,#3a393a);border:1px solid var(--edge);border-radius:.2rem;padding:.12rem .55rem;box-shadow:var(--bevel);text-decoration:none}
.step .more:hover,.seemap:hover,.seemap:focus-visible,.maptools button:hover,.maptools button:focus-visible,.planlink:hover{
  background:linear-gradient(var(--accent-hi),var(--accent));color:#1b1a1b}
.step .more{margin-left:.5rem;font-size:.68rem;vertical-align:.1em}
.plan .stale{font-size:.76rem;color:var(--warn);margin:.4rem 0 0}
.step .closed{margin:.2rem 0 0 .75rem;font-size:.78rem;color:var(--up);font-weight:600}
.bar .moved{margin-left:.4rem;font-size:.68rem;font-weight:600}
.bar .moved.up{color:var(--up)}.bar .moved.down{color:var(--down)}
.refresh{display:flex;align-items:center;gap:.5rem;margin-left:auto}
.refresh button{font:inherit;font-size:.86rem;font-weight:700;color:#10200f;cursor:pointer;
  background:linear-gradient(var(--go-hi),var(--go));border:1px solid var(--edge);border-radius:.2rem;padding:.28rem .9rem;box-shadow:var(--bevel)}
.refresh button:hover{filter:brightness(1.12)}
.refresh button:disabled{opacity:.55;cursor:progress}
.refresh .msg{font-size:.76rem;color:var(--dim)}
.refresh .msg::before{content:"";display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--faint);margin-right:.4rem;vertical-align:.05em}
.refresh .msg.live::before{background:var(--up);box-shadow:0 0 6px var(--up)}
.refresh .msg.bad{color:var(--down)}
.refresh .msg.bad::before{background:var(--down)}
.refresh .msg:empty{display:none}
.hist{font-size:.8rem;color:var(--dim)}
.hist a{color:var(--accent);text-decoration:none}
.hist a:hover{text-decoration:underline}
.wide{grid-column:1/-1}
.advice{list-style:none;padding:0;margin:.4rem 0 0;counter-reset:a;display:grid;gap:.35rem}
.advice li{margin:0;padding:.38rem .55rem .4rem 2.1rem;position:relative;font-size:.88rem;background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem}
.advice li::before{counter-increment:a;content:counter(a);position:absolute;left:.5rem;top:.42rem;width:1.2rem;height:1.2rem;border-radius:.2rem;
  background:linear-gradient(var(--accent-hi),var(--accent));color:#1b1a1b;font-size:.68rem;font-weight:700;display:flex;align-items:center;justify-content:center}
.advice b{font-weight:700}
.advice .why{display:block;color:var(--dim);font-size:.8rem;margin-top:.1rem}
.advice .tag{display:inline-flex;align-items:center;gap:.25rem;white-space:nowrap;font-size:.62rem;text-transform:uppercase;letter-spacing:.06em;color:var(--head);
  background:var(--panel);box-shadow:var(--bevel);border-radius:.2rem;padding:.02rem .4rem;margin-left:.45rem;vertical-align:.1em;text-decoration:none}
.advice .tag .ico{width:.9rem;height:.9rem;min-width:.9rem;min-height:.9rem;margin:0}
.advice .tag:hover{color:#1b1a1b;background:var(--accent)}
.mapbox{margin-top:.7rem;background:var(--deep);border-radius:.2rem;padding:.35rem;color:var(--fg)}
svg.map{display:block;max-height:34rem;width:100%}
.legend{font-size:.72rem;color:var(--dim);margin-top:.3rem;display:flex;flex-wrap:wrap;gap:.1rem .7rem}
footer{margin-top:1.1rem;color:var(--faint);font-size:.75rem;padding:.6rem .2rem}

/* C33: two panes. The map holds the left and stays put while the text scrolls beside it. Below 70rem they stack and the map takes a fixed height. */
.split{display:grid;grid-template-columns:minmax(30rem,45fr) minmax(24rem,55fr);gap:.9rem;align-items:start}
.mappane{position:sticky;top:.6rem;height:calc(100vh - 1.2rem);display:flex;flex-direction:column;padding:.7rem .8rem;min-width:0}
/* The map window's title bar: the name, the game's ridged draggable space, then square tool buttons, which is how every window in Factorio is topped. */
.mapbar{display:flex;align-items:center;gap:.5rem;margin:-.7rem -.8rem .55rem;padding:.32rem .45rem .32rem .85rem;
  border-bottom:1px solid var(--edge);background:linear-gradient(var(--panel-hi),var(--panel));border-radius:.25rem .25rem 0 0;box-shadow:inset 0 -1px 0 rgba(255,255,255,.05)}
.mapbar h2{margin:0;padding:0;background:none;border:0;box-shadow:none;white-space:nowrap}
.dragspace{flex:1 1 auto;align-self:stretch;min-width:1rem;margin:.2rem 0;border-radius:.1rem;
  background:radial-gradient(circle at 1px 1px,rgba(0,0,0,.55) .9px,transparent 1.3px) 0 0/4px 4px,
    radial-gradient(circle at 1px 1px,rgba(255,255,255,.07) .9px,transparent 1.3px) 2px 2px/4px 4px}
.readpane{display:grid;grid-template-columns:repeat(auto-fit,minmax(26rem,1fr));gap:.9rem;align-items:start;min-width:0}
#mapbox{flex:1 1 auto;min-height:18rem;position:relative;background:var(--void);box-shadow:var(--sunk);
  border-radius:.2rem;color:var(--fg);overflow:hidden;touch-action:none}
/* The two sizes the map keeps in screen pixels rather than in tiles: the ink of a mark, and the height of a label. Both are recomputed by the script on every zoom, because a machine drawn at its true size on a 2655-tile base is a fifth of a pixel and a map of those is a grey smudge. */
#map{display:block;position:absolute;left:-25%;top:-25%;width:150%;height:150%;transform-origin:0 0;will-change:transform;cursor:grab}
#mapbox.dragging #map{cursor:grabbing}
#mapbox{user-select:none;-webkit-user-select:none}
body.panning{user-select:none;-webkit-user-select:none;cursor:grabbing}
#map .fp{fill:currentColor;stroke:currentColor;vector-effect:non-scaling-stroke;
  stroke-width:2.6px;stroke-linejoin:round}
/* Poles mark where the grid reaches, so they draw fine and leave the full ink to the machines (THIN_TYPES in layers.ts). */
#map .fp.thin{stroke-width:.8px;fill-opacity:.8}
#map .tile{stroke:currentColor;vector-effect:non-scaling-stroke;
  stroke-width:1px;stroke-linejoin:round}
/* The real art is free while it is hidden and costly while it is not, so it is revealed only at the zoom where a machine is big enough to recognise. */
#map g[data-layer=art],#map g[data-layer=alt]{display:none}
#map.close g[data-layer=art].on,#map.close g[data-layer=alt].on{display:block}
#map.close:has(g[data-layer=art].on) .fp.drawn{fill-opacity:0;stroke-opacity:0}
/* Close in, ink() has already thinned every outline to a hairline of half a pixel or less, which says nothing a filled footprint does not, and stroking the whole-base paths cost the redraw 100 ms of its 117 in full view (measured 2026-10-06). So close in the shapes are filled only. */
#map.close .fp,#map.close .tile{stroke:none}
/* Close in, the machines and their icons are what a player reads, so belts recede to a tread under them and the recipe-block boxes, which the icons now say, fade to a hint. */
#map.close g[data-layer=belts] .fp{fill-opacity:.45;stroke-opacity:.45}
#map.close g[data-layer=blocks] .area rect{stroke-opacity:.25;fill-opacity:.03}
/* Water is ground, so it sits back: at full strength it is a blue field with a base somewhere underneath it rather than a coastline the base sits on. */
#map .tile.water{opacity:.5}
#map .cov{fill:currentColor;fill-opacity:.07;stroke:currentColor;stroke-opacity:.5;
  vector-effect:non-scaling-stroke;stroke-width:1px}
#map .cov.build{fill-opacity:.03;stroke-opacity:.18;stroke-dasharray:4 3}
#map .lbl.hid{display:none}
#map .lbl{font-size:14px;fill:currentColor;paint-order:stroke;stroke:var(--void);
  stroke-width:4.2px;stroke-linejoin:round;text-anchor:middle;font-weight:700;
  letter-spacing:-.01em;pointer-events:none;font-family:var(--font)}
#map .area rect{fill-opacity:.1;stroke-width:2;vector-effect:non-scaling-stroke;stroke-dasharray:6 4}
#map .area.warn rect{fill:var(--down);stroke:var(--down)}
#map .area.good rect{fill:var(--up);stroke:var(--up)}
#map .area.info rect{fill:var(--dim);stroke:var(--dim)}
#map g[data-layer]{pointer-events:none}
#map g[data-layer].on{pointer-events:auto}
#map g[data-layer]:not(.on),#map g[data-labels-of]:not(.on){display:none}
#map .flash rect{stroke-width:4;fill-opacity:.28}
#mark{pointer-events:none;color:var(--accent)}
#mark .halo{fill:none;stroke:var(--void);stroke-width:7;vector-effect:non-scaling-stroke;stroke-opacity:.85}
#mark .box{fill:currentColor;fill-opacity:.14;stroke:currentColor;stroke-width:3;vector-effect:non-scaling-stroke}
#mark .pulse{fill:none;stroke:currentColor;stroke-width:2;vector-effect:non-scaling-stroke;animation:markpulse 1.4s ease-out 3}
@keyframes markpulse{from{stroke-opacity:1}to{stroke-opacity:0}}
#mark .shade{fill:var(--void);fill-opacity:.62;fill-rule:evenodd}
#mark .cross{fill:none;stroke:currentColor;stroke-width:1.5;vector-effect:non-scaling-stroke;stroke-dasharray:8 5;stroke-opacity:.9}
#focusbadge{position:absolute;left:.5rem;top:.5rem;z-index:3;max-width:calc(100% - 1rem);background:var(--accent);color:#111;font-weight:700;font-size:.8rem;line-height:1.3;padding:.3rem .6rem;border-radius:.3rem;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4)}
#focusbadge[hidden]{display:none}
.coord{color:var(--accent);text-decoration:underline dotted;text-underline-offset:2px;cursor:pointer;white-space:nowrap}
.coord::after{content:" \u2316";font-size:.85em}
.coord:hover,.coord:focus-visible{text-decoration-style:solid}
.coord.flash{background:color-mix(in srgb,var(--accent) 18%,transparent);border-radius:.2rem}
/* The panel a click opens, styled as the game's entity tooltip. It is anchored in the map box rather than in the page, so it travels with the map and never lands under the reading. */
#pin{position:absolute;z-index:3;max-width:19rem;min-width:12rem;background:var(--panel);
  border:1px solid var(--edge);border-radius:.2rem;padding:0 .6rem .5rem;font-size:.8rem;
  box-shadow:var(--bevel),0 .4rem 1.2rem rgba(0,0,0,.6);line-height:1.4}
#pin h4{margin:0 -.6rem .3rem;padding:.3rem 1.6rem .3rem .6rem;font-size:.9rem;font-weight:700;display:flex;align-items:center;gap:.4rem;
  color:var(--head);background:linear-gradient(var(--panel-hi),var(--panel));border-bottom:1px solid var(--edge)}
#pin h4 img{width:1.3rem;height:1.3rem}
#pin .kind{color:var(--dim);font-weight:400;font-size:.72rem}
#pin dl{margin:.3rem 0 0;display:grid;grid-template-columns:auto 1fr;gap:.12rem .6rem;background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem;padding:.3rem .45rem}
#pin dt{color:var(--dim)}
#pin dd{margin:0;font-variant-numeric:tabular-nums;text-align:right;font-weight:600}
#pin .ico{width:1.05rem;height:1.05rem;vertical-align:-.2rem;margin-right:.25rem}
#pin dt .ico{margin-right:.3rem}
#pin .where{margin:.4rem 0 0;color:var(--dim);font-size:.72rem}
#pin .close{position:absolute;top:.25rem;right:.35rem;border:0;background:none;color:var(--dim);
  cursor:pointer;font:inherit;font-size:1rem;line-height:1;padding:.1rem .2rem;z-index:1}
#pin .close:hover{color:var(--accent)}
#xy{color:var(--head);opacity:0;transition:opacity .12s}
#mapbox:hover #xy:not(:empty){opacity:1}
.maptools{display:flex;gap:.25rem;align-items:center;flex:0 0 auto}
.maptools .tool{display:inline-flex;align-items:center;justify-content:center;gap:.3rem;height:1.75rem;min-width:1.75rem;padding:0 .3rem}
.maptools .tool svg{width:1rem;height:1rem;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:0 0 auto}
.maptools .tool.wide{padding:0 .5rem 0 .4rem}
.maptools .tool[aria-pressed=true]{background:linear-gradient(var(--accent-hi),var(--accent));color:#1b1a1b;box-shadow:inset 0 1px 2px rgba(0,0,0,.45)}
.maptools .count{font-size:.66rem;font-variant-numeric:tabular-nums;background:var(--deeper);box-shadow:var(--sunk);color:var(--dim);border-radius:.15rem;padding:0 .3rem;line-height:1.35}
.maptools .tool[aria-pressed=true] .count{background:rgba(0,0,0,.25);color:#1b1a1b;box-shadow:none}
.toolsep{width:1px;align-self:stretch;margin:.2rem .1rem;background:var(--edge);box-shadow:1px 0 0 rgba(255,255,255,.06)}
/* The map's own GUI floats on the map: a frame the colour of the game's windows, opaque (no backdrop blur, which repaints the map under it every frame). */
.mapui{position:absolute;z-index:4;background:var(--panel);border:1px solid var(--edge);border-radius:.2rem;box-shadow:var(--bevel),0 .3rem 1rem rgba(0,0,0,.55);font-size:.78rem}
.mapui[hidden]{display:none}
.uihead{display:flex;align-items:center;gap:.4rem;padding:.25rem .3rem .25rem .55rem;color:var(--head);font-weight:700;font-size:.8rem;
  background:linear-gradient(var(--panel-hi),var(--panel));border-bottom:1px solid var(--edge);border-radius:.2rem .2rem 0 0}
.uihead .x{margin-left:auto;border:0;background:none;color:var(--dim);cursor:pointer;font:inherit;font-size:1rem;line-height:1;padding:0 .25rem}
.uihead .x:hover,.uihead .x:focus-visible{color:var(--accent)}
#legend{top:.5rem;right:.5rem;width:17.5rem;max-height:calc(100% - 3rem);display:none;flex-direction:column}
#mapbox.legend-open #legend{display:flex}
#legend .legend-groups{margin:.35rem;max-height:none;min-height:0;flex:1 1 auto;grid-template-columns:1fr}
#maphelp{top:.5rem;right:.5rem;width:20rem;max-width:calc(100% - 1rem);z-index:5;padding-bottom:.45rem}
#maphelp dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem .7rem;margin:.4rem .45rem 0;padding:.35rem .5rem;background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem}
#maphelp dt{color:var(--head);white-space:nowrap}
#maphelp dd{margin:0;color:var(--fg)}
#maphelp p{margin:.4rem .55rem 0;color:var(--dim);font-size:.72rem}
#maphelp kbd{font:inherit;font-size:.68rem;background:var(--deeper);box-shadow:var(--sunk);border-radius:.15rem;padding:0 .3rem;color:var(--fg)}
/* The overview: the whole base as one picture taken once, the view drawn on it as the game draws the camera on its minimap. */
#overview{left:.5rem;bottom:2.3rem;width:15rem;padding:.25rem;cursor:crosshair;touch-action:none}
#overview img{display:block;width:100%;height:auto;background:var(--void);box-shadow:var(--sunk);border-radius:.1rem;pointer-events:none}
#overview .vp{position:absolute;left:0;top:0;border:2px solid var(--accent);background:color-mix(in srgb,var(--accent) 22%,transparent);box-shadow:0 0 0 1px rgba(0,0,0,.7);pointer-events:none;transform-origin:0 0}
.corner{position:absolute;z-index:3;pointer-events:none;font-size:.7rem;font-variant-numeric:tabular-nums;line-height:1.5;
  background:color-mix(in srgb,var(--deeper) 86%,transparent);border:1px solid var(--edge);border-radius:.2rem;padding:.05rem .45rem}
.corner.bl{left:.5rem;bottom:.5rem}
.corner.br{right:.5rem;bottom:.5rem}
#scalebar{display:flex;align-items:center;gap:.45rem;color:var(--dim)}
#scalebar .bar{height:.45rem;border:1.5px solid var(--head);border-top:0}
/* The legend is the map's table of contents, grouped the way a player thinks: the ground, what is standing on it, the places a sentence points at. Each entry is one click and carries its own count. */
/* Full view: the same window, fixed over the page, so the view, the layers and an open panel carry over. */
.mappane.full{position:fixed;inset:0;z-index:40;height:100vh;width:100vw;border-radius:0}
body.mapfull{overflow:hidden}
.legend-groups{display:grid;gap:.1rem .9rem;overflow-y:auto;overflow-x:hidden;background:var(--deep);box-shadow:var(--sunk);border-radius:.2rem;padding:.2rem .45rem;scrollbar-width:thin}
.lgroup{min-width:0}
.lgroup h3{font-size:.64rem;text-transform:uppercase;letter-spacing:.08em;color:var(--head);margin:.3rem 0 .15rem;font-weight:700}
.layers{list-style:none;margin:0;padding:0}
.layers li{margin:0}
.layers button{display:flex;align-items:center;gap:.4rem;width:100%;text-align:left;font:inherit;
  font-size:.76rem;background:none;border:0;padding:.1rem .25rem;border-radius:.15rem;color:var(--faint);cursor:pointer}
.layers button:hover,.layers button:focus-visible{background:rgba(255,255,255,.06);color:var(--fg)}
.layers button[aria-pressed=true]{color:var(--fg)}
.layers button .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.layers .key{width:.65rem;height:.65rem;flex:0 0 auto;opacity:.3}
.layers button[aria-pressed=true] .key{opacity:1}
.layers .key.dot{border-radius:50%}
.layers .key.square{border-radius:.05rem}
.layers .key.fill{border-radius:.1rem;opacity:.2}
.layers button[aria-pressed=true] .key.fill{opacity:.65}
.layers .key.box{border-radius:.1rem;background:none!important;border:1px dashed currentColor}
.layers .n{margin-left:auto;white-space:nowrap;padding-left:.4rem;font-variant-numeric:tabular-nums;opacity:.75;font-size:.7rem}
.layers .digit{opacity:.6;font-size:.62rem;width:.75rem;flex:0 0 auto;color:var(--accent)}
.layers .miss{display:none}
.layers .miss.gap{display:block;font-size:.64rem;color:var(--down);padding:0 0 .15rem 1.75rem;line-height:1.25}
.advice li[data-fx]{cursor:pointer}
.advice li[data-fx]:hover,.advice li[data-fx]:focus-visible{background:var(--deeper);outline:1px solid var(--accent);outline-offset:-1px}
.advice li[data-fx] b::after{content:" \\2316";color:var(--accent);font-weight:400}
.advice li.flash,.step.flash{outline:2px solid var(--accent);outline-offset:-2px}
.seemap{margin-top:.6rem}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
@media (max-width:70rem){
  .wrap{padding:.6rem}
  .split{grid-template-columns:1fr}
  .mappane{position:static;height:auto}
  /* flex:none or the pane's own flex:1 wins and the map fills the whole viewport on a phone, pushing every word of the reading below the fold. */
  #mapbox{height:60vh;flex:none}
  .bar{grid-template-columns:8rem 1fr 8.5rem}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}#map{transition:none!important}#mark .pulse{animation:none}}
`;

/**
 * The map's behaviour, inlined because this page is opened from `file://` and
 * must work with no network: the C33 falsifier forbids a CDN dependency.
 *
 * It is written without template literals so that the TypeScript template this
 * lives in never has to escape a dollar brace, which is how a page like this
 * acquires a silent syntax error.
 *
 * The zoom is the one piece worth reading twice. `preserveAspectRatio` letterboxes
 * the viewBox inside the element, so converting a cursor position to tile
 * coordinates needs the drawn rectangle rather than the element rectangle. Zoom
 * about that point rather than about the centre of the box: centre zoom makes a
 * player chase the thing they were pointing at, which is the single most common
 * way a zoomable map feels wrong.
 */
const SCRIPT = `
(function () {
  var svg = document.getElementById("map");
  if (!svg) return;
  var box = document.getElementById("mapbox");
  var grid = document.getElementById("grid");
  var bar = document.querySelector("#scalebar .bar");
  var barTxt = document.querySelector("#scalebar .txt");
  var fit = svg.getAttribute("data-fit").split(" ").map(Number);
  var chunk = Number(svg.getAttribute("data-chunk")) || 32;
  var vb = { x: fit[0], y: fit[1], w: fit[2], h: fit[3] };
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The drawn rectangle inside the element, which is what letterboxing leaves.
  function drawn() {
    var r = box.getBoundingClientRect();
    var s = Math.min(r.width / vb.w, r.height / vb.h);
    return { s: s, left: r.left + (r.width - vb.w * s) / 2, top: r.top + (r.height - vb.h * s) / 2 };
  }

  // Two sizes the map holds in screen pixels while the view moves under them.
  //
  // A mark grows a little as the view closes in, from 3.6 px at the whole base
  // to 9 px when a chunk fills a quarter of the pane, so a dot is findable at
  // every zoom without ever pretending to be the machine's real footprint: the
  // grid is what carries real size. A label is set in tile units computed from
  // the scale, because text inside a viewBox is measured in tiles and a fixed
  // font size would be a postage stamp at one zoom and a banner at the next.
  // The sizes are written into a few rules of their own rather than into CSS
  // variables on the SVG. A custom property is inherited, so changing one on the
  // SVG restyled all fourteen thousand nodes under it: 77 to 89 ms per variable,
  // three variables per redraw, measured at close zoom with every layer hidden.
  // A rule is only matched by the paths and labels it names, and a value that
  // did not change is not written at all.
  var inkRules = (function () {
    var el = document.createElement("style");
    el.textContent = "#map .fp{}#map .fp.thin{}#map .tile{}#map .lbl{}#map .lbl{}";
    document.head.appendChild(el);
    return el.sheet.cssRules;
  })();
  var inkNow = [];
  function setInk(i, prop, value) {
    var key = i + prop;
    if (inkNow[key] === value) return;
    inkNow[key] = value;
    inkRules[i].style.setProperty(prop, value);
  }
  function ink() {
    var d = drawn();
    var px = d.s * chunk;
    // Far out, the stroke is the entity and has to be thick enough to see; close
    // in it thins to a hairline so the rectangle underneath is the machine's
    // real footprint rather than a fat blob. Water and ore get a thinner one:
    // they are already large shapes and only need their edge closed up.
    var k = Math.max(0, Math.min(1, (px - 4) / 60));
    var mk = 3.2 - 2.7 * k, lbl = 13 / d.s;
    setInk(0, "stroke-width", (mk).toFixed(2) + "px");
    setInk(1, "stroke-width", (mk * 0.3).toFixed(2) + "px");
    setInk(2, "stroke-width", (1.1 - 0.9 * k).toFixed(2) + "px");
    setInk(3, "font-size", lbl.toFixed(2) + "px");
    setInk(4, "stroke-width", (lbl * 0.3).toFixed(2) + "px");
    // A tile wide enough on screen for a machine to be recognisable as itself.
    var close = d.s >= 3;
    if (close) wakeArt();
    svg.classList.toggle("close", close);
  }

  // The art arrives as text and is parsed into the map once, the first time it could be seen.
  var culled = [];
  function drawCulled() {
    var close = svg.classList.contains("close");
    var x0 = Math.floor((vb.x - vb.w * MARGIN) / chunk), y0 = Math.floor((vb.y - vb.h * MARGIN) / chunk);
    var x1 = Math.floor((vb.x + vb.w * (1 + MARGIN)) / chunk), y1 = Math.floor((vb.y + vb.h * (1 + MARGIN)) / chunk);
    var key = close ? [x0, y0, x1, y1].join(",") : "";
    culled.forEach(function (c) {
      if (c.key === key) return;
      c.key = key;
      if (!close) { c.holder.innerHTML = ""; return; }
      var out = [];
      for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) {
        var b = c.buckets[cx + "," + cy];
        if (b) out.push(b.join(""));
      }
      c.holder.innerHTML = out.join("");
    });
  }
  function wakeArt() {
    var lazy = [].slice.call(svg.querySelectorAll("g[data-lazy]"));
    if (lazy.length === 0) return;
    lazy.forEach(function (l) {
      var src = document.getElementById(l.getAttribute("data-lazy"));
      l.removeAttribute("data-lazy");
      if (!src) return;
      var text = src.textContent;
      src.remove();
      // The definitions go into the map once; the placements are indexed by
      // chunk and only the ones inside the drawn extent are ever in the DOM.
      // Twelve thousand placed pictures were twelve thousand nodes the browser
      // restyled and relaid on every redraw, on screen or not.
      var end = text.indexOf("</defs>");
      var defs = end >= 0 ? text.slice(0, end + 7) : "";
      var rest = end >= 0 ? text.slice(end + 7) : text;
      l.innerHTML = defs;
      var holder = document.createElementNS(NS, "g");
      l.insertBefore(holder, l.firstChild ? l.firstChild.nextSibling : null);
      var buckets = {};
      var re = /<use [^>]*\\/>/g, m;
      while ((m = re.exec(rest))) {
        var u = m[0];
        var p = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(u) || /\\bx="([-\\d.]+)" y="([-\\d.]+)"/.exec(u);
        if (!p) continue;
        var key = Math.floor(+p[1] / chunk) + "," + Math.floor(+p[2] / chunk);
        (buckets[key] || (buckets[key] = [])).push(u);
      }
      culled.push({ holder: holder, buckets: buckets, key: "" });
    });
    var g = svg.querySelector('g[data-layer="art"]');
    if (!g) return;
    // A prototype drawn as itself no longer needs its rectangle painted under
    // it: through a silo's open middle the rectangle showed as a green square.
    // It stays in place, unpainted, so a click still lands on it.
    [].slice.call(svg.querySelectorAll("path[data-n]")).forEach(function (p) {
      if (g.querySelector('[id="s-' + p.getAttribute("data-n") + '"]')) p.classList.add("drawn");
    });
  }

  // One repaint per animation frame, whatever the input device says.
  //
  // A wheel or a drag fires far faster than the screen refreshes, and each
  // event used to rebuild the grid, the scale bar and the viewBox in line.
  // Coalescing them into the next frame is the single biggest thing that made
  // the map keep up with a cursor.
  //
  // And while the view is moving, nothing inside the SVG changes at all. The map
  // is tens of thousands of shapes and every change to the viewBox, to a stroke
  // variable or to a class on the SVG re-rasterises all of them, which held a
  // pan at twenty frames a second. So a gesture moves the last drawn picture
  // with a CSS transform, which the compositor does for free, and the real
  // redraw happens once, when the view has been still for a beat. The SVG is
  // drawn with a margin of MARGIN times the pane on every side, so a pan
  // uncovers picture rather than an empty edge, and is clipped by the pane.
  var MARGIN = 0.25;
  var drawnAt = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
  var frame = null;
  var settle = null;
  function place(v, W, H) {
    var s = Math.min(W / v.w, H / v.h);
    return { s: s, ox: (W - v.w * s) / 2 - v.x * s, oy: (H - v.h * s) / 2 - v.y * s };
  }
  function apply() {
    if (frame !== null) return;
    frame = requestAnimationFrame(function () {
      frame = null;
      var r = box.getBoundingClientRect();
      var a = place(drawnAt, r.width, r.height), b = place(vb, r.width, r.height);
      var k = b.s / a.s;
      var offX = -MARGIN * r.width, offY = -MARGIN * r.height;
      var tx = b.ox - offX - k * (a.ox - offX), ty = b.oy - offY - k * (a.oy - offY);
      // A drag that has carried the picture most of the way through its margin
      // is redrawn now rather than at the end, or the pane shows its empty edge.
      var reach = Math.max(Math.abs(b.ox - a.ox) / r.width, Math.abs(b.oy - a.oy) / r.height);
      if (k > 0.97 && k < 1.03 && reach > MARGIN * 0.98) { commit(); return; }
      svg.style.transform = "translate(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px) scale(" + k.toFixed(5) + ")";
      drawScale();
      drawOverviewView();
      if (settle !== null) clearTimeout(settle);
      settle = setTimeout(commit, glide ? 400 : 140);
    });
  }
  function commit() {
    settle = null;
    drawnAt = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
    var f = 1 + 2 * MARGIN;
    svg.setAttribute("viewBox", (vb.x - vb.w * MARGIN) + " " + (vb.y - vb.h * MARGIN) + " " + vb.w * f + " " + vb.h * f);
    svg.style.transform = "";
    drawGrid();
    drawScale();
    drawOverviewView();
    ink();
    drawCulled();
    drawBelts();
    declutter();
  }

  // What rides the belts, drawn for the tiles in view only. The page carries
  // every belt tile as one packed table and an index by chunk; at each settle,
  // close enough for an icon to be read, it places the icons for the tiles the
  // pane shows and drops the rest. Twenty-eight thousand belt tiles drawn at
  // once would be a stall; a pane's worth is a few hundred.
  var beltTable = null, beltChunks = null, beltLayer = null, beltKey = "";
  var BELT_MIN_PX = 12;
  function beltIndex() {
    if (beltTable || !facts || !facts.belts) return beltTable;
    var bin = atob(facts.belts), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    beltTable = new Int16Array(u8.buffer);
    beltChunks = {};
    for (var j = 0; j < beltTable.length; j += 7) {
      var key = Math.floor(beltTable[j] / chunk) + "," + Math.floor(beltTable[j + 1] / chunk);
      (beltChunks[key] || (beltChunks[key] = [])).push(j);
    }
    return beltTable;
  }
  function beltAt(tx, ty) {
    var a = beltIndex();
    if (!a) return -1;
    var list = beltChunks[Math.floor(tx / chunk) + "," + Math.floor(ty / chunk)] || [];
    for (var i = 0; i < list.length; i++) if (a[list[i]] === tx && a[list[i] + 1] === ty) return list[i];
    return -1;
  }
  // What the pipes carry, from a second packed table of fours (x, y, fluid,
  // amount), indexed by chunk the same way and drawn in the same pass.
  var pipeTable = null, pipeChunks = null;
  function pipeIndex() {
    if (pipeTable || !facts || !facts.pipes) return pipeTable;
    var bin = atob(facts.pipes), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    pipeTable = new Int16Array(u8.buffer);
    pipeChunks = {};
    for (var j = 0; j < pipeTable.length; j += 4) {
      var key = Math.floor(pipeTable[j] / chunk) + "," + Math.floor(pipeTable[j + 1] / chunk);
      (pipeChunks[key] || (pipeChunks[key] = [])).push(j);
    }
    return pipeTable;
  }
  function pipeAt(tx, ty) {
    var a = pipeIndex();
    if (!a) return -1;
    var list = pipeChunks[Math.floor(tx / chunk) + "," + Math.floor(ty / chunk)] || [];
    for (var i = 0; i < list.length; i++) if (a[list[i]] === tx && a[list[i] + 1] === ty) return list[i];
    return -1;
  }
  var FORWARD = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  function drawBelts() {
    var alt = svg.querySelector('g[data-layer="alt"]');
    var d = drawn();
    var hasBelts = !!beltIndex(), hasPipes = !!pipeIndex();
    var show = alt && alt.classList.contains("on") && !alt.hasAttribute("data-lazy") && d.s >= BELT_MIN_PX && (hasBelts || hasPipes);
    if (!beltLayer && alt && show) {
      beltLayer = document.createElementNS(NS, "g");
      alt.appendChild(beltLayer);
    }
    if (!show) { if (beltLayer && beltKey) { beltLayer.innerHTML = ""; beltKey = ""; } return; }
    // The whole drawn extent, margin included, so a pan uncovers belts that
    // already carry their icons instead of bare belts that fill in on settle.
    var x0 = Math.floor(vb.x - vb.w * MARGIN), y0 = Math.floor(vb.y - vb.h * MARGIN);
    var x1 = Math.ceil(vb.x + vb.w * (1 + MARGIN)), y1 = Math.ceil(vb.y + vb.h * (1 + MARGIN));
    var key = [x0, y0, x1, y1].join(",");
    if (key === beltKey) return;
    beltKey = key;
    var a = beltTable || new Int16Array(0), items = facts.beltItems, out = [];
    function put(item, x, y, size) {
      if (item < 0) return;
      out.push('<use href="#i-' + items[item] + '" transform="translate(' + x.toFixed(2) + " " + y.toFixed(2) + ") scale(" + size + ')"/>');
    }
    for (var cx = Math.floor(x0 / chunk); cx <= Math.floor(x1 / chunk); cx++) {
      for (var cy = Math.floor(y0 / chunk); cy <= Math.floor(y1 / chunk); cy++) {
        var list = beltChunks[cx + "," + cy];
        if (!list) continue;
        for (var i = 0; i < list.length; i++) {
          var j = list[i], tx = a[j], ty = a[j + 1];
          if (tx < x0 || tx > x1 || ty < y0 || ty > y1) continue;
          var f = FORWARD[Math.round(a[j + 2] / 4) % 4], lx = f[1], ly = -f[0];
          var px = tx + 0.5, py = ty + 0.5;
          if (a[j + 3] === a[j + 5]) put(a[j + 3], px, py, 0.72);
          else {
            put(a[j + 3], px + lx * 0.25, py + ly * 0.25, 0.5);
            put(a[j + 5], px - lx * 0.25, py - ly * 0.25, 0.5);
          }
        }
        var plist = pipeChunks && pipeChunks[cx + "," + cy];
        if (!plist) continue;
        for (var q = 0; q < plist.length; q++) {
          var pj = plist[q], qx = pipeTable[pj], qy = pipeTable[pj + 1];
          if (qx < x0 || qx > x1 || qy < y0 || qy > y1) continue;
          put(pipeTable[pj + 2], qx + 0.5, qy + 0.5, 0.6);
        }
      }
    }
    beltLayer.innerHTML = out.join("");
  }

  // Labels never overprint. Every label carries a rank (data-p, set where the
  // layer is built), and once the view settles they are placed in rank order on
  // screen: one that would land on a label already placed is hidden for this
  // frame of the view, never removed, so zooming in brings it back. Widths are
  // measured once per label with the label's own font, because a label's screen
  // size is constant whatever the zoom. It runs once per settle, never per
  // frame of a pan: a few hundred rectangles compared pairwise is nothing, a few
  // hundred rectangles compared sixty times a second is a stutter.
  var labels = null;
  var measure = null;
  var LABEL_PX = 13;
  function labelList() {
    if (labels) return labels;
    labels = [].slice.call(svg.querySelectorAll(".lbl")).map(function (t) {
      return { t: t, p: Number(t.getAttribute("data-p")) || 0, x: Number(t.getAttribute("x")), y: Number(t.getAttribute("y")), w: 0 };
    });
    labels.sort(function (a, b) { return b.p - a.p; });
    return labels;
  }
  function widthOf(l) {
    if (l.w > 0) return l.w;
    if (!measure) {
      measure = document.createElement("canvas").getContext("2d");
      measure.font = "700 " + LABEL_PX + "px " + getComputedStyle(svg).getPropertyValue("--font");
    }
    l.w = measure.measureText(l.t.textContent).width;
    return l.w;
  }
  function declutter() {
    var d = drawn();
    var r = box.getBoundingClientRect();
    var placed = [];
    var pad = 3;
    labelList().forEach(function (l) {
      var layer = l.t.closest("g[data-labels-of]");
      if (layer && !layer.classList.contains("on")) return;
      var sx = d.left + (l.x - vb.x) * d.s;
      var sy = d.top + (l.y - vb.y) * d.s;
      var hw = widthOf(l) / 2 + pad;
      var a = [sx - hw, sy - LABEL_PX * 0.85 - pad, sx + hw, sy + LABEL_PX * 0.3 + pad];
      // Off the pane it can cover nothing, so it neither hides nor blocks.
      if (a[2] < r.left || a[0] > r.right || a[3] < r.top || a[1] > r.bottom) { l.t.classList.remove("hid"); return; }
      var hit = false;
      for (var i = 0; i < placed.length; i++) {
        var b = placed[i];
        if (a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) { hit = true; break; }
      }
      l.t.classList.toggle("hid", hit);
      if (!hit) placed.push(a);
    });
  }
  var labelTimer = null;
  function tidySoon() {
    if (labelTimer !== null) clearTimeout(labelTimer);
    labelTimer = setTimeout(function () { labelTimer = null; declutter(); }, 170);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { measure = null; labelList().forEach(function (l) { l.w = 0; }); declutter(); });
  }


  // Chunk lines, generated for the visible range only, and only once a chunk is
  // wide enough on screen to be read. They are the same 32 tiles the collector
  // buckets in, never a decorative grid at a made-up spacing.
  var gridKey = "";
  function drawGrid() {
    var d = drawn();
    if (d.s * chunk < 26) {
      if (gridKey !== "") { grid.innerHTML = ""; gridKey = ""; }
      return;
    }
    // The lines only change when the visible range of chunks changes, which is
    // far less often than the view moves.
    var gx = vb.x - vb.w * MARGIN, gy = vb.y - vb.h * MARGIN;
    var gw = vb.w * (1 + 2 * MARGIN), gh = vb.h * (1 + 2 * MARGIN);
    var key = [
      Math.floor(gx / chunk), Math.floor(gy / chunk),
      Math.ceil((gx + gw) / chunk), Math.ceil((gy + gh) / chunk),
    ].join(",");
    if (key === gridKey) return;
    gridKey = key;
    var x0 = Math.floor(gx / chunk) * chunk, x1 = gx + gw;
    var y0 = Math.floor(gy / chunk) * chunk, y1 = gy + gh;
    var out = [];
    for (var x = x0; x <= x1; x += chunk) out.push("M" + x + " " + gy + "V" + y1);
    for (var y = y0; y <= y1; y += chunk) out.push("M" + gx + " " + y + "H" + x1);
    grid.innerHTML = '<path vector-effect="non-scaling-stroke" fill="none" d="' + out.join("") + '"/>';
  }

  // A bar of a round number of tiles, sized to land between 80 and 200 pixels.
  function drawScale() {
    var d = drawn();
    var steps = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
    var tiles = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * d.s >= 80) { tiles = steps[i]; break; }
    }
    bar.style.width = Math.round(tiles * d.s) + "px";
    barTxt.textContent = tiles + " tiles" + (tiles >= chunk ? "  (" + (tiles / chunk).toFixed(tiles % chunk ? 1 : 0) + " chunks)" : "");
  }

  function zoomAt(cx, cy, factor) {
    var d = drawn();
    var ux = vb.x + (cx - d.left) / d.s;
    var uy = vb.y + (cy - d.top) / d.s;
    // Half a chunk across at the closest, so a short pane still reaches the zoom
    // where belt contents draw (BELT_MIN_PX): a 374 pixel pane floored at a
    // whole chunk gave 11.85 pixels a tile and never showed a belt's items.
    var w = Math.max(chunk / 2, Math.min(fit[2] * 4, vb.w * factor));
    var f = w / vb.w;
    vb.x = ux - (ux - vb.x) * f;
    vb.y = uy - (uy - vb.y) * f;
    vb.w = vb.w * f;
    vb.h = vb.h * f;
    apply();
  }

  function centre() {
    var r = box.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  function onUi(e) { return !!(e.target && e.target.closest && e.target.closest(".mapui")); }
  box.addEventListener("wheel", function (e) {
    // The layer list scrolls under the wheel; only the map itself zooms.
    if (onUi(e)) return;
    e.preventDefault();
    stopGlide();
    zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.18 : 1 / 1.18);
  }, { passive: false });

  // A drag carries on for a moment after release, the way a map in the hand
  // does, decaying to rest. Velocity is taken over the last few moves only, so a
  // drag that stopped before letting go does not fling.
  var drag = null;
  var glide = null;
  function stopGlide() { if (glide !== null) { cancelAnimationFrame(glide); glide = null; } }
  svg.addEventListener("pointerdown", function (e) {
    // A press on the map starts a pan, never a text selection: without this the
    // browser selected the reading beside the map as the pointer crossed it.
    if (e.button === 0) e.preventDefault();
    if (window.getSelection) { var sel = window.getSelection(); if (sel && !sel.isCollapsed) sel.removeAllRanges(); }
    document.body.classList.add("panning");
    stopGlide();
    drag = { x: e.clientX, y: e.clientY, trail: [[performance.now(), e.clientX, e.clientY]] };
    box.classList.add("dragging");
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer has nothing to capture */ }
  });
  svg.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var d = drawn();
    travelled += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
    vb.x -= (e.clientX - drag.x) / d.s;
    vb.y -= (e.clientY - drag.y) / d.s;
    drag.x = e.clientX; drag.y = e.clientY;
    var now = performance.now();
    drag.trail.push([now, e.clientX, e.clientY]);
    while (drag.trail.length > 2 && now - drag.trail[0][0] > 80) drag.trail.shift();
    apply();
  });
  function endDrag(e) {
    if (!drag) return;
    var t = drag.trail, now = performance.now();
    drag = null;
    box.classList.remove("dragging");
    document.body.classList.remove("panning");
    if (reduce || !e || t.length < 2 || now - t[t.length - 1][0] > 60) return;
    var dt = t[t.length - 1][0] - t[0][0];
    if (dt <= 0) return;
    // Pixels per millisecond, and a glide only when the hand was really moving.
    var vx = (t[t.length - 1][1] - t[0][1]) / dt, vy = (t[t.length - 1][2] - t[0][2]) / dt;
    if (Math.abs(vx) + Math.abs(vy) < 0.3) return;
    var last = now;
    glide = requestAnimationFrame(function step(ts) {
      var ms = Math.min(32, ts - last);
      last = ts;
      var d = drawn();
      vb.x -= (vx * ms) / d.s;
      vb.y -= (vy * ms) / d.s;
      var decay = Math.pow(0.994, ms);
      vx *= decay; vy *= decay;
      apply();
      if (Math.abs(vx) + Math.abs(vy) > 0.02) glide = requestAnimationFrame(step);
      else { glide = null; if (settle !== null) clearTimeout(settle); settle = setTimeout(commit, 60); }
    });
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", function () { endDrag(null); });
  svg.addEventListener("dblclick", function (e) { zoomAt(e.clientX, e.clientY, 1 / 1.6); });

  // The map alone, filling the window, with the legend beside it. The pane is
  // the same element restyled, so the view, the layers and the panel carry over
  // and the ResizeObserver redraws it at its new size.
  var pane = box.closest(".mappane");
  var fullBtn = document.getElementById("full");
  function setFull(on) {
    if (!pane) return;
    var next = on === undefined ? !pane.classList.contains("full") : on;
    if (next === pane.classList.contains("full")) return;
    pane.classList.toggle("full", next);
    document.body.classList.toggle("mapfull", next);
    if (fullBtn) fullBtn.setAttribute("aria-pressed", next ? "true" : "false");
    // The full view has the room for the layer list and an overview; the split
    // view gives its room back to the map, and keeps the list the way it was.
    setLegend(next ? true : legendSplit, true);
    showOverview(next);
  }
  if (fullBtn) fullBtn.addEventListener("click", function () { setFull(); });

  // The layer list floats over the map's right edge. Opening it never resizes
  // the map, so nothing redraws; the split view remembers whether it was open.
  var legendBtn = document.getElementById("layersbtn");
  var legendSplit = false;
  try { legendSplit = localStorage.getItem("factorio-advisor:legend") === "1"; } catch (err) { legendSplit = false; }
  function setLegend(on, auto) {
    var next = on === undefined ? !box.classList.contains("legend-open") : on;
    box.classList.toggle("legend-open", next);
    if (legendBtn) legendBtn.setAttribute("aria-pressed", next ? "true" : "false");
    if (next) setHelp(false);
    if (!auto && !(pane && pane.classList.contains("full"))) {
      legendSplit = next;
      try { localStorage.setItem("factorio-advisor:legend", next ? "1" : "0"); } catch (err) { /* private window */ }
    }
  }
  if (legendBtn) legendBtn.addEventListener("click", function () { setLegend(); });
  var legendClose = document.getElementById("legendclose");
  if (legendClose) legendClose.addEventListener("click", function () { setLegend(false); });
  setLegend(legendSplit, true);

  var help = document.getElementById("maphelp");
  var helpBtn = document.getElementById("helpbtn");
  function setHelp(on) {
    if (!help) return;
    var next = on === undefined ? help.hidden : on;
    help.hidden = !next;
    if (helpBtn) helpBtn.setAttribute("aria-pressed", next ? "true" : "false");
  }
  if (helpBtn) helpBtn.addEventListener("click", function () { setHelp(); });
  var helpClose = document.getElementById("helpclose");
  if (helpClose) helpClose.addEventListener("click", function () { setHelp(false); });

  // ---- The overview -----------------------------------------------------
  //
  // The base layers at the fit view, serialised once into an image the first
  // time the full view opens, and again only when a layer changes while it is
  // showing. An image costs nothing to repaint, so the view rectangle is the
  // only thing that moves with a pan. Art, alt mode, labels and the marks are
  // left out: at this size they are noise, and the art is most of the page.
  var ov = document.getElementById("overview");
  var ovImg = ov ? ov.querySelector("img") : null;
  var ovVp = ov ? ov.querySelector(".vp") : null;
  var ovUrl = null, ovStale = true, ovTimer = null;
  var ovPad = ov ? parseFloat(getComputedStyle(ov).paddingLeft) || 0 : 0;
  var OV_STYLE = "path,rect{vector-effect:non-scaling-stroke;stroke-width:1px;stroke:currentColor;stroke-linejoin:round}" +
    ".tile.water{opacity:.5}.cov{fill-opacity:.07;stroke-opacity:.4}.cov.build{display:none}";
  function buildOverview() {
    ovTimer = null;
    if (!ov || !ovImg) return;
    var out = '<svg xmlns="' + NS + '" viewBox="' + fit.join(" ") + '" width="600" height="' + Math.round(600 * fit[3] / fit[2]) + '">' +
      '<style>' + OV_STYLE + '</style><rect x="' + fit[0] + '" y="' + fit[1] + '" width="' + fit[2] + '" height="' + fit[3] + '" fill="#0f0f10" stroke="none"/>';
    [].slice.call(svg.querySelectorAll("g[data-layer].on")).forEach(function (g) {
      var grp = g.getAttribute("data-group");
      if (grp !== "ground" && grp !== "base") return;
      var id = g.getAttribute("data-layer");
      if (id === "art" || id === "alt") return;
      out += new XMLSerializer().serializeToString(g).replace(/<text[^>]*>[^<]*<\\/text>/g, "");
    });
    out += "</svg>";
    if (ovUrl) URL.revokeObjectURL(ovUrl);
    ovUrl = URL.createObjectURL(new Blob([out], { type: "image/svg+xml" }));
    ovImg.src = ovUrl;
    ovStale = false;
  }
  function showOverview(on) {
    if (!ov) return;
    ov.hidden = !on;
    if (on && ovStale && ovTimer === null) ovTimer = setTimeout(buildOverview, 0);
    if (on) drawOverviewView();
  }
  function overviewStale() {
    ovStale = true;
    if (ov && !ov.hidden && ovTimer === null) ovTimer = setTimeout(buildOverview, 250);
  }
  function drawOverviewView() {
    if (!ov || ov.hidden || !ovVp || !ovImg) return;
    var W = ovImg.clientWidth, H = ovImg.clientHeight;
    if (!W || !H) return;
    // The view as the pane shows it, letterbox included, so the rectangle is what is on screen.
    var r = box.getBoundingClientRect(), d = drawn();
    var vx = vb.x - (d.left - r.left) / d.s, vy = vb.y - (d.top - r.top) / d.s;
    var vw = r.width / d.s, vh = r.height / d.s;
    var k = W / fit[2];
    var x0 = Math.max(0, (vx - fit[0]) * k), y0 = Math.max(0, (vy - fit[1]) * k);
    var x1 = Math.min(W, (vx + vw - fit[0]) * k), y1 = Math.min(H, (vy + vh - fit[1]) * k);
    // Close in the view is a few pixels of the overview, so it keeps a findable
    // minimum size about its own centre rather than shrinking to a dot.
    var MIN = 12, w = x1 - x0, h = y1 - y0;
    if (w < MIN) { x0 -= (MIN - w) / 2; w = MIN; }
    if (h < MIN) { y0 -= (MIN - h) / 2; h = MIN; }
    ovVp.style.transform = "translate(" + (ovPad + x0).toFixed(1) + "px," + (ovPad + y0).toFixed(1) + "px)";
    ovVp.style.width = w.toFixed(1) + "px";
    ovVp.style.height = h.toFixed(1) + "px";
  }
  if (ov && ovImg) {
    var ovDrag = false;
    var ovMove = function (e) {
      var r = ovImg.getBoundingClientRect();
      var ux = fit[0] + ((e.clientX - r.left) / r.width) * fit[2];
      var uy = fit[1] + ((e.clientY - r.top) / r.height) * fit[3];
      stopGlide();
      vb.x = ux - vb.w / 2; vb.y = uy - vb.h / 2;
      apply();
    };
    ov.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      ovDrag = true;
      try { ov.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
      ovMove(e);
    });
    ov.addEventListener("pointermove", function (e) { if (ovDrag) ovMove(e); });
    ov.addEventListener("pointerup", function () { ovDrag = false; });
    ov.addEventListener("pointercancel", function () { ovDrag = false; });
    ovImg.addEventListener("load", drawOverviewView);
  }

  function doFit() { stopGlide(); vb = { x: fit[0], y: fit[1], w: fit[2], h: fit[3] }; apply(); }
  document.getElementById("fit").addEventListener("click", doFit);
  document.getElementById("zin").addEventListener("click", function () { var c = centre(); zoomAt(c[0], c[1], 1 / 1.4); });
  document.getElementById("zout").addEventListener("click", function () { var c = centre(); zoomAt(c[0], c[1], 1.4); });

  var toggles = [].slice.call(document.querySelectorAll("[data-toggle]"));
  function setLayer(id, on) {
    var g = svg.querySelector('g[data-layer="' + id + '"]');
    var b = document.querySelector('[data-toggle="' + id + '"]');
    if (!g || !b) return;
    var next = on === undefined ? !g.classList.contains("on") : on;
    g.classList.toggle("on", next);
    var lg = svg.querySelector('g[data-labels-of="' + id + '"]');
    if (lg) lg.classList.toggle("on", next);
    b.setAttribute("aria-pressed", next ? "true" : "false");
    tidySoon();
    if (id === "alt") { beltKey = ""; drawBelts(); }
    countLayers();
    if (g.getAttribute("data-group") !== "places") overviewStale();
  }
  var layerCount = document.getElementById("layercount");
  function countLayers() {
    if (!layerCount) return;
    layerCount.textContent = svg.querySelectorAll("g[data-layer].on").length + "/" + toggles.length;
  }
  toggles.forEach(function (b) {
    b.addEventListener("click", function () { setLayer(b.getAttribute("data-toggle")); });
  });

  // Move the map to a place a line of text named, and turn on the layer that
  // explains it. Padded so the target sits inside the view rather than against
  // its edge, and floored at a few chunks so a small target is not zoomed into
  // a void.
  var flashed = null;
  var mark = document.getElementById("mark");
  var badge = document.getElementById("focusbadge");
  var NS = "http://www.w3.org/2000/svg";
  // The place itself, outlined on top of every layer, so a click says which
  // tiles it means rather than leaving the player to guess inside a padded view.
  // A point is drawn as a few tiles around it, because a zero-size box has no
  // outline to see.
  function drawMark(x, y, w, h, label) {
    if (!mark) return;
    mark.innerHTML = "";
    var m = 3;
    var r = { x: x - (w < m ? (m - w) / 2 : 0), y: y - (h < m ? (m - h) / 2 : 0), w: Math.max(w, m), h: Math.max(h, m) };
    var cs = getComputedStyle(mark);
    var ink = cs.color, under = cs.getPropertyValue("--void") || "#000";
    // Everything but the place goes dark, so the eye lands on it whatever the
    // layers around it are doing. The outer rectangle is far larger than any
    // base, and evenodd fill cuts the place out of it.
    var big = Math.max(fit[2], fit[3]) * 4;
    var shade = document.createElementNS(NS, "path");
    shade.setAttribute("class", "shade");
    shade.setAttribute("fill", under);
    shade.setAttribute("fill-opacity", "0.62");
    shade.setAttribute("fill-rule", "evenodd");
    shade.setAttribute("d",
      "M" + (fit[0] - big) + " " + (fit[1] - big) + "h" + (fit[2] + 2 * big) + "v" + (fit[3] + 2 * big) + "h" + (-(fit[2] + 2 * big)) + "Z" +
      "M" + r.x + " " + r.y + "h" + r.w + "v" + r.h + "h" + (-r.w) + "Z");
    mark.appendChild(shade);
    // A crosshair through the centre, across the whole map, so a place a few
    // tiles wide is still found at any zoom.
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    var cross = document.createElementNS(NS, "path");
    cross.setAttribute("class", "cross");
    cross.setAttribute("stroke", ink);
    cross.setAttribute("fill", "none");
    cross.setAttribute("d",
      "M" + (fit[0] - big) + " " + cy + "H" + r.x + "M" + (r.x + r.w) + " " + cy + "H" + (fit[0] + fit[2] + big) +
      "M" + cx + " " + (fit[1] - big) + "V" + r.y + "M" + cx + " " + (r.y + r.h) + "V" + (fit[1] + fit[3] + big));
    mark.appendChild(cross);
    var paint = {
      halo: { fill: "none", stroke: under },
      box: { fill: ink, "fill-opacity": "0.14", stroke: ink },
      pulse: { fill: "none", stroke: ink },
    };
    ["halo", "box", "pulse"].forEach(function (c) {
      var e = document.createElementNS(NS, "rect");
      e.setAttribute("class", c);
      for (var k in paint[c]) e.setAttribute(k, paint[c][k]);
      e.setAttribute("x", r.x); e.setAttribute("y", r.y);
      e.setAttribute("width", r.w); e.setAttribute("height", r.h);
      mark.appendChild(e);
    });
    // The words go in a badge pinned to the map's corner, in screen pixels, so
    // they are never lost among the map's own labels.
    if (badge) {
      var where = w === 0 && h === 0 ? "x " + x + ", y " + y : "x " + x + " to " + (x + w) + ", y " + y + " to " + (y + h);
      badge.textContent = "Showing " + (label || where) + "  \u00b7  Esc clears";
      badge.hidden = false;
    }
  }
  function clearMark() { if (mark) mark.innerHTML = ""; if (badge) badge.hidden = true; }
  function focusOn(x, y, w, h, layer, label) {
    stopGlide();
    if (layer) setLayer(layer, true);
    drawMark(x, y, w, h, label);
    // Padded enough to show what surrounds the place, close enough that the
    // place is most of the view: a belt end three tiles wide used to sit in a
    // 128-tile window and read as nothing. Floored at 40 tiles, which is still
    // close enough for the game's own art to draw.
    var pad = Math.max(w, h) * 0.5 + 10;
    var side = Math.max(w + pad * 2, h + pad * 2, 40);
    var target = { x: x + w / 2 - side / 2, y: y + h / 2 - side / 2, w: side, h: side };
    if (reduce) { vb = target; apply(); return; }
    var from = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
    var t0 = performance.now();
    (function step(now) {
      var k = Math.min(1, (now - t0) / 420);
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      vb.x = from.x + (target.x - from.x) * e;
      vb.y = from.y + (target.y - from.y) * e;
      vb.w = from.w + (target.w - from.w) * e;
      vb.h = from.h + (target.h - from.h) * e;
      apply();
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  function hookFocus(el) {
    var fx = el.getAttribute("data-fx");
    if (!fx) return;
    function go(e) {
      // A coordinate inside a step means that spot, not the whole step.
      if (e) e.stopPropagation();
      var p = fx.split(" ");
      focusOn(Number(p[0]), Number(p[1]), Number(p[2]), Number(p[3]), p[4], el.getAttribute("data-fx-label"));
      if (flashed) flashed.classList.remove("flash");
      el.classList.add("flash"); flashed = el;
      // On a narrow screen the map is not beside the text, so bring it to the
      // reader; beside it, nearest is already in view and nothing moves.
      if (!box.contains(el)) box.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
    }
    el.addEventListener("click", go);
    el.addEventListener("keydown", function (e) {
      if (e.target !== el) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); }
    });
  }
  [].slice.call(document.querySelectorAll("[data-fx]")).forEach(hookFocus);
  // A section tag inside a line of advice is a link to that section, not a question about the map.
  [].slice.call(document.querySelectorAll(".advice .tag")).forEach(function (a) {
    a.addEventListener("click", function (e) { e.stopPropagation(); });
  });

  // A step opens its own reasoning in place. The button stops the click from
  // also flying the map, because wanting to read why is not wanting to move.
  [].slice.call(document.querySelectorAll("[data-open]")).forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      var step = b.closest(".step");
      if (!step) return;
      var open = step.classList.toggle("open");
      b.textContent = open ? "hide" : "why & how";
    });
  });

  // A section has no single place, so its control turns on the layer that
  // explains it and fits the whole base. Panning a section somewhere would be
  // inventing a location the section never named.
  // A section's button shows its own layer ALONE among the layers that draw the
  // base. Turning it on while eleven others are already on changed nothing on
  // screen, which is the same as the button not working. The ground and the
  // places stay as they are, because a base with no coastline under it is not
  // easier to read, it is only emptier. Reset puts every layer back.
  var defaults = {};
  toggles.forEach(function (b) {
    defaults[b.getAttribute("data-toggle")] = b.getAttribute("aria-pressed") === "true";
  });
  function soloBase(id) {
    toggles.forEach(function (b) {
      var lid = b.getAttribute("data-toggle");
      var g = svg.querySelector('g[data-layer="' + lid + '"]');
      if (!g || g.getAttribute("data-group") !== "base") return;
      setLayer(lid, lid === id);
    });
  }
  [].slice.call(document.querySelectorAll("[data-show]")).forEach(function (b) {
    b.addEventListener("click", function () {
      soloBase(b.getAttribute("data-show"));
      doFit();
      box.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
    });
  });
  var reset = document.getElementById("reset");
  if (reset) {
    reset.addEventListener("click", function () {
      toggles.forEach(function (b) {
        var lid = b.getAttribute("data-toggle");
        setLayer(lid, defaults[lid]);
      });
      doFit();
    });
  }

  document.addEventListener("keydown", function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "f") { doFit(); return; }
    // Esc peels one thing at a time: an open panel first, and only then the
    // highlight and the view. Closing a panel used to throw away the place you
    // were looking at, which made Esc a key to avoid.
    if (e.key === "Escape" && help && !help.hidden) { setHelp(false); return; }
    if (e.key === "Escape" && pin && !pin.hidden) { pin.hidden = true; return; }
    var full = pane && pane.classList.contains("full");
    if (e.key === "Escape" && !full && box.classList.contains("legend-open")) { setLegend(false); return; }
    if (e.key === "Escape" && full) { setFull(false); return; }
    if (e.key === "m") { setFull(); return; }
    if (e.key === "l") { setLegend(); return; }
    if (e.key === "?") { setHelp(); return; }
    if (e.key === "Escape") {
      doFit();
      if (flashed) { flashed.classList.remove("flash"); flashed = null; }
      clearMark();
      return;
    }
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= toggles.length) setLayer(toggles[n - 1].getAttribute("data-toggle"));
  });

  // Where the pointer is, in the save's own tile coordinates, so a place on this
  // map can be typed into the game rather than eyeballed against it.
  var xy = document.getElementById("xy");
  box.addEventListener("pointermove", function (e) {
    if (!xy) return;
    if (onUi(e)) { xy.textContent = ""; return; }
    var d = drawn();
    var ux = vb.x + (e.clientX - d.left) / d.s;
    var uy = vb.y + (e.clientY - d.top) / d.s;
    xy.textContent = Math.round(ux) + ", " + Math.round(uy);
  });

  // ---- What is here -----------------------------------------------------
  //
  // A click answers in three passes, cheapest first, and each one is a
  // different kind of knowing. The art layer draws one element per machine, so
  // a hit there names that machine exactly. Failing that, the layer paths are
  // asked which of them covers the point, which names a family rather than a
  // thing: merged runs are what make the map fast and what make a single belt
  // impossible to pick out of it, and the panel says so rather than guessing.
  // The chunk is always read, because a place is worth describing even where
  // nothing was hit.
  var facts = null;
  try {
    var el = document.getElementById("mapfacts");
    if (el) facts = JSON.parse(el.textContent);
  } catch (e) { facts = null; }
  var pin = document.getElementById("pin");

  function tidy(name) { return name.replace(/-/g, " "); }
  function commas(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  function watts(w) {
    if (!w) return "0";
    if (w >= 1e6) return (w / 1e6).toFixed(1) + " MW";
    if (w >= 1e3) return (w / 1e3).toFixed(0) + " kW";
    return w + " W";
  }
  function amount(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
    return commas(n);
  }

  // The entity the pointer is over, from the art layer, which is the only layer
  // with one element per thing.
  function hitEntity(x, y) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      var e = stack[i];
      if (e.tagName === "use") {
        var href = e.getAttribute("href") || "";
        if (href.indexOf("#s-") === 0) return href.slice(3);
      }
      // Any outline names its own prototype, so what has no art still answers.
      if (e.tagName === "path" && e.getAttribute("data-n")) return e.getAttribute("data-n");
    }
    return null;
  }

  // Which drawing layers cover a tile, asked of the geometry itself.
  function layersAt(ux, uy) {
    var out = [];
    var pt = svg.createSVGPoint();
    pt.x = ux; pt.y = uy;
    var gs = svg.querySelectorAll('g[data-layer].on');
    for (var i = 0; i < gs.length; i++) {
      var id = gs[i].getAttribute("data-layer");
      if (id === "art" || id === "alt" || id === "ground") continue;
      var paths = gs[i].querySelectorAll("path,rect");
      for (var j = 0; j < paths.length; j++) {
        var p = paths[j];
        try {
          if (p.isPointInFill && p.isPointInFill(pt)) { out.push(id); break; }
        } catch (err) { /* a shape that cannot be asked is not a hit */ }
      }
    }
    return out;
  }

  // The areas a point falls inside, which already carry their own label.
  function areasAt(ux, uy) {
    var out = [];
    var gs = svg.querySelectorAll("g.area");
    for (var i = 0; i < gs.length; i++) {
      var g = gs[i];
      if (!g.closest("g[data-layer].on")) continue;
      var ax = Number(g.getAttribute("data-x")), ay = Number(g.getAttribute("data-y"));
      var aw = Number(g.getAttribute("data-w")), ah = Number(g.getAttribute("data-h"));
      if (ux >= ax && ux <= ax + aw && uy >= ay && uy <= ay + ah) {
        var t = g.querySelector("title");
        if (t) out.push(t.textContent);
      }
    }
    return out;
  }

  function rows(pairs) {
    var out = "";
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i][1] === null) continue;
      out += "<dt>" + pairs[i][0] + "</dt><dd>" + pairs[i][1] + "</dd>";
    }
    return out ? "<dl>" + out + "</dl>" : "";
  }

  // The record of the one placed thing under a click: same prototype, footprint
  // around the point. Positions are centres, so a point inside the footprint is
  // within half its size on each axis.
  function thingAt(list, name, ux, uy, p) {
    if (!list) return null;
    var hw = (p.w || 1) / 2 + 0.01, hh = (p.h || 1) / 2 + 0.01;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t[2] === name && Math.abs(t[0] - ux) <= hw && Math.abs(t[1] - uy) <= hh) return t;
    }
    return null;
  }
  function withIcon(n) {
    var u = facts && facts.icons[n];
    return (u ? '<img class="ico" src="' + u + '" alt="">' : "") + tidy(n);
  }

  function describe(ux, uy, name) {
    var cell = facts ? facts.cell : chunk;
    var cx = Math.floor(ux / cell), cy = Math.floor(uy / cell);
    var key = cx + "," + cy;
    var html = "";
    var pairs = [];

    if (name && facts && facts.protos[name]) {
      var p = facts.protos[name];
      html += '<h4>' + (p.icon ? '<img src="' + p.icon + '" alt="">' : "") + tidy(name) +
        (p.type ? ' <span class="kind">' + tidy(p.type) + "</span>" : "") + "</h4>";
      pairs.push(["footprint", p.w + " x " + p.h + " tiles"]);
      pairs.push(["placed on this base", p.count === undefined ? null : commas(p.count)]);
      pairs.push(["draws", p.usage ? watts(p.usage) : null]);
      pairs.push(["idle drain", p.drain ? watts(p.drain) : null]);
      pairs.push(["buffer", p.buffer ? (p.buffer / 1e6).toFixed(1) + " MJ" : null]);
      // What this one machine is set to, or what this one container holds,
      // read off the save rather than off the prototype.
      var m = thingAt(facts.machines, name, ux, uy, p);
      if (m) {
        pairs.push(["makes", m[3] ? withIcon(m[3]) : "nothing set"]);
        if (m[4]) {
          var mods = Object.keys(m[4]).map(function (k) { return m[4][k] + " &times; " + withIcon(k); });
          pairs.push(["modules", mods.join("<br>")]);
        } else pairs.push(["modules", "none"]);
      }
      var bi = /belt|splitter|loader/.test(p.type || "") ? beltAt(Math.floor(ux), Math.floor(uy)) : -1;
      if (bi >= 0) {
        var bt = beltTable;
        [["left lane", 3], ["right lane", 5]].forEach(function (lane) {
          var it = bt[bi + lane[1]];
          pairs.push([lane[0], it < 0 ? "empty" : bt[bi + lane[1] + 1] + " &times; " + withIcon(facts.beltItems[it])]);
        });
      }
      var pi = /^(pipe|pipe-to-ground|pump)$/.test(p.type || "") ? pipeAt(Math.floor(ux), Math.floor(uy)) : -1;
      if (/^(pipe|pipe-to-ground|pump)$/.test(p.type || "")) {
        pairs.push(["carries", pi < 0 ? "nothing" : commas(pipeTable[pi + 3]) + " &times; " + withIcon(facts.beltItems[pipeTable[pi + 2]])]);
      }
      var c = thingAt(facts.holds, name, ux, uy, p);
      if (c) {
        if (c[4]) pairs.push([withIcon(c[4].name), commas(c[4].amount) + (p.volume ? " of " + commas(p.volume) : "")]);
        if (c[3]) {
          var items = Object.keys(c[3]).sort(function (a, b) { return c[3][b] - c[3][a]; });
          for (var k = 0; k < Math.min(10, items.length); k++) pairs.push([withIcon(items[k]), commas(c[3][items[k]])]);
          if (items.length > 10) pairs.push(["and " + (items.length - 10) + " more kinds", ""]);
        }
        if (!c[3] && !c[4]) pairs.push(["holds", "nothing"]);
      }
    } else {
      var here = facts && facts.chunks[key];
      html += "<h4>" + Math.round(ux) + ", " + Math.round(uy) +
        ' <span class="kind">chunk ' + cx + ", " + cy + "</span></h4>";
      if (here) {
        var kinds = Object.keys(here.by).sort(function (a, b) { return here.by[b] - here.by[a]; });
        for (var i = 0; i < Math.min(5, kinds.length); i++) {
          pairs.push([tidy(kinds[i]), commas(here.by[kinds[i]])]);
        }
        if (kinds.length > 5) pairs.push(["and " + (kinds.length - 5) + " more kinds", commas(here.total)]);
      }
    }

    var ore = facts && facts.ore[key];
    if (ore) {
      var res = Object.keys(ore).sort(function (a, b) { return ore[b] - ore[a]; });
      for (var r = 0; r < res.length; r++) pairs.push([tidy(res[r]) + " here", amount(ore[res[r]])]);
    }
    var foe = facts && facts.enemy[key];
    if (foe) pairs.push(["nests and worms", foe[0] + " and " + foe[1]]);
    var chunkNow = facts && facts.chunks[key];
    if (chunkNow && chunkNow.pollution) pairs.push(["pollution", commas(chunkNow.pollution)]);

    html += rows(pairs);

    var areas = areasAt(ux, uy);
    var fams = layersAt(ux, uy);
    var where = [];
    if (areas.length) where.push(areas.join(" · "));
    if (fams.length) where.push("in the " + fams.join(", ") + " layer" + (fams.length > 1 ? "s" : ""));
    if (name) where.push("position and size from the save and the snapshot");
    else if (chunkNow) where.push("counted per chunk: merged runs cannot name one belt");
    if (where.length) html += '<p class="where">' + where.join("<br>") + "</p>";
    return html;
  }

  function openPin(clientX, clientY) {
    if (!pin) return;
    var d = drawn();
    var ux = vb.x + (clientX - d.left) / d.s;
    var uy = vb.y + (clientY - d.top) / d.s;
    var name = hitEntity(clientX, clientY);
    pin.innerHTML = '<button type="button" class="close" aria-label="close">&times;</button>' +
      describe(ux, uy, name);
    pin.hidden = false;
    var r = box.getBoundingClientRect();
    var px = Math.min(Math.max(clientX - r.left + 12, 6), r.width - pin.offsetWidth - 6);
    var py = Math.min(Math.max(clientY - r.top + 12, 6), r.height - pin.offsetHeight - 6);
    pin.style.left = px + "px";
    pin.style.top = py + "px";
    var c = pin.querySelector(".close");
    if (c) c.addEventListener("click", function () { pin.hidden = true; });
  }

  // A click that followed a drag is a pan, not a question.
  // The whole way the pointer travelled, not where it ended: a drag that comes
  // back near where it started is still a drag, and used to open the panel.
  // A press that was held still for a long time is a hesitation, not a click,
  // only when it moved; so time is not part of the test.
  var downAt = null;
  var travelled = 0;
  svg.addEventListener("pointerdown", function (e) { downAt = [e.clientX, e.clientY]; travelled = 0; });
  svg.addEventListener("click", function (e) {
    if (!downAt) return;
    downAt = null;
    if (travelled > 5 || glide !== null) return;
    openPin(e.clientX, e.clientY);
  });

  new ResizeObserver(function () { commit(); }).observe(box);
  commit();
})();
`;

export interface PageInput {
  report: ReportData;
  state: GameState;
  stateFile: string;
  /** The derived sections, empty when the snapshot could not answer. */
  sections: SectionView[];
  /** Earlier reports, newest first, as file names. */
  history: string[];
  /**
   * A written plan for this save, when one has been produced beside the
   * dashboard. Passed rather than assumed: a link to a page that does not
   * exist is worse than no link.
   */
  plan?: PlanView | null;
  /**
   * The game's own icons, read out of the installed game rather than copied
   * into this repo. Absent when the install cannot be found, and then every
   * name simply stands on its own.
   */
  icons?: Icons | null;
  /** What is holding the factory back, when the state file can answer. */
  bottlenecks?: BottleneckReport | null;
  /** The one map's layers, or null when the state file carries no map. */
  model?: MapModel | null;
  /**
   * Milestones earned on this map, with the earliest archived read of it for the "since" line. Absent or empty leaves the page exactly as it was.
   */
  milestones?: { earned: Earned[]; firstRead: GameState | null } | null;
}

/**
 * The advice, twice over and deliberately.
 *
 * The wide card at the top is the priority list, with the measurement under
 * each line, because that is what the page is for. A section repeats only the
 * line itself, next to the figures and the map it applies to, so the context is
 * there without the page saying everything twice.
 */
function adviceList(items: Advice[], full: boolean): string {
  return (
    `<ol class="advice">` +
    items
      .map((item) => {
        // Only a line whose own text names the coordinates becomes clickable.
        // A line that panned the map somewhere it never mentioned would be a
        // claim the reader cannot check, which is the C33 falsifier.
        const f = item.focus;
        const hook = f
          ? ` data-fx="${f.x.toFixed(0)} ${f.y.toFixed(0)} ${f.w.toFixed(0)} ${f.h.toFixed(0)} ${esc(f.layer)}"` +
            ` tabindex="0" role="button"` +
            ` title="Show this on the map"`
          : "";
        return (
          `<li${hook}><b>${esc(item.text)}</b>` +
          (full
            ? `<a class="tag" href="#sec-${esc(item.section)}" title="Go to the ${esc(item.section)} section">${iconOnly(SECTION_ICON[item.section])}${esc(item.section)}</a>`
            : "") +
          (full ? `<span class="why">${esc(item.because)}</span>` : "") +
          `</li>`
        );
      })
      .join("") +
    `</ol>`
  );
}

/**
 * The one map (C33): its layers, its controls, and its legend.
 *
 * Every count in the legend is three facts, not one: what the layer drew, what
 * the census says exists, and which prototypes had no positions to draw. The
 * collector keeps exact positions only under its point limit, so a layer can
 * know about 1130 machines and be able to place none of them. Saying "drawn"
 * where it means "exists" is how a map starts disagreeing with the dashboard
 * beside it.
 */
function layerKey(l: MapLayer): string {
  const style = l.mark === "box" ? `color:${l.colour}` : `background:${l.colour}`;
  return `<span class="key ${l.mark}" style="${style}"></span>`;
}

const GROUP_TITLES: Array<[LayerGroup, string]> = [
  ["ground", "The ground"],
  ["base", "Your base"],
  ["places", "Places"],
];

/** Layers shown only close in, and shipped as inert text until the first time they could be seen. */
const CLOSE_LAYERS = new Set(["art", "alt"]);

/** A map label as `layers.ts` writes it, whole: its text never holds markup, since `esc` ran on it. */
const LABEL_RE = /<text class="lbl"[^>]*>[^<]*<\/text>/g;

/** The title bar's tool icons, drawn inline (the page loads nothing) on a 16 unit grid in the stroke weight the game's own GUI icons use. */
const TOOL_ICONS = {
  fit: icon("M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3M6 6h4v4H6z"),
  zin: icon("M3 8h10M8 3v10"),
  zout: icon("M3 8h10"),
  layers: icon("M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3"),
  reset: icon("M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3"),
  help: icon("M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .9-1 1.6V10M8 12.5v.5"),
  full: icon("M2 6V2h4M2 2l4 4M14 6V2h-4M14 2l-4 4M2 10v4h4M2 14l4-4M14 10v4h-4M14 14l-4-4"),
};
function icon(d: string): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
}

function mapPane(model: MapModel): string {
  const { viewBox: v } = model;
  // The art layer is most of the page's weight (every sprite, inlined) and is only ever shown close in, so it ships as inert text and becomes SVG the first time the view gets close enough to draw it. Until then the parser skips it and the DOM never holds its thousands of nodes.
  let lazyArt = "";
  // Labels are lifted out of their layers and drawn above every shape, or a
  // power block's name lies under the machines of the layers painted after it.
  // Each layer's labels keep their own group, tagged with the layer they came
  // from, so the layer's toggle still shows and hides them.
  const lifted: string[] = [];
  const groups = model.layers
    .map((l) => {
      const texts = l.body.match(LABEL_RE) ?? [];
      if (texts.length > 0) {
        lifted.push(
          `<g data-labels-of="${esc(l.id)}" class="${l.on ? "on" : ""}" fill="${esc(l.colour)}" color="${esc(l.colour)}">${texts.join("")}</g>`,
        );
      }
      const body = texts.length > 0 ? l.body.replace(LABEL_RE, "") : l.body;
      // A body that could close the script early is drawn inline as before rather than escaped, because an escape would reach innerHTML as literal text.
      const lazy = CLOSE_LAYERS.has(l.id) && body.length > 0 && !/<\/script/i.test(body);
      if (lazy) lazyArt += `<script type="text/plain" id="${esc(l.id)}src">${body}</script>`;
      return (
        `<g data-layer="${esc(l.id)}" data-group="${esc(l.group)}" class="${l.mark} ${l.on ? "on" : ""}" ` +
        `fill="${esc(l.colour)}" color="${esc(l.colour)}"${lazy ? ` data-lazy="${esc(l.id)}src"` : ""}>${lazy ? "" : body}</g>`
      );
    })
    .join("") + lifted.join("");

  // The digit shortcut is assigned across the whole list in render order, so the
  // number beside an entry is the key that toggles it, whichever group it is in.
  let digit = 0;
  const legend = GROUP_TITLES.map(([g, title]) => {
    const items = model.layers.filter((l) => l.group === g);
    if (items.length === 0) return "";
    const rows = items
      .map((l) => {
        digit += 1;
        const n = l.drawn === l.census ? String(l.drawn) : `${String(l.drawn)} of ${String(l.census)}`;
        return (
          `<li><button type="button" data-toggle="${esc(l.id)}" aria-pressed="${l.on ? "true" : "false"}" ` +
          `title="${esc(l.note || l.label)}">` +
          `<span class="digit">${digit <= 9 ? String(digit) : ""}</span>${layerKey(l)}` +
          `<span class="name">${esc(l.label)}</span><span class="n">${esc(n)}</span></button>` +
          (l.missing.length > 0 ? `<span class="miss gap">${esc(l.note)}</span>` : "") +
          `</li>`
        );
      })
      .join("");
    return `<div class="lgroup"><h3>${esc(title)}</h3><ul class="layers">${rows}</ul></div>`;
  }).join("");

  const on = model.layers.filter((l) => l.on).length;
  return (
    `<aside class="mappane">` +
    // The window's title bar, laid out the way the game lays out one: the name, a
    // strip of draggable space, then the window's own buttons. Everything else the
    // map needs sits on the map itself, so the map keeps the pane.
    `<div class="mapbar"><h2>${esc(model.surface)}</h2><span class="dragspace" aria-hidden="true"></span>` +
    `<div class="maptools" role="toolbar" aria-label="Map controls">` +
    `<button type="button" class="tool" id="fit" title="Fit the whole base (f)">${TOOL_ICONS.fit}</button>` +
    `<button type="button" class="tool" id="zin" title="Zoom in (wheel)">${TOOL_ICONS.zin}</button>` +
    `<button type="button" class="tool" id="zout" title="Zoom out (wheel)">${TOOL_ICONS.zout}</button>` +
    `<span class="toolsep"></span>` +
    `<button type="button" class="tool wide" id="layersbtn" aria-pressed="false" aria-controls="legend" title="Map layers (l)">${TOOL_ICONS.layers}<span>Layers</span><span class="count" id="layercount">${String(on)}/${String(model.layers.length)}</span></button>` +
    `<button type="button" class="tool" id="reset" title="Every layer back to its default, whole base">${TOOL_ICONS.reset}</button>` +
    `<span class="toolsep"></span>` +
    `<button type="button" class="tool" id="helpbtn" aria-pressed="false" aria-controls="maphelp" title="Controls (?)">${TOOL_ICONS.help}</button>` +
    `<button type="button" class="tool" id="full" aria-pressed="false" title="Fill the window with the map (m)">${TOOL_ICONS.full}</button>` +
    `</div></div>` +
    `<div id="mapbox"><svg id="map" role="img" aria-label="Base map of ${esc(model.surface)}" ` +
    `viewBox="${v.x.toFixed(0)} ${v.y.toFixed(0)} ${v.w.toFixed(0)} ${v.h.toFixed(0)}" ` +
    `data-fit="${v.x.toFixed(0)} ${v.y.toFixed(0)} ${v.w.toFixed(0)} ${v.h.toFixed(0)}" ` +
    `data-chunk="${String(model.cellTiles)}" preserveAspectRatio="xMidYMid meet">` +
    `<g id="grid" stroke="currentColor" stroke-width="0.5" opacity="0.14"></g>` +
    groups +
    `<g id="mark"></g>` +
    `</svg><div id="focusbadge" hidden></div>` +
    // Overlays: anything inside .mapui is the map's own GUI, and a wheel or a drag on it never moves the map.
    `<div class="mapui" id="legend" role="region" aria-label="Map layers"><div class="uihead">Map layers<button type="button" class="x" id="legendclose" title="Close (l)" aria-label="Close the layer list">&times;</button></div>` +
    `<div class="legend-groups">${legend}</div></div>` +
    `<div class="mapui" id="overview" hidden title="The whole base: click or drag to move there"><img alt="" draggable="false"><span class="vp"></span></div>` +
    `<div class="mapui" id="maphelp" hidden><div class="uihead">Controls<button type="button" class="x" id="helpclose" aria-label="Close the controls">&times;</button></div><dl>` +
    `<dt>drag</dt><dd>pan, with a glide on release</dd>` +
    `<dt>wheel, double-click</dt><dd>zoom about the pointer</dd>` +
    `<dt>click</dt><dd>what is here: recipe, modules, contents, belt lanes</dd>` +
    `<dt><kbd>1</kbd>-<kbd>9</kbd></dt><dd>toggle the numbered layers</dd>` +
    `<dt><kbd>l</kbd></dt><dd>the layer list</dd>` +
    `<dt><kbd>m</kbd></dt><dd>full view</dd>` +
    `<dt><kbd>f</kbd></dt><dd>fit the whole base</dd>` +
    `<dt><kbd>Esc</kbd></dt><dd>closes what is open, one at a time, then fits and clears</dd>` +
    `</dl><p>Close in, the game's own art appears, then recipes, modules and what the belts and pipes carry.</p></div>` +
    `<div class="corner bl" id="scalebar"><span class="bar"></span><span class="txt"></span></div>` +
    `<span class="corner br" id="xy"></span>` +
    `<div id="pin" hidden></div></div>` +
    lazyArt +
    `<script type="application/json" id="mapfacts">${JSON.stringify(model.facts).replace(/</g, "\\u003c")}</script>` +
    `</aside>`
  );
}

/**
 * The "Read latest save" button, and the page reloading itself.
 *
 * The page is a file and cannot run anything, so both talk to the endpoint the
 * watch loop serves on loopback. The button asks for a read and reloads when it
 * lands; the poll reloads when the loop has read a newer tick than the one this
 * page was drawn from, so saving in game is enough while watch runs. Nobody
 * listening is said plainly, never retried in silence.
 */
/** Loopback port of the watch loop's refresh endpoint; FACTORIO_ADVISOR_PORT overrides it. */
export const REFRESH_PORT = Number(process.env.FACTORIO_ADVISOR_PORT ?? 8737);

const REFRESH_SCRIPT = `(function(){
  var box = document.querySelector(".refresh"); if (!box) return;
  var btn = box.querySelector("button"), msg = box.querySelector(".msg");
  var save = box.getAttribute("data-save"), tick = Number(box.getAttribute("data-tick"));
  var base = "http://127.0.0.1:${String(REFRESH_PORT)}";
  var q = "?save=" + encodeURIComponent(save);
  var hold = 0;
  function say(t, bad, keep){ msg.textContent = t; msg.className = "msg" + (bad ? " bad" : ""); if (keep) hold = Date.now() + 20000; }
  var down = function(){ say("not running: start bun run watch in the repo", true); };
  btn.addEventListener("click", function(){
    btn.disabled = true; say("reading the save…");
    fetch(base + "/refresh" + q, { method: "POST" }).then(function(r){ return r.json(); }).then(function(j){
      if (!j.ok) { btn.disabled = false; say(j.error || "read failed", true, true); return; }
      if (j.tick === tick) { btn.disabled = false; say("no newer save: press Ctrl+S in game first", false, true); return; }
      location.reload();
    }).catch(function(){ btn.disabled = false; down(); });
  });
  function poll(){
    fetch(base + "/status" + q).then(function(r){ return r.json(); }).then(function(j){
      // Reload once per newer tick. A copy of the page that watch does not rewrite (a worktree, a saved file) would otherwise come back with the same old tick and reload every five seconds for ever.
      if (j.tick !== null && j.tick !== tick) {
        // Without session storage there is no way to know a reload already happened, so none is made rather than risking the loop.
        var key = "advisor-reloaded:" + save + ":" + j.tick, tried = "1";
        try { tried = sessionStorage.getItem(key); if (!tried) sessionStorage.setItem(key, "1"); } catch (e) { tried = "1"; }
        if (!tried) { location.reload(); return; }
        if (!btn.disabled && Date.now() > hold) say("watch has read tick " + j.tick + ", but this copy of the page is not the one it rewrites", true);
        return;
      }
      if (!btn.disabled && Date.now() > hold) { say(j.busy ? "watch is reading a save" : "watch running, saves update this page"); msg.classList.add("live"); }
    }).catch(function(){ if (!btn.disabled) down(); });
  }
  poll(); setInterval(poll, 5000);
})();`;

/**
 * The tab rail marks the card being read.
 *
 * The current tab is the last card whose top has passed under the rail. The check runs at most every 60 ms and reads a dozen rectangles, so it costs nothing a scroll would notice.
 */
const TABS_SCRIPT = `(function(){
  var rail = document.querySelector(".tabs"); if (!rail) return;
  var links = [].slice.call(rail.querySelectorAll("a"));
  var cards = links.map(function(a){ return document.getElementById(a.getAttribute("href").slice(1)); });
  var queued = false, cur = null;
  function mark(){
    queued = false;
    var line = rail.getBoundingClientRect().bottom + 40, pick = 0;
    for (var i = 0; i < cards.length; i++) { if (cards[i] && cards[i].getBoundingClientRect().top <= line) pick = i; }
    // At the bottom of the page the last cards can never reach the rail, so the bottom itself counts as reaching the last one.
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) pick = cards.length - 1;
    if (pick === cur) return;
    cur = pick;
    links.forEach(function(a, i){ if (i === pick) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
    var t = links[pick];
    if (t.offsetLeft < rail.scrollLeft || t.offsetLeft + t.offsetWidth > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = t.offsetLeft - 8;
  }
  function soon(){ if (!queued) { queued = true; setTimeout(mark, 60); } }
  addEventListener("scroll", soon, { passive: true });
  addEventListener("resize", soon);
  mark();
})();`;

/**
 * Every coordinate a line of plan prose names, made into a link to that spot.
 *
 * The prose is authored, so the coordinates in it are the player's own words
 * for a place, and a place named in words should be a place the map can show.
 * Two shapes are read, the only two the plans write: `x A to B, y C to D` (each
 * half a point or a range), and `at A, B` or `to A, B` where either half may be
 * a hyphenated range such as `66-134`. The leading word is what keeps a figure
 * pair like "past 0.9, 443 turrets" from reading as a place.
 */
const NUM = String.raw`-?\d+(?:\.\d+)?`;
const COORD = new RegExp(
  String.raw`\bx (${NUM})(?: to (${NUM}))?, y (${NUM})(?: to (${NUM}))?` +
    String.raw`|\b(at|to) (${NUM})(?:-(\d+(?:\.\d+)?))?, (${NUM})(?:-(\d+(?:\.\d+)?))?`,
  "g",
);

export function linkCoords(text: string, layer?: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(COORD)) {
    const lead = m[5] ? `${m[5]} ` : "";
    const [a, b, c, d] = m[5] ? [m[6], m[7], m[8], m[9]] : [m[1], m[2], m[3], m[4]];
    const x0 = Number(a), x1 = b === undefined ? x0 : Number(b);
    const y0 = Number(c), y1 = d === undefined ? y0 : Number(d);
    const shown = m[0].slice(lead.length);
    const fx = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)].map(String).join(" ");
    out +=
      esc(text.slice(last, m.index)) +
      lead +
      `<a class="coord" data-fx="${fx} ${esc(layer ?? "")}" data-fx-label="${esc(shown)}" tabindex="0" role="button" ` +
      `title="Outline ${esc(shown)} on the map">${esc(shown)}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/**
 * The plan, rendered as part of the dashboard rather than beside it.
 *
 * A step is a card that knows where it happens, so `data-fx` sends the one map
 * to the same coordinates and layer a line of advice would, and it knows how
 * far along it is, because its checks are paths into the state file that were
 * read at render time. A step whose checks are all met greys itself out: the
 * plan keeps score without anyone ticking a box.
 */
function barOf(p: StepView["progress"][number]): string {
  if (p.value === null) {
    return (
      `<div class="bar"><span>${esc(p.label)}</span><span class="track"></span>` +
      `<span class="val">not in this save</span></div>`
    );
  }
  // The bar is the level against the target, not the distance travelled from
  // the plan's baseline: a baseline written at tonight's value would draw every
  // bar empty, which says nothing about how close a line already is. The
  // baseline stays visible as a tick, and what moved since it is the bright
  // segment (or a red one when the line fell back).
  const clamp = (n: number): number => Math.max(0, Math.min(100, n));
  const levelOf = (v: number): number =>
    p.down ? (v <= 0 ? 100 : clamp((p.target / v) * 100)) : p.target === 0 ? 100 : clamp((v / p.target) * 100);
  const now = levelOf(p.value);
  const base = p.from === null ? null : levelOf(p.from);
  const lo = base === null ? now : Math.min(base, now);
  const segs =
    `<span class="fill" style="width:${lo.toFixed(1)}%"></span>` +
    (base !== null && now > base
      ? `<span class="gain" style="left:${base.toFixed(1)}%;width:${(now - base).toFixed(1)}%"></span>`
      : "") +
    (base !== null && now < base
      ? `<span class="loss" style="left:${now.toFixed(1)}%;width:${(base - now).toFixed(1)}%"></span>`
      : "") +
    (base !== null && base > 0 && base < 100
      ? `<span class="base" style="left:${base.toFixed(1)}%" title="where this stood when the plan was written: ${esc(String(p.from))}"></span>`
      : "");
  const shown = `${p.value.toFixed(p.value % 1 === 0 ? 0 : 1)} of ${String(p.target)}`;
  // Movement since the previous report, which is the number a player who saved
  // ten minutes ago actually wants: the bar says how far along the whole step
  // is, this says whether tonight moved it. Rounded to the same precision as
  // the value, and absent when nothing moved, because "+0" is noise.
  const moved =
    p.sinceLastReport !== null && Math.abs(p.sinceLastReport) >= 0.05
      ? `<span class="moved ${p.sinceLastReport > 0 ? "up" : "down"}">` +
        `${esc(signed(p.sinceLastReport))} since last save</span>`
      : "";
  return (
    `<div class="bar${p.done ? " done" : ""}"><span>${esc(p.label)}</span>` +
    `<span class="track">${segs}</span>` +
    `<span class="val">${esc(shown)}<span class="pct">${String(Math.round(now))}%</span>${moved}</span></div>`
  );
}

/**
 * How long ago something happened, in minutes of play rather than in ticks.
 *
 * A player reads "eleven minutes ago" and knows whether he did it this session.
 * A tick number is the right thing to store and the wrong thing to show.
 */
function agoOf(ticks: number): string {
  const minutes = Math.round(ticks / 3600);
  if (minutes <= 0) return "just now";
  if (minutes < 60) return `${String(minutes)} min of play ago`;
  return `${(minutes / 60).toFixed(1)} h of play ago`;
}

function stepOf(step: StepView, atTick: number, i: number): string {
  // The earliest tick among the checks that are currently met, so a step whose
  // last check closed tonight reads as closed tonight rather than as closed
  // whenever its first check happened to cross. Null unless every readable
  // check is met, which is the same condition `done` already carries.
  const closed = step.progress.filter((p) => p.closedAtTick !== null).map((p) => p.closedAtTick!);
  const doneSince = step.done && closed.length > 0 ? Math.max(...closed) : null;
  const L = (t: string): string => linkCoords(t, step.where?.layer);
  const fx = step.where
    ? ` data-fx="${step.where.x.toFixed(0)} ${step.where.y.toFixed(0)} ${step.where.w.toFixed(0)} ` +
      `${step.where.h.toFixed(0)} ${esc(step.where.layer ?? "")}" tabindex="0" role="button"` +
      ` data-fx-label="${esc(`${String(i + 1)}. ${step.where.label ?? step.title}`)}" title="Outline this step's area on the map"`
    : "";
  return (
    `<li class="step${step.done ? " done" : ""}${step.started ? " started" : ""}"${fx}>` +
    `<span class="n">${String(i + 1)}</span>` +
    `<h3>${L(step.title)}<button type="button" class="more" data-open>why &amp; how</button></h3>` +
    (doneSince === null
      ? ""
      : `<p class="closed">Done, and it has held since ${esc(agoOf(atTick - doneSince))}.</p>`) +
    `<div class="chips"><span>costs <b>${L(step.cost)}</b></span>` +
    `<span>buys <b>${L(step.buys)}</b></span>` +
    `<span>undo: ${L(step.reversible)}</span>` +
    (step.where?.label ? `<span>at <b>${L(step.where.label)}</b></span>` : "") +
    `</div>` +
    (step.progress.length > 0 ? `<div class="bars">${step.progress.map(barOf).join("")}</div>` : "") +
    `<div class="body"><p class="why">${L(step.why)}</p>` +
    step.detail.map((d) => `<p>${L(d)}</p>`).join("") +
    `</div></li>`
  );
}

/**
 * What is holding the factory back, as one card.
 *
 * The finding leads because it is the sentence Soushi would read out loud, and
 * the two tables under it are the evidence rather than the answer. They are
 * never blended: machine-class utilisation says whether the machines are the
 * constraint, item tightness says which line is, and a factory where every
 * class is idle and one input is short wants the opposite advice from one where
 * a class is at the wall.
 */
function holdingSection(b: BottleneckReport): string {
  if (b.legacy || (b.utilisation.length === 0 && b.tightness.length === 0)) return "";
  const pct = (n: number): string => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

  // The diagnosis, when the two readings agree on a story, is the sentence the
  // card is for, so it leads rather than sitting first in a list. It is absent
  // on a base where they do not agree, and then the card opens on the findings
  // themselves rather than on a sentence nobody measured.
  const first = b.findings[0] ?? null;
  const diagnosis = first?.kind === "diagnosis" ? first : null;
  const findings = b.findings
    .slice(diagnosis ? 1 : 0, diagnosis ? 5 : 4)
    .map(
      (f) =>
        `<p class="find">${esc(f.text)}<span class="because">${esc(f.because)}</span></p>`,
    )
    .join("");

  const classes =
    b.utilisation.length > 0
      ? `<div><p class="tcap">machines, by how much of their time the output accounts for</p>` +
        `<div class="tframe"><table><tr><th>class</th><th class="n">placed</th><th class="n">busy</th><th class="n">of them</th></tr>` +
        b.utilisation
          .slice(0, 8)
          .map(
            (u) =>
              `<tr><td>${cellWithIcon(u.machine)}</td><td class="n">${String(u.count)}</td>` +
              `<td class="n">${u.busyEquivalent.toFixed(1)}</td>` +
              numCell(pct(u.fraction)) + `</tr>`,
          )
          .join("") +
        `</table></div></div>`
      : "";

  const lines =
    b.tightness.length > 0
      ? `<div><p class="tcap">lines, by what is left over</p>` +
        `<div class="tframe"><table><tr><th>item</th><th class="n">made/min</th><th class="n">used/min</th><th class="n">spare/min</th></tr>` +
        b.tightness
          .slice(0, 8)
          .map(
            (t) =>
              `<tr><td>${cellWithIcon(t.name)}</td>` +
              `<td class="n">${t.madePerMinute.toFixed(1)}</td>` +
              `<td class="n">${t.usedPerMinute.toFixed(1)}</td>` +
              `<td class="n ${t.sparePerMinute < 0 ? "down" : "up"}">${esc(signed(t.sparePerMinute))}</td></tr>`,
          )
          .join("") +
        `</table></div></div>`
      : "";

  return (
    `<section class="holding" id="sec-holding"><h2>What is holding you back</h2>` +
    (diagnosis
      ? `<p class="lead">${esc(diagnosis.text)}</p>` +
        `<p class="carry">${esc(diagnosis.because)}</p>`
      : "") +
    findings +
    `<div class="pair">${classes}${lines}</div>` +
    (b.limits.length > 0
      ? `<details class="limits"><summary>How these readings are measured, and what they cannot see (${String(b.limits.length)})</summary>` +
        `<ul>${b.limits.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></details>`
      : "") +
    `</section>`
  );
}

function planSection(plan: PlanView): string {
  // Two ages, never one. The prose is as old as the day it was written and the
  // markers are as old as the last report, and a page that reported a single
  // freshness would be claiming the words are current or that the numbers are
  // stale, and both are wrong.
  const stale =
    plan.ticksBehind > 0
      ? `<p class="stale">Words written ${esc(agoOf(plan.ticksBehind))}. ` +
        (plan.markersBehind === null
          ? `The markers have not been re-derived yet; the bars are from this read.`
          : `Markers re-derived ${esc(agoOf(plan.markersBehind))}, and the bars are from this read.`) +
        `</p>`
      : "";
  return (
    `<section class="plan" id="plan"><h2>${iconOnly("blueprint")}The plan</h2>` +
    `<p class="lead">${linkCoords(plan.lead)}</p>` +
    `<p class="carry">${plan.corrections.map((c) => linkCoords(c)).join("</p><p class=\"carry\">")}</p>` +
    `<ol class="steps">${plan.steps.map((s, i) => stepOf(s, plan.atTick, i)).join("")}</ol>` +
    stale +
    (plan.source ? `<p class="hist"><a href="${esc(plan.source)}">the long form, with every number and its command</a></p>` : "") +
    `</section>`
  );
}

/**
 * A table cell that might be naming something the game has a picture of.
 *
 * Two shapes cover every first column on this page: the name on its own
 * (`iron-plate`, `roboport`), and a name with a place after it (`coal at -256,
 * 1536`). Anything else keeps its text, because a cell reading "Load Iron to
 * Unload Iron" is a stop name Soushi wrote and not a prototype.
 */
function cellWithIcon(cell: string, name?: string | null): string {
  // A row that says what it is about wins over any guess made from its text.
  if (name && ICONS?.url(name)) return withIcon(name, cell);
  if (name) return esc(cell);
  if (ICONS?.url(cell)) return withIcon(cell);
  // Sections print a prototype name as words, because "solar panel" reads
  // better in a table than "solar-panel". The hyphen goes back for the lookup
  // and the words stay on the page.
  const hyphenated = cell.replace(/ /g, "-");
  if (ICONS?.url(hyphenated)) return withIcon(hyphenated, cell);
  // A name with something after it: a place ("coal at -256, 1536") or a count
  // ("iron-ore 4000").
  const lead = /^([a-z0-9-]+)(?: at | )/.exec(cell);
  if (lead && ICONS?.url(lead[1]!)) return withIcon(lead[1]!, cell);
  return esc(cell);
}

/**
 * A numeric cell, with a bar under it when the cell is a share.
 *
 * The bar is drawn from the cell's own text and nothing else: a cell reading `17%` gets a bar 17% long, a cell reading anything else gets none. No number reaches the page that the table did not already print.
 */
function numCell(cell: string): string {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(cell.trim());
  if (!m) return `<td class="n">${esc(cell)}</td>`;
  const v = Math.max(0, Math.min(100, Number(m[1])));
  return `<td class="n">${esc(cell)}<span class="meter${v < 10 ? " low" : ""}"><i style="width:${v.toFixed(1)}%"></i></span></td>`;
}

function tableOf(t: SectionView["tables"][number], src: string): string {
  if (t.rows.length === 0) return "";
  const numeric = new Set(t.numeric);
  return (
    (t.caption ? `<p class="tcap">${esc(t.caption)}</p>` : "") +
    `<div class="tframe"><table data-source="${esc(src)}">` +
    `<tr>${t.headers.map((h, i) => `<th${numeric.has(i) ? ' class="n"' : ""}>${esc(h)}</th>`).join("")}</tr>` +
    t.rows
      .map(
        (row, r) =>
          `<tr>${row
            .map((cell, i) =>
              numeric.has(i)
                ? numCell(cell)
                : `<td>${cellWithIcon(cell, i === 0 ? (t.iconNames?.[r] ?? null) : null)}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("") +
    `</table></div>`
  );
}

/** The game's picture for each part of the base, by the prototype a player would recognise it by. A name the install has no icon for renders as no icon. */
const SECTION_ICON: Record<string, string> = {
  science: "lab",
  energy: "steam-engine",
  defense: "gun-turret",
  production: "assembling-machine-2",
  logistics: "locomotive",
  mining: "electric-mining-drill",
};

function iconOnly(name: string | undefined): string {
  const url = name ? (ICONS?.url(name) ?? null) : null;
  return url ? `<img class="ico" src="${esc(url)}" alt="" decoding="async">` : "";
}

/**
 * The headline of a section: the first figure that carries a verdict, else the first figure.
 *
 * Chosen from the figures the section already shows, never computed here, so the overview and the card can only disagree if the card does with itself.
 */
function headlineOf(v: SectionView): SectionView["figures"][number] | null {
  return v.figures.find((x) => x.tone) ?? v.figures[0] ?? null;
}

/** The section's state as one word for a colour: warn when any figure warns, good when any is good and none warns. */
function toneOf(v: SectionView): "warn" | "good" | "" {
  if (v.figures.some((x) => x.tone === "warn")) return "warn";
  if (v.figures.some((x) => x.tone === "good")) return "good";
  return "";
}

function overviewOf(views: SectionView[], src: string): string {
  const tiles = views
    .map((v) => {
      const h = headlineOf(v);
      const tone = toneOf(v);
      return (
        `<a class="ov${tone ? ` ${tone}` : ""}" href="#sec-${esc(v.id)}" title="${esc(v.lead)}"` +
        (h ? ` data-source="${esc(src)}" data-field="${esc(h.field)}"` : "") +
        `>${iconOnly(SECTION_ICON[v.id])}` +
        `<span class="t">${esc(v.title)}` +
        (v.advice.length > 0 ? `<span class="nadv" title="${String(v.advice.length)} to do">${String(v.advice.length)}</span>` : "") +
        `</span>` +
        (h ? `<span class="x">${esc(h.value)}<small>${esc(h.label)}</small></span>` : `<span class="x"><small>no figures</small></span>`) +
        `</a>`
      );
    })
    .join("");
  return tiles ? `<nav class="overview" aria-label="The base at a glance">${tiles}</nav>` : "";
}

export function renderPage(input: PageInput): string {
  ICONS = input.icons ?? null;
  const { report: r, state, stateFile, history, sections: views } = input;
  const model = input.model ?? null;
  const src = stateFile;
  const f = state.forces["player"];
  const a = r.advisory;

  const milestone = input.milestones
    ? milestoneOverlay(state, src, (n) => ICONS?.url(n) ?? null, input.milestones.earned, input.milestones.firstRead)
    : null;

  const machineTotal = Object.values(f?.machines ?? {}).reduce((n, c) => n + c, 0);
  const researchedCount = f?.technologies.researched.length ?? 0;

  const deltaRow = (name: string, before: number, after: number, places = 1): string => {
    const d = after - before;
    const cls = d > 0 ? "up" : d < 0 ? "down" : "";
    return (
      `<tr data-source="${esc(src)}" data-field="forces.player.production.item.${esc(name)}.producedPerMinute">` +
      `<td>${withIcon(name)}</td><td class="n ${cls}">${esc(signed(d, places))}</td>` +
      `<td class="n">${after.toFixed(places)}</td></tr>`
    );
  };

  const cards: string[] = [];
  // The tab rail lists exactly the cards this page carries, in their order, so a tab can never point at a card that was not drawn.
  const tabs: Array<{ id: string; label: string; tone?: string }> = [];

  // The plan first when there is one. The advice below it is derived and says
  // what is short right now; the plan is written and says what to do about it,
  // in what order, and how far along each step already is. They are different
  // things and the page shows both rather than choosing.
  if (input.plan) {
    cards.push(planSection(input.plan));
    tabs.push({ id: "plan", label: "Plan" });
  }

  // Then what is holding the factory back, because the plan says what to do and
  // this says what is stopping it.
  if (input.bottlenecks) {
    const held = holdingSection(input.bottlenecks);
    if (held) {
      cards.push(held);
      tabs.push({ id: "sec-holding", label: "Holding back", ...(input.bottlenecks.findings.length > 0 ? { tone: "warn" } : {}) });
    }
  }

  // The whole advice list, tagged by section, because the reason to open the
  // page is to be told what to do, not to browse the base.
  if (a && a.advice.length > 0) {
    tabs.push({ id: "sec-todo", label: `To do (${String(a.advice.length)})` });
    cards.push(
      `<section class="wide" id="sec-todo"><h2>What to do<span class="count">${String(a.advice.length)} in order</span></h2>${adviceList(a.advice, true)}</section>`,
    );
  }

  // The base itself, one card per section. Under C33 a section no longer
  // carries a thumbnail: there is one map, and the card points at it. The
  // legend words the thumbnail used to caption stay, because they said what was
  // being looked at and that is still true of the layer.
  const SECTION_LAYER: Record<string, string> = {
    science: "science",
    energy: "power",
    defense: "defence",
    production: "production",
    logistics: "logistics",
    mining: "ore",
  };
  for (const v of views) {
    const layer = SECTION_LAYER[v.id];
    tabs.push({ id: `sec-${v.id}`, label: v.title, tone: toneOf(v) });
    cards.push(
      `<section data-section="${esc(v.id)}" id="sec-${esc(v.id)}"><h2>${iconOnly(SECTION_ICON[v.id])}${esc(v.title)}` +
        (v.advice.length > 0 ? `<span class="count">${String(v.advice.length)} to do</span>` : "") +
        `</h2>` +
        `<p class="lead">${esc(v.lead)}</p>` +
        (v.carry ? `<p class="carry">${esc(v.carry)}</p>` : "") +
        (v.figures.length > 0
          ? `<div class="figs">` +
            v.figures.map((x) => fig(x.value, src, x.field, x.label, x.tone ?? "")).join("") +
            `</div>`
          : "") +
        v.tables.map((t) => tableOf(t, src)).join("") +
        (v.advice.length > 0 ? adviceList(v.advice, false) : "") +
        (layer && model
          ? `<button type="button" class="seemap" data-show="${esc(layer)}">` +
            `Show ${esc(v.title.toLowerCase())} on the map</button>`
          : "") +
        `</section>`,
    );
  }

  // Everything below this line is the diff: what moved since the last report.
  tabs.push({ id: "sec-state", label: "State" });
  cards.push(
    `<section id="sec-state"><h2>State</h2><div class="figs">` +
      fig(String(r.tick), src, "save.tick", "tick") +
      fig(`${r.hoursPlayed.toFixed(1)} h`, src, "save.hoursPlayed", "played") +
      fig(String(researchedCount), src, "forces.player.technologies.researched", "techs done") +
      fig(String(machineTotal), src, "forces.player.machines", "machines") +
      `</div>` +
      (r.queue.length > 1
        ? `<div class="tframe"><table data-source="${esc(src)}" data-field="forces.player.technologies.queue">` +
          `<tr><th>research queue</th></tr>` +
          r.queue.slice(1).map((t) => `<tr><td>${withIcon(t)}</td></tr>`).join("") +
          `</table></div>`
        : "") +
      (r.researched.length > 0
        ? `<p class="tcap">Finished since last report</p><ul class="cols">` +
          r.researched.map((t) => `<li>${esc(t)}</li>`).join("") +
          `</ul>`
        : "") +
      `</section>`,
  );

  // Only when the advisory could not be computed, since the Energy section
  // carries the same figure with the capacity it should be read against.
  if (r.power && !a?.grid) {
    cards.push(
      `<section><h2>Grid, last hour</h2><div class="figs">` +
        fig(
          `${(r.power.produced / 1e6).toFixed(1)} MW`,
          src,
          "forces.player.electric.production",
          r.powerDelta ? `delivered (${signed(r.powerDelta.produced / 1e6)})` : "delivered",
        ) +
        `</div></section>`,
    );
  }

  if (r.machines.length > 0) {
    tabs.push({ id: "sec-changes", label: "Changed" });
    cards.push(
      `<section id="sec-changes"><h2>Machines changed</h2><div class="tframe"><table><tr><th>prototype</th><th class="n">delta</th><th class="n">now</th></tr>` +
        r.machines
          .map((m) => {
            const d = m.after - m.before;
            return (
              `<tr data-source="${esc(src)}" data-field="forces.player.machines.${esc(m.name)}">` +
              `<td>${withIcon(m.name)}</td><td class="n ${d > 0 ? "up" : "down"}">${esc(signed(d, 0))}</td>` +
              `<td class="n">${m.after}</td></tr>`
            );
          })
          .join("") +
        `</table></div></section>`,
    );
  }

  if (r.production.length > 0) {
    tabs.push({ id: "sec-moves", label: "Moves" });
    cards.push(
      `<section id="sec-moves"><h2>${r.legacyRates ? "Consumption" : "Production"}, moves over ${r.threshold}/min</h2>` +
        `<div class="tframe"><table><tr><th>item</th><th class="n">delta/min</th><th class="n">now/min</th></tr>` +
        r.production.map((p) => deltaRow(p.name, p.before, p.after)).join("") +
        `</table></div></section>`,
    );
  }

  if (r.rateBasisChanged) {
    cards.push(
      `<section><h2>Production</h2><p class="quiet">No comparison this time: the previous report measured consumption and this one measures production, so a delta between them would be an artefact. The next report compares like with like.</p></section>`,
    );
  }

  if (r.quiet) {
    cards.push(
      `<section><h2>Since last report</h2><p class="quiet">Nothing crossed a threshold: no research finished, no machine placed or removed, no rate moved by ${r.threshold}/min.</p></section>`,
    );
  }

  if (history.length > 0) {
    tabs.push({ id: "sec-history", label: "History" });
    cards.push(
      `<section id="sec-history"><h2>Earlier reports<span class="count">${String(history.length)}</span></h2><ul class="cols hist">` +
        history.map((h) => `<li><a href="${esc(h)}">${esc(h)}</a></li>`).join("") +
        `</ul></section>`,
    );
  }

  // The charset must be declared: without it the browser guesses, and a file://
  // page guessed latin-1, which turned the middle dot in "production · slowest"
  // into two characters.
  const tabRail =
    `<nav class="tabs" aria-label="Sections">` +
    tabs
      .map((t) => `<a href="#${esc(t.id)}"><span class="dot${t.tone ? ` ${esc(t.tone)}` : ""}"></span>${esc(t.label)}</a>`)
      .join("") +
    `</nav>`;

  // The charset must be declared: without it the browser guesses, and a file:// page guessed latin-1, which turned the middle dot in "production · slowest" into two characters.
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.save)} report</title>
<style>${fontFaces()}${CSS}</style>
<div class="wrap">
<header>
  <h1>${iconOnly("rocket-silo")}${esc(r.save)}</h1>
  <span class="meta"><span class="chip">tick <b>${r.tick}</b>${r.previousTick !== null ? ` (was ${r.previousTick})` : ""}</span><span class="chip"><b>${r.hoursPlayed.toFixed(1)} h</b> played</span><span class="chip">read <b>${esc(readAtLocal(state.save.readAt))}</b></span><span class="chip">Factorio ${esc(state.snapshot.gameVersion)} build ${esc(state.snapshot.build)}</span>${milestone?.chip ?? ""}</span>
  <span class="refresh" data-save="${esc(state.save.name)}" data-tick="${String(r.tick)}"><span class="msg" aria-live="polite"></span><button type="button">Read latest save</button></span>
  ${input.plan ? `<a class="planlink" href="#plan">the plan, step by step &darr;</a>` : ""}
</header>
${overviewOf(views, src)}
${
  model
    ? `<div class="split">${mapPane(model)}<div class="readpane">\n${tabRail}\n${cards.join("\n")}\n</div></div>`
    : `<div class="grid">\n${tabRail}\n${cards.join("\n")}\n</div>`
}
<footer>
Every figure carries <code>data-source</code> and <code>data-field</code> naming the state file and the path inside it that produced it. Rates are the game's own one-hour average. The map is drawn in the save's own tile coordinates, every entity at the position the engine reported and the footprint its prototype declares; water and ore are drawn tile by tile, and no other terrain is, because no other terrain was measured. Nothing here was written to your Factorio directories: the save was copied into this project and read from the copy.
</footer>
</div>
${model ? `<script>${SCRIPT}</script>` : ""}
${milestone?.overlay ?? ""}
<script>${REFRESH_SCRIPT}</script>
<script>${TABS_SCRIPT}</script>
`;
}
