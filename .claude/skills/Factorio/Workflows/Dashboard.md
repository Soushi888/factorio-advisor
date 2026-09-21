# Dashboard

Render the state of the base as a page Soushi can keep open on his second screen while he plays.

## Ideal state

He opens `reports/index.html` and, without scrolling, knows what to do next and why. One map holds the left, cut into layers he can switch; the reading holds the right, cut into the parts he thinks in. Every figure on it can be traced to a path in a state file. No figure on it is older than he thinks it is.

The depth target is `Orient`: not a table of readings, but a page that takes a position. Orient says what the week can carry and refuses to fill a corridor it has no data for. This page says what the base can carry and refuses to render a block it did not measure.

The look target is the game. Soushi asked for the map to be at least as clear as the one he already has in Factorio, and then for it tile by tile, and then for the game's own assets on the page. A dashboard that reads like a spreadsheet about his factory has missed.

## Done looks like

- **Fresh, or honestly stale.** The header states the tick, the hours played and when the save was read. If the newest save on disk is older than the session Soushi is in, the first thing said to him is to press Ctrl+S, not a number.
- **The plan first, when there is one.** `data/plans/<save>.json` renders as the top section: ordered steps, each with what it costs, what it buys, how reversible it is, and a live progress bar read from the state file at render time. A step that names a place is clickable and flies the map there.
- **Then the derived advice**, each line tagged with its section, carrying the measurement under it, and clickable to the same map.
- **Sections, not a list.** Science, Energy, Defence, Production, Logistics, Mining. Each opens with one sentence that takes a position, then its figures, then its tables, then its advice, then the line saying what that part of the base can carry with the number behind it.
- **One map, layered, tile by tile.** Entities at the footprint their prototype declares and the position the engine reported. Water and ore at tile resolution. Charted ground and enemy nests for context. A legend grouped into the ground, the base and the places. Wheel zooms at the cursor, digits toggle layers, the pointer reads out its tile coordinate so a place on the page can be typed into the game.
- **The game's own icons**, resolved out of Soushi's installation and never copied into the repo.
- **Provenance in the DOM.** Every figure carries `data-source` and `data-field`. A reader with the state file can check any number without reading the renderer.
- **A block with no measurement says so** rather than rendering zero. A section here with nothing measured is omitted.
- **It keeps up with a cursor.** The map holds tens of thousands of rectangles; if panning stutters, that is a defect and not a detail.

## Do

From the main tree, `bun run report --save="<save>"` for a fresh read, or `bun run report --page` to redraw the page from the state file already on disk, which is the loop for working on the page rather than on the base. `bun run watch` does the first automatically on every save.

Then open the page in real Chrome through `Interceptor` and look at it before telling him it exists. A report whose files were written is not a finished report. Zoom the map in as well as out: half the defects only show at one end.

## Falsifiers

- A figure on the page that no state path produced.
- A section rendered from a measurement that was not taken.
- The page announced without having been opened.
- A delta computed across two state files that measured different things: a pre-U7 file carries consumption only, and diffing it against a production file invents a swing that never happened. The report refuses this and says why.
- Terrain drawn that was not measured. Water is measured, tile by tile, and is the only terrain there is.
- A plan step showing a number typed into its prose rather than read from the state file.
- Game assets copied into the repository. They are Wube's and the repo is public; the page points at the installation.

## Known gaps, to state rather than paper over

There is no live reload, so a regenerated page needs a refresh. Nothing on the page is clickable through to a source file. The plan is authored rather than derived, which is the point of it, but that also means it goes stale on its own: the bars stay current, the words do not, and the page says how many minutes of play ago it was written.
