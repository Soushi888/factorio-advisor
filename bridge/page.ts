import type { ReportData } from "./report.ts";
import type { GameState } from "../src/state.ts";
import type { SectionView } from "../src/sections.ts";
import type { Advice } from "../src/advise.ts";
import type { MapModel, MapLayer } from "../src/layers.ts";

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
:root{--bg:#f6f5f2;--fg:#1b1a18;--dim:#6b6862;--line:#ddd9d2;--card:#fff;--up:#1f7a3d;--down:#a3341f;--accent:#b3541e}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161513;--fg:#eceae5;--dim:#959087;--line:#2e2b27;--card:#1f1d1a;--up:#5fbf80;--down:#e0745a;--accent:#e08a3c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:104rem;margin:0 auto;padding:1.25rem 1.5rem 3rem}
header{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:.6rem;margin-bottom:1.1rem}
h1{font-size:1.05rem;margin:0;font-weight:650;letter-spacing:-.01em}
.meta{color:var(--dim);font-size:.8rem;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(32rem,1fr));gap:1rem;align-items:start}
/* Defensive, not a fix for anything observed. A grid item defaults to
   min-width:auto, so a long enough unbreakable token would widen its track past
   its minimum and overflow the page, which the dashboard rule forbids. N6 reported
   exactly that symptom and it did not reproduce: scrollWidth equals clientWidth
   at every width tested, with and without these rules, on a probe certified to
   fire. The card the report called clipped fits exactly inside the content edge;
   what was cropped was the screenshot, which is narrower than the page. */
section{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:.85rem .95rem;min-width:0}
section>*{min-width:0}
h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 .6rem;font-weight:600}
.lead{font-size:.88rem;margin:0 0 .7rem;font-weight:500}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.55rem}
.fig{display:flex;flex-direction:column;gap:.1rem}
.fig .v{font-size:1.15rem;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em;overflow-wrap:anywhere}
.fig .l{font-size:.7rem;color:var(--dim)}
.fig.warn .v{color:var(--down)}
.fig.good .v{color:var(--up)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;table-layout:fixed;margin-top:.6rem}
td,th{text-align:left;padding:.2rem .4rem .2rem 0;border-bottom:1px solid var(--line);font-size:.82rem;overflow-wrap:anywhere}
th{color:var(--dim);font-weight:500;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
td.n{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
.up{color:var(--up)}.down{color:var(--down)}
.cols{columns:17.5rem;column-gap:1.25rem}
.cols li{break-inside:avoid}
ul{margin:0;padding-left:1.1rem}
li{font-size:.82rem;margin:.1rem 0;overflow-wrap:anywhere}
.quiet{color:var(--dim);font-style:italic;font-size:.85rem}
.hist{font-size:.78rem;color:var(--dim)}
.hist a{color:var(--accent);text-decoration:none}
.hist a:hover{text-decoration:underline}
.wide{grid-column:1/-1}
.advice{list-style:none;padding:0;margin:.7rem 0 0;counter-reset:a}
.advice li{margin:0 0 .55rem;padding-left:1.5rem;position:relative;font-size:.85rem}
.advice li::before{counter-increment:a;content:counter(a);position:absolute;left:0;top:.05rem;width:1.05rem;height:1.05rem;border-radius:50%;background:var(--accent);color:var(--card);font-size:.62rem;font-weight:700;display:flex;align-items:center;justify-content:center}
.advice b{font-weight:620}
.advice .why{display:block;color:var(--dim);font-size:.78rem;margin-top:.1rem}
.advice .tag{display:inline-block;white-space:nowrap;font-size:.6rem;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);border:1px solid var(--line);border-radius:.6rem;padding:0 .35rem;margin-left:.35rem;vertical-align:.08em}
/* The map is drawn in the save's own tile coordinates and scaled by the
   browser, so it needs a box to fit into and a colour for the chunk squares to
   inherit through the CSS currentColor keyword. */
.mapbox{margin-top:.7rem;background:color-mix(in srgb,var(--fg) 4%,transparent);border-radius:.35rem;padding:.35rem;color:var(--fg)}
svg.map{display:block;max-height:34rem;width:100%}
.legend{font-size:.7rem;color:var(--dim);margin-top:.3rem;display:flex;flex-wrap:wrap;gap:.1rem .7rem}
footer{margin-top:1.25rem;color:var(--dim);font-size:.72rem;border-top:1px solid var(--line);padding-top:.6rem}

/* C33: two panes. The map holds the left and stays put while the text scrolls
   beside it, because a map that scrolls away from the sentence referring to it
   is a picture rather than an instrument. Below 70rem they stack and the map
   takes a fixed height, since sticky against a short viewport hides the text. */
.split{display:grid;grid-template-columns:minmax(28rem,42fr) minmax(24rem,58fr);gap:1.25rem;align-items:start}
.mappane{position:sticky;top:1rem;height:calc(100vh - 2rem);display:flex;flex-direction:column;
  background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:.7rem .8rem;min-width:0}
.mappane h2{margin-bottom:.4rem}
.readpane{display:grid;grid-template-columns:repeat(auto-fit,minmax(24rem,1fr));gap:1rem;align-items:start;min-width:0}
#mapbox{flex:1;min-height:0;position:relative;background:color-mix(in srgb,var(--fg) 4%,transparent);
  border-radius:.35rem;color:var(--fg);overflow:hidden;touch-action:none}
