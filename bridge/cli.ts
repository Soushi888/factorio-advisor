import { watch, reportOn, rerenderPage } from "./watch.ts";
import { DEFAULT_RATE_THRESHOLD_PER_MIN } from "./report.ts";
import { newestRead, newestSave } from "../src/state.ts";

/**
 * The bridge's entry point, separate from the advisor's.
 *
 * `src/cli.ts` is the advisor and stays the only entry point for it. This is a
 * second one for the loop, which keeps AD-1's direction honest: the bridge
 * imports the advisor, and nothing in the advisor knows this file exists.
 */

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === undefined || !a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq !== -1) {
    flags.set(a.slice(2, eq), a.slice(eq + 1));
    continue;
  }
  // Both spellings, because the advisor accepts both and a person types
  // whichever they typed last. `bun run report --save "game 4"` threw on a
  // spelling that works for `bun run state --save "game 4"`, which is the one
  // CLAUDE.md documents; two entry points disagreeing about their own flags is
  // a papercut that costs a minute every time and looks like a broken command.
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    flags.set(a.slice(2), next);
    i++;
  } else {
    flags.set(a.slice(2), "true");
  }
}

function value(name: string): string | null {
  const v = flags.get(name);
  if (v === undefined) return null;
  if (v === "true") {
    throw new Error(`--${name} needs a value, written with an equals sign: --${name}=<value>`);
  }
  return v;
}

const thresholdFlag = value("threshold");
const threshold = thresholdFlag === null ? DEFAULT_RATE_THRESHOLD_PER_MIN : Number(thresholdFlag);
if (!Number.isFinite(threshold) || threshold < 0) {
  throw new Error(`--threshold must be a number of items per minute.`);
}

/**
 * When a read was taken, in Soushi's own clock rather than in ticks.
 *
 * "read at 21:35 tonight" against "read on 09-05 at 22:21" is the difference
 * between a current page and a sixteen-day-old one, and it has to be in the
 * output rather than available on request: the failure this exists for printed
 * a defensible choice and said nothing that would have made it look wrong.
 */
function readAgo(at: Date): string {
  const now = new Date();
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return `read at ${hm} today`;
  const md = `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return `read on ${md} at ${hm}`;
}

// `--page` redraws the dashboard from the state file already on disk. It runs
// no engine and writes no report, so it is the loop for working on the page
// itself rather than on the base.
if (flags.has("page")) {
  const named = value("save");
  // Ordered by the READ, never by the save. This command runs no engine, so it
  // renders the newest state file this project holds; ordering by the zip's
  // mtime let a rotated autosave carrying a sixteen-day-old read win over
  // tonight's read of the base he is playing (pm#110).
  const chosen = named === null ? newestRead() : null;
  const save = named ?? chosen?.name;
  if (!save) {
    throw new Error(
      newestSave() === null
        ? "No save found. Name one with --save=<name>."
        : "No save has been read yet. Run: bun run report --now",
    );
  }
  const page = rerenderPage(save, { threshold });
  if (!page) {
    throw new Error(`No state file read yet for ${save}. Run: bun run report --save="${save}"`);
  }
  // The age of the read, always, because that is the fact a stale page hides.
  // Which save it is does not say whether the page is current; when it was read
  // does.
  if (chosen) {
    const newer = chosen.newerSave === null ? "" : `, and ${chosen.newerSave} is newer on disk but unread`;
    console.log(`\n  save  ${chosen.name}  (${readAgo(chosen.readAt)}, tick ${String(chosen.tick)}${newer})`);
  } else {
    console.log(`\n  save  ${save}`);
  }
  console.log(`  page  ${page}  (redrawn from the last read, no engine run)`);
  process.exit(0);
}

// `--now` writes one report for the newest save and exits, which is what a first
// run wants and what makes the loop testable without waiting for a save.
if (flags.has("now")) {
  const named = value("save");
  const save = named ?? newestSave()?.name;
  if (!save) throw new Error("No save found. Name one with --save=<name>.");
  const written = await reportOn(save, { threshold, quiet: false });
  if (!written) {
    console.log(`\n${save} has not moved since its last report: same tick, nothing new to say.`);
  } else {
    console.log(`\n  report  ${written.markdown}`);
    console.log(`  state   ${written.json}`);
    console.log(`  page    ${written.page}`);
    if (written.firstForSave) console.log(`\n  First report for this save, so it describes rather than differs.`);
    else if (written.quiet) console.log(`\n  Nothing crossed a threshold, and the report says so rather than restating the base.`);
  }
} else {
  await watch({ threshold });
}
