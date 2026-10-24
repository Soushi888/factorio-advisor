# Live session

Soushi plays with the board open, and the session watching it follows the game save by save without being told: it reads what each save changed, keeps the plan current, and says it on the board, where he can also write back. Same shape as the Caretaker's live session in darkest-dungeon-advisor, on Niceboard's live mode (`~/.claude/skills/Niceboard/Workflows/Live.md`), which this workflow points at rather than restates.

## Ideal state

He presses Ctrl+S, or an autosave lands, and within a minute the page has reloaded on the new tick and a line from me in the SoushAI drawer says what that save showed and what it changes about the next step, with the number behind it. A question typed in the drawer between two builds gets its answer there, grounded in the last save. He never has to tell me that he saved or that he wrote.

## Start

1. The loop is up from the main tree: `pgrep -af "bridge/cli.ts"`. If not, start `bun run watch` in the background from the main tree (it writes `data/state/` as a side effect, so never from a worktree). Its start lines print the board's address, `http://127.0.0.1:8737/index.html`, and say whether live mode is on.
2. Hand him that address, never `file://`: the drawer and the hot reload exist only on the served page, and answers typed on the `file://` copy stay in that copy's storage.
3. Arm the Monitor tool on `bun run live --as "factorio advisor"` from the main tree, with the longest timeout, and re-arm it on every expiry until he stops playing. Wake on `SAVE`, `CHAT` and `SEND`; `LIVE` needs nothing.

## On SAVE

The loop has written `reports/<save>-<tick>.md` and redrawn the page. Read the newest report (it is already a diff against the previous one) and the plan's markers on the page, then `say` two to four lines on the board: what moved, which plan step closed or advanced, and the one thing to do next, each with its number. A quiet report says nothing crossed a threshold, and so does the line.

When the save contradicts the plan's prose (a step done, a correction now false, a new blocker), fix `data/plans/<save>.json` through `Workflows/Plan.md` and redraw with `bun run report --page`, then say what changed in the plan. The markers move on their own; the words do not, and keeping them true is the point of watching.

## On CHAT or SEND

He wrote on the page. Answer it in the drawer, from the last save and the tools in `Commands.md`, never from memory. When the answer needs a fresher read than the last save, say so and ask for Ctrl+S rather than guessing. A request to change the advisor is a repo change: it goes through a worktree and the covenant in `.local/convene/`, not into the live session.

## Commands

```bash
bun run live --as "<label>"                                                # the tail, bound to reports/index.html
bun ~/.claude/skills/Niceboard/Tools/Live.ts say reports/index.html "<text>"     # a line in the drawer
bun ~/.claude/skills/Niceboard/Tools/Live.ts status reports/index.html "<doing>" # what I am on, until my next say
```

`NICEBOARD_LIVE` overrides where `Live.ts` is found. Without it installed, the loop and the page work as before, served plain, and `bun run live` refuses with the path it looked for.

## Falsifiers

- A save landed and nothing was said on the board.
- A line on the board quoting a number no report, state file or tool output produced.
- The plan's prose left contradicting a save the session read.
- The address handed over was `file://`.