#map{display:block;width:100%;height:100%;cursor:grab}
#map.dragging{cursor:grabbing}
#map .area rect{fill-opacity:.1;stroke-width:2;vector-effect:non-scaling-stroke;stroke-dasharray:6 4}
#map .area.warn rect{fill:var(--down);stroke:var(--down)}
#map .area.good rect{fill:var(--up);stroke:var(--up)}
#map .area.info rect{fill:var(--dim);stroke:var(--dim)}
#map g[data-layer]{pointer-events:none}
#map g[data-layer].on{pointer-events:auto}
#map g[data-layer]:not(.on){display:none}
#map .flash rect{stroke-width:4;fill-opacity:.28}
.maptools{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;margin-bottom:.45rem}
.maptools button{font:inherit;font-size:.72rem;padding:.12rem .5rem;border:1px solid var(--line);
  border-radius:.3rem;background:var(--card);color:var(--fg);cursor:pointer}
.maptools button:hover,.maptools button:focus-visible{border-color:var(--accent);color:var(--accent)}
.maptools .hint{color:var(--dim);font-size:.68rem;margin-left:auto}
#scalebar{display:flex;align-items:center;gap:.4rem;margin-top:.4rem;color:var(--dim);font-size:.68rem;
  font-variant-numeric:tabular-nums}
#scalebar .bar{height:.5rem;border:1px solid currentColor;border-top:0}
.layers{list-style:none;margin:.5rem 0 0;padding:0;display:grid;
  grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.15rem .6rem;max-height:11rem;overflow:auto}
.layers li{margin:0}
.layers button{display:flex;align-items:baseline;gap:.35rem;width:100%;text-align:left;font:inherit;
  font-size:.72rem;background:none;border:0;padding:.12rem .2rem;border-radius:.25rem;color:var(--dim);cursor:pointer}
