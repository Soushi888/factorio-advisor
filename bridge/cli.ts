import { watch, reportOn, rerenderPage } from "./watch.ts";
import { DEFAULT_RATE_THRESHOLD_PER_MIN } from "./report.ts";
import { newestSave } from "../src/state.ts";

/**
 * The bridge's entry point, separate from the advisor's.
 *
 * `src/cli.ts` is the advisor and stays the only entry point for it. This is a
 * second one for the loop, which keeps AD-1's direction honest: the bridge
 * imports the advisor, and nothing in the advisor knows this file exists.
 */

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (const a of argv) {
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq === -1) flags.set(a.slice(2), "true");
  else flags.set(a.slice(2, eq), a.slice(eq + 1));
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

// `--page` redraws the dashboard from the state file already on disk. It runs
// no engine and writes no report, so it is the loop for working on the page
// itself rather than on the base.
if (flags.has("page")) {
  const named = value("save");
  const save = named ?? newestSave()?.name;
  if (!save) throw new Error("No save found. Name one with --save=<name>.");
  const page = rerenderPage(save, { threshold });
  if (!page) throw new Error(`No state file read yet for ${save}. Run: bun run report --save="${save}"`);
  console.log(`\n  page  ${page}  (redrawn from the last read, no engine run)`);
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
