import { existsSync } from "node:fs";
import { BOARD, livePath } from "./live.ts";
import { REPORTS_DIR } from "./watch.ts";

/**
 * `bun run live`: Niceboard's event tail, bound to this board. One line per
 * event, for a Monitor: `SAVE <time> index.html` when the loop has written a
 * report, `CHAT` or `SEND` with `MORE` lines when Soushi wrote on the page.
 * Extra arguments pass through, so `--as "<label>"` names the listener the
 * page shows.
 */
const live = livePath();
if (!existsSync(live)) {
  console.error(`No Niceboard Live.ts at ${live}. Set NICEBOARD_LIVE to its path.`);
  process.exit(2);
}
const proc = Bun.spawn(["bun", live, "tail", REPORTS_DIR, "--board", BOARD, ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => proc.kill(sig));
process.exit(await proc.exited);
