# Dashboard

Render the state of the base as a page Soushi can keep open on his second screen while he plays.

## Ideal state

He opens `reports/index.html` and, without scrolling, knows what to do next and why. The page is cut into the parts he thinks in, each part carrying its own numbers, its own advice and its own view of the map. Every figure on it can be traced to a path in a state file. No figure on it is older than he thinks it is.

The depth target is `Orient`: not a table of readings, but a page that takes a position. Orient says what the week can carry and refuses to fill a corridor it has no data for. This page says what the base can carry and refuses to render a block it did not measure.

## Done looks like

- **Fresh, or honestly stale.** The header states the tick, the hours played and when the save was read. If the newest save on disk is older than the session Soushi is in, the first thing said to him is to press Ctrl+S, not a number.
- **Sections, not a list.** Science, Energy, Defence, Production, Logistics, Mining. Each opens with one sentence that takes a position, then its figures, then its map, then its table, then the advice that belongs to it.
- **A priority list above the sections.** The ordered advice, each line tagged with its section and carrying the measurement under it. This is the reason to open the page.
- **A map per section, drawn from the save's own coordinates.** Chunk density underneath, that section's entities as points, and the areas the advice names boxed. No terrain: it was never measured, and the footer says so.
- **Provenance in the DOM.** Every figure carries `data-source` and `data-field`. A reader with the state file can check any number without reading the renderer.
- **A block with no measurement says so** rather than rendering zero. A corridor Orient cannot fill is marked unavailable; a section here with nothing measured is omitted.

## Do

From the main tree, `bun run report --save="<save>"`, or leave `bun run watch` running so each save regenerates it. Then open the page in real Chrome through `Interceptor` and look at it before telling him it exists. A report whose files were written is not a finished report.

## Falsifiers

- A figure on the page that no state path produced.
- A section rendered from a measurement that was not taken.
- The page announced without having been opened.
- A delta computed across two state files that measured different things: a pre-U7 file carries consumption only, and diffing it against a production file invents a swing that never happened. The report refuses this and says why.
- Terrain, water or a cliff drawn on a map.

## Known gaps, to state rather than paper over

The page is still thinner than Orient in three ways, and saying so is better than implying parity: there is no live reload, so a regenerated page needs a refresh; nothing on it is clickable through to a source; and the sections do not yet carry an explicit "what this part of the base can carry" the way an Orient corridor carries its hours. Those are the next things to build, not things to claim.