.layers button:hover,.layers button:focus-visible{background:color-mix(in srgb,var(--fg) 7%,transparent)}
.layers button[aria-pressed=true]{color:var(--fg)}
.layers .key{width:.7rem;height:.7rem;flex:0 0 auto;align-self:center;opacity:.35}
.layers button[aria-pressed=true] .key{opacity:1}
.layers .key.dot{border-radius:50%}
.layers .key.ring{border-radius:50%;background:none!important;border:2px solid currentColor}
.layers .key.diamond{transform:rotate(45deg)}
.layers .key.box{border-radius:.1rem;background:none!important;border:1px dashed currentColor}
.layers .n{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.8}
.layers .digit{opacity:.45;font-size:.62rem;width:.8rem}
.layers .miss{display:block;font-size:.62rem;color:var(--down);padding:0 0 .1rem 1.9rem}
.advice li[data-fx]{cursor:pointer;border-radius:.3rem}
.advice li[data-fx]:hover,.advice li[data-fx]:focus-visible{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.advice li[data-fx] b::after{content:" ⌖";color:var(--accent);font-weight:400}
.seemap{font:inherit;font-size:.7rem;margin-top:.5rem;padding:.12rem .5rem;border:1px solid var(--line);
  border-radius:.3rem;background:none;color:var(--dim);cursor:pointer}
.seemap:hover,.seemap:focus-visible{border-color:var(--accent);color:var(--accent)}
@media (max-width:70rem){
  .wrap{padding:1rem}
  .split{grid-template-columns:1fr}
  .mappane{position:static;height:auto}
  /* flex:none or the pane's own flex:1 wins and the map fills the whole
     viewport on a phone, pushing every word of the reading below the fold. */
  #mapbox{height:60vh;flex:none}
}
@media (prefers-reduced-motion:reduce){#map{transition:none!important}}
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

  function apply() {
    svg.setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
    drawGrid();
    drawScale();
  }

  // Chunk lines, generated for the visible range only, and only once a chunk is
  // wide enough on screen to be read. They are the same 32 tiles the collector
  // buckets in, never a decorative grid at a made-up spacing.
  function drawGrid() {
    var d = drawn();
    if (d.s * chunk < 26) { grid.innerHTML = ""; return; }
    var x0 = Math.floor(vb.x / chunk) * chunk, x1 = vb.x + vb.w;
    var y0 = Math.floor(vb.y / chunk) * chunk, y1 = vb.y + vb.h;
    var out = [];
    for (var x = x0; x <= x1; x += chunk) out.push("M" + x + " " + vb.y + "V" + y1);
    for (var y = y0; y <= y1; y += chunk) out.push("M" + vb.x + " " + y + "H" + x1);
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
    var w = Math.max(chunk, Math.min(fit[2] * 4, vb.w * factor));
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

  box.addEventListener("wheel", function (e) {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.18 : 1 / 1.18);
  }, { passive: false });

  var drag = null;
  svg.addEventListener("pointerdown", function (e) {
    drag = { x: e.clientX, y: e.clientY };
    svg.classList.add("dragging");
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var d = drawn();
    vb.x -= (e.clientX - drag.x) / d.s;
    vb.y -= (e.clientY - drag.y) / d.s;
    drag.x = e.clientX; drag.y = e.clientY;
    apply();
  });
  function endDrag() { drag = null; svg.classList.remove("dragging"); }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("dblclick", function (e) { zoomAt(e.clientX, e.clientY, 1 / 1.6); });

  function doFit() { vb = { x: fit[0], y: fit[1], w: fit[2], h: fit[3] }; apply(); }
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
    b.setAttribute("aria-pressed", next ? "true" : "false");
  }
  toggles.forEach(function (b) {
    b.addEventListener("click", function () { setLayer(b.getAttribute("data-toggle")); });
  });

  // Move the map to a place a line of text named, and turn on the layer that
  // explains it. Padded so the target sits inside the view rather than against
  // its edge, and floored at a few chunks so a small target is not zoomed into
  // a void.
  var flashed = null;
  function focusOn(x, y, w, h, layer) {
    if (layer) setLayer(layer, true);
    var pad = Math.max(w, h) * 0.8 + chunk * 2;
    var target = {
      x: x - pad, y: y - pad,
      w: Math.max(w + pad * 2, chunk * 4),
      h: Math.max(h + pad * 2, chunk * 4),
    };
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
    function go() {
      var p = fx.split(" ");
      focusOn(Number(p[0]), Number(p[1]), Number(p[2]), Number(p[3]), p[4]);
      if (flashed) flashed.classList.remove("flash");
      el.classList.add("flash"); flashed = el;
    }
    el.addEventListener("click", go);
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  }
  [].slice.call(document.querySelectorAll("[data-fx]")).forEach(hookFocus);

  // A section has no single place, so its control turns on the layer that
  // explains it and fits the whole base. Panning a section somewhere would be
  // inventing a location the section never named.
  [].slice.call(document.querySelectorAll("[data-show]")).forEach(function (b) {
    b.addEventListener("click", function () {
      setLayer(b.getAttribute("data-show"), true);
      doFit();
      box.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "f") { doFit(); return; }
    if (e.key === "Escape") {
      doFit();
      if (flashed) { flashed.classList.remove("flash"); flashed = null; }
      return;
    }
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= toggles.length) setLayer(toggles[n - 1].getAttribute("data-toggle"));
  });

  new ResizeObserver(function () { drawGrid(); drawScale(); }).observe(box);
  apply();
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
  /** The one map's layers, or null when the state file carries no map. */
  model?: MapModel | null;
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
          (full ? `<span class="tag">${esc(item.section)}</span>` : "") +
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
  const style = l.mark === "ring" || l.mark === "box" ? `color:${l.colour}` : `background:${l.colour}`;
  return `<span class="key ${l.mark}" style="${style}"></span>`;
}

