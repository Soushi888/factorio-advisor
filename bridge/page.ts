import type { ReportData } from "./report.ts";
import type { GameState } from "../src/state.ts";
import type { SectionView } from "../src/sections.ts";
import type { Advice } from "../src/advise.ts";

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
@media (max-width:70rem){.wrap{padding:1rem}}
`;

export interface PageInput {
  report: ReportData;
  state: GameState;
  stateFile: string;
  /** The derived sections, empty when the snapshot could not answer. */
  sections: SectionView[];
  /** Earlier reports, newest first, as file names. */
  history: string[];
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
      .map(
        (item) =>
          `<li><b>${esc(item.text)}</b>` +
          (full ? `<span class="tag">${esc(item.section)}</span>` : "") +
          (full ? `<span class="why">${esc(item.because)}</span>` : "") +
          `</li>`,
      )
      .join("") +
    `</ol>`
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

  // The base itself, one card per section, each with its own map.
  for (const v of views) {
    cards.push(
      `<section data-section="${esc(v.id)}"><h2>${esc(v.title)}</h2>` +
        `<p class="lead">${esc(v.lead)}</p>` +
        (v.figures.length > 0
          ? `<div class="figs">` +
            v.figures.map((x) => fig(x.value, src, x.field, x.label, x.tone ?? "")).join("") +
            `</div>`
          : "") +
        (v.map
          ? `<div class="mapbox">${v.map}</div>` +
            (v.legend.length > 0
              ? `<div class="legend">${v.legend.map((l) => `<span>${esc(l)}</span>`).join("")}</div>`
              : "")
          : "") +
        (v.table ? tableOf(v.table, src) : "") +
        (v.advice.length > 0 ? adviceList(v.advice, false) : "") +
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
<div class="grid">
${cards.join("\n")}
</div>
<footer>
Every figure carries <code>data-source</code> and <code>data-field</code> naming the state file and the path inside it that produced it. Rates are the game's own one-hour average. The maps are drawn in the save's own tile coordinates from the entities and resources the collector counted chunk by chunk; there is no terrain on them, because terrain was never measured. Nothing here was written to your Factorio directories: the save was copied into this project and read from the copy.
</footer>
</div>
`;
}
