import type { ReportData } from "./report.ts";
import type { GameState } from "../src/state.ts";

/**
 * The dashboard.
 *
 * A dashboard is a dense horizontal grid a glance can scan, not a tall page that
 * has to be scrolled to be understood: 104rem wide, `auto-fit` columns, no
 * reading measure. Vertical space is the scarce resource, so the state is above
 * the fold and the header is one line.
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

function fig(value: string, source: string, field: string, label: string): string {
  return (
    `<div class="fig" data-source="${esc(source)}" data-field="${esc(field)}">` +
    `<span class="v">${esc(value)}</span><span class="l">${esc(label)}</span></div>`
  );
}

function signed(v: number, places = 1): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(places)}`;
}

const CSS = `
:root{--bg:#f6f5f2;--fg:#1b1a18;--dim:#6b6862;--line:#ddd9d2;--card:#fff;--up:#1f7a3d;--down:#a3341f;--accent:#b3541e}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#16151300;--bg:#161513;--fg:#eceae5;--dim:#959087;--line:#2e2b27;--card:#1f1d1a;--up:#5fbf80;--down:#e0745a;--accent:#e08a3c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
html,body{overflow-x:hidden}
.wrap{max-width:104rem;margin:0 auto;padding:1.25rem 1.5rem 3rem}
header{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:.6rem;margin-bottom:1.1rem}
h1{font-size:1.05rem;margin:0;font-weight:650;letter-spacing:-.01em}
.meta{color:var(--dim);font-size:.8rem;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(22rem,1fr));gap:1rem;align-items:start}
/* min-width:0 is the whole fix for N6. A grid item defaults to min-width:auto,
   so one long technology name in the Research card widened its track past 22rem,
   pushed the grid past the 104rem wrap and overflowed the page horizontally,
   which the dashboard rule forbids. The wrap rules below stop any single long
   token doing it again through a different card. */
section{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:.85rem .95rem;min-width:0}
section>*{min-width:0}
h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 .6rem;font-weight:600}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.55rem}
.fig{display:flex;flex-direction:column;gap:.1rem}
.fig .v{font-size:1.15rem;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em;overflow-wrap:anywhere}
.fig .l{font-size:.7rem;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;table-layout:fixed}
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
footer{margin-top:1.25rem;color:var(--dim);font-size:.72rem;border-top:1px solid var(--line);padding-top:.6rem}
@media (max-width:70rem){.wrap{padding:1rem}}
`;

export interface PageInput {
  report: ReportData;
  state: GameState;
  stateFile: string;
  /** Earlier reports, newest first, as file names. */
  history: string[];
}

export function renderPage(input: PageInput): string {
  const { report: r, state, stateFile, history } = input;
  const src = stateFile;
  const f = state.forces["player"];

  const machineTotal = Object.values(f?.machines ?? {}).reduce((n, c) => n + c, 0);
  const researchedCount = f?.technologies.researched.length ?? 0;

  const deltaRow = (name: string, before: number, after: number, places = 1): string => {
    const d = after - before;
    const cls = d > 0 ? "up" : d < 0 ? "down" : "";
    return (
      `<tr data-source="${esc(src)}" data-field="forces.player.production.item.${esc(name)}.perMinute">` +
      `<td>${esc(name)}</td><td class="n ${cls}">${esc(signed(d, places))}</td>` +
      `<td class="n">${after.toFixed(places)}</td></tr>`
    );
  };

  const sections: string[] = [];

  sections.push(
    `<section><h2>State</h2><div class="figs">` +
      fig(String(r.tick), src, "save.tick", "tick") +
      fig(`${r.hoursPlayed.toFixed(1)} h`, src, "save.hoursPlayed", "played") +
      fig(String(researchedCount), src, "forces.player.technologies.researched", "techs done") +
      fig(String(machineTotal), src, "forces.player.machines", "machines") +
      (r.evolution !== null
        ? fig(`${(r.evolution * 100).toFixed(1)}%`, src, "save.surfaceState[0].evolution", "evolution")
        : "") +
      (r.pollution !== null
        ? fig(r.pollution.toFixed(0), src, "save.surfaceState[0].pollution", "pollution")
        : "") +
      `</div></section>`,
  );

  if (r.power) {
    sections.push(
      `<section><h2>Grid, last hour</h2><div class="figs">` +
        fig(
          `${(r.power.produced / 1e6).toFixed(1)} MW`,
          src,
          "forces.player.electric.production",
          r.powerDelta ? `delivered (${signed(r.powerDelta.produced / 1e6)})` : "delivered",
        ) +
        fig(
          `${(r.power.consumed / 1e6).toFixed(1)} MW`,
          src,
          "forces.player.electric.consumption",
          r.powerDelta ? `drawn (${signed(r.powerDelta.consumed / 1e6)})` : "drawn",
        ) +
        `</div></section>`,
    );
  }

  sections.push(
    `<section><h2>Research</h2>` +
      `<div class="figs">` +
      fig(
        r.currentResearch ?? "idle",
        src,
        "forces.player.technologies.current",
        r.researchProgress !== null ? `${(r.researchProgress * 100).toFixed(1)}% done` : "current",
      ) +
      `</div>` +
      (r.queue.length > 1
        ? `<ul data-source="${esc(src)}" data-field="forces.player.technologies.queue">` +
          r.queue.slice(1).map((t) => `<li>${esc(t)}</li>`).join("") +
          `</ul>`
        : "") +
      (r.researched.length > 0
        ? `<h2 style="margin-top:.7rem">Finished since last report</h2><ul class="cols">` +
          r.researched.map((t) => `<li>${esc(t)}</li>`).join("") +
          `</ul>`
        : "") +
      `</section>`,
  );

  if (r.machines.length > 0) {
    sections.push(
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
    sections.push(
      `<section><h2>Production, moves over ${r.threshold}/min</h2>` +
        `<table><tr><th>item</th><th class="n">delta/min</th><th class="n">now/min</th></tr>` +
        r.production.map((p) => deltaRow(p.name, p.before, p.after)).join("") +
        `</table></section>`,
    );
  }

  if (r.quiet) {
    sections.push(
      `<section><h2>Since last report</h2><p class="quiet">Nothing crossed a threshold: no research finished, no machine placed or removed, no rate moved by ${r.threshold}/min.</p></section>`,
    );
  }

  if (history.length > 0) {
    sections.push(
      `<section><h2>Earlier reports</h2><ul class="cols hist">` +
        history.map((h) => `<li><a href="${esc(h)}">${esc(h)}</a></li>`).join("") +
        `</ul></section>`,
    );
  }

  return `<title>${esc(r.save)} report</title>
<style>${CSS}</style>
<div class="wrap">
<header>
  <h1>${esc(r.save)}</h1>
  <span class="meta">tick ${r.tick}${r.previousTick !== null ? ` (was ${r.previousTick})` : ""} &middot; ${r.hoursPlayed.toFixed(1)} h played &middot; read ${esc(state.save.readAt.slice(0, 16).replace("T", " "))}</span>
  <span class="meta">Factorio ${esc(state.snapshot.gameVersion)} build ${esc(state.snapshot.build)}</span>
</header>
<div class="grid">
${sections.join("\n")}
</div>
<footer>
Every figure carries <code>data-source</code> and <code>data-field</code> naming the state file and the path inside it that produced it. Rates are the game's own one-hour average. Nothing here was written to your Factorio directories: the save was copied into this project and read from the copy.
</footer>
</div>
`;
}