function mapPane(model: MapModel): string {
  const { viewBox: v } = model;
  const groups = model.layers
    .map(
      (l) =>
        `<g data-layer="${esc(l.id)}" class="${l.on ? "on" : ""}" ` +
        `fill="${esc(l.colour)}" color="${esc(l.colour)}">${l.body}</g>`,
    )
    .join("");

  const legend = model.layers
    .map((l, i) => {
      const n = l.drawn === l.census ? String(l.drawn) : `${String(l.drawn)} of ${String(l.census)}`;
      return (
        `<li><button type="button" data-toggle="${esc(l.id)}" aria-pressed="${l.on ? "true" : "false"}">` +
        `<span class="digit">${i < 9 ? String(i + 1) : ""}</span>${layerKey(l)}` +
        `<span>${esc(l.label)}</span><span class="n">${esc(n)}</span></button>` +
        (l.note ? `<span class="miss">${esc(l.note)}</span>` : "") +
        `</li>`
      );
    })
    .join("");

  return (
    `<aside class="mappane"><h2>${esc(model.surface)}</h2>` +
    `<div class="maptools">` +
    `<button type="button" id="fit">Fit</button>` +
    `<button type="button" id="zin">+</button>` +
    `<button type="button" id="zout">&minus;</button>` +
    `<span class="hint">wheel zooms at the cursor &middot; drag pans &middot; digits toggle layers &middot; f fits</span>` +
    `</div>` +
    `<div id="mapbox"><svg id="map" role="img" aria-label="Base map of ${esc(model.surface)}" ` +
    `viewBox="${v.x.toFixed(0)} ${v.y.toFixed(0)} ${v.w.toFixed(0)} ${v.h.toFixed(0)}" ` +
    `data-fit="${v.x.toFixed(0)} ${v.y.toFixed(0)} ${v.w.toFixed(0)} ${v.h.toFixed(0)}" ` +
    `data-chunk="${String(model.cellTiles)}" preserveAspectRatio="xMidYMid meet">` +
    `<g id="grid" stroke="currentColor" stroke-width="0.5" opacity="0.14"></g>` +
    groups +
    `</svg></div>` +
    `<div id="scalebar"><span class="bar"></span><span class="txt"></span></div>` +
    `<ul class="layers">${legend}</ul>` +
    `</aside>`
  );
}

function tableOf(t: NonNullable<SectionView["table"]>, src: string): string {
  if (t.rows.length === 0) return "";
  const numeric = new Set(t.numeric);
  return (
    `<table data-source="${esc(src)}">` +
    `<tr>${t.headers.map((h, i) => `<th${numeric.has(i) ? ' class="n"' : ""}>${esc(h)}</th>`).join("")}</tr>` +
    t.rows
      .map(
        (row) =>
          `<tr>${row.map((cell, i) => `<td${numeric.has(i) ? ' class="n"' : ""}>${esc(cell)}</td>`).join("")}</tr>`,
      )
      .join("") +
    `</table>`
  );
}

export function renderPage(input: PageInput): string {
  const { report: r, state, stateFile, history, sections: views } = input;
  const model = input.model ?? null;
  const src = stateFile;
  const f = state.forces["player"];
  const a = r.advisory;

  const machineTotal = Object.values(f?.machines ?? {}).reduce((n, c) => n + c, 0);
  const researchedCount = f?.technologies.researched.length ?? 0;

  const deltaRow = (name: string, before: number, after: number, places = 1): string => {
    const d = after - before;
    const cls = d > 0 ? "up" : d < 0 ? "down" : "";
    return (
      `<tr data-source="${esc(src)}" data-field="forces.player.production.item.${esc(name)}.producedPerMinute">` +
      `<td>${esc(name)}</td><td class="n ${cls}">${esc(signed(d, places))}</td>` +
      `<td class="n">${after.toFixed(places)}</td></tr>`
    );
  };

  const cards: string[] = [];

  // The whole advice list first, tagged by section, because the reason to open
  // the page is to be told what to do, not to browse the base.
  if (a && a.advice.length > 0) {
    cards.push(`<section class="wide"><h2>What to do</h2>${adviceList(a.advice, true)}</section>`);
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
    cards.push(
      `<section data-section="${esc(v.id)}"><h2>${esc(v.title)}</h2>` +
        `<p class="lead">${esc(v.lead)}</p>` +
        (v.figures.length > 0
          ? `<div class="figs">` +
            v.figures.map((x) => fig(x.value, src, x.field, x.label, x.tone ?? "")).join("") +
            `</div>`
          : "") +
        (v.table ? tableOf(v.table, src) : "") +
        (v.advice.length > 0 ? adviceList(v.advice, false) : "") +
        (layer && model
          ? `<button type="button" class="seemap" data-show="${esc(layer)}">` +
            `Show ${esc(v.title.toLowerCase())} on the map</button>`
          : "") +
        (v.legend.length > 0
          ? `<div class="legend">${v.legend.map((l) => `<span>${esc(l)}</span>`).join("")}</div>`
          : "") +
        `</section>`,
    );
  }

  // Everything below this line is the diff: what moved since the last report.
  cards.push(
    `<section><h2>State</h2><div class="figs">` +
      fig(String(r.tick), src, "save.tick", "tick") +
      fig(`${r.hoursPlayed.toFixed(1)} h`, src, "save.hoursPlayed", "played") +
      fig(String(researchedCount), src, "forces.player.technologies.researched", "techs done") +
      fig(String(machineTotal), src, "forces.player.machines", "machines") +
      `</div>` +
      (r.queue.length > 1
        ? `<table data-source="${esc(src)}" data-field="forces.player.technologies.queue">` +
          `<tr><th>research queue</th></tr>` +
          r.queue.slice(1).map((t) => `<tr><td>${esc(t)}</td></tr>`).join("") +
          `</table>`
        : "") +
      (r.researched.length > 0
        ? `<h2 style="margin-top:.7rem">Finished since last report</h2><ul class="cols">` +
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
    cards.push(
      `<section><h2>Machines changed</h2><table><tr><th>prototype</th><th class="n">delta</th><th class="n">now</th></tr>` +
        r.machines
          .map((m) => {
            const d = m.after - m.before;
            return (
              `<tr data-source="${esc(src)}" data-field="forces.player.machines.${esc(m.name)}">` +
              `<td>${esc(m.name)}</td><td class="n ${d > 0 ? "up" : "down"}">${esc(signed(d, 0))}</td>` +
              `<td class="n">${m.after}</td></tr>`
            );
          })
          .join("") +
        `</table></section>`,
    );
  }

  if (r.production.length > 0) {
    cards.push(
      `<section><h2>${r.legacyRates ? "Consumption" : "Production"}, moves over ${r.threshold}/min</h2>` +
        `<table><tr><th>item</th><th class="n">delta/min</th><th class="n">now/min</th></tr>` +
        r.production.map((p) => deltaRow(p.name, p.before, p.after)).join("") +
        `</table></section>`,
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
    cards.push(
      `<section><h2>Earlier reports</h2><ul class="cols hist">` +
        history.map((h) => `<li><a href="${esc(h)}">${esc(h)}</a></li>`).join("") +
        `</ul></section>`,
    );
  }

  // The charset must be declared: without it the browser guesses, and a file://
  // page guessed latin-1, which turned the middle dot in "production · slowest"
  // into two characters.
  return `<meta charset="utf-8">
<title>${esc(r.save)} report</title>
<style>${CSS}</style>
<div class="wrap">
<header>
  <h1>${esc(r.save)}</h1>
  <span class="meta">tick ${r.tick}${r.previousTick !== null ? ` (was ${r.previousTick})` : ""} &middot; ${r.hoursPlayed.toFixed(1)} h played &middot; read ${esc(state.save.readAt.slice(0, 16).replace("T", " "))}</span>
  <span class="meta">Factorio ${esc(state.snapshot.gameVersion)} build ${esc(state.snapshot.build)}</span>
</header>
${
  model
    ? `<div class="split">${mapPane(model)}<div class="readpane">\n${cards.join("\n")}\n</div></div>`
    : `<div class="grid">\n${cards.join("\n")}\n</div>`
}
<footer>
Every figure carries <code>data-source</code> and <code>data-field</code> naming the state file and the path inside it that produced it. Rates are the game's own one-hour average. The maps are drawn in the save's own tile coordinates from the entities and resources the collector counted chunk by chunk; there is no terrain on them, because terrain was never measured. Nothing here was written to your Factorio directories: the save was copied into this project and read from the copy.
</footer>
</div>
${model ? `<script>${SCRIPT}</script>` : ""}
`;
}
