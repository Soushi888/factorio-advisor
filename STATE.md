# The state file

`data/state/<save>.json` is what the engine said about one save at one tick. Everything the advisor knows about Soushi's actual base comes from here, and four commands, two rendering layers and two agent sessions read it, so this file documents the contract rather than leaving it to be inferred from `state.ts`.

It is written by `bun run state` and `bun run report`, both of which copy the save, append a collector to the copy's own `control.lua`, run the engine against the copy under a redirected write-data, and parse back the one JSON file the collector wrote. The player's save is never opened in place.

**The whole file is derived and regenerable from the save it names.** Nothing in it is authored, nothing is defaulted, and a field the engine could not answer is absent rather than zero.

## Shape

```
{
  snapshot: { gameVersion, build, mods[], dumpedAt },   // which prototype dump this pairs with
  save: {
    name, copiedFrom, tick, hoursPlayed, surfaces[], readAt,
    day?, censusClasses?, surfaceState?
  },
  forces: { player: ForceState, enemy: …, neutral: … },
  map?: SurfaceMap[]                                    // present from U8
}
```

The `snapshot` block matters more than it looks: a state file is only meaningful against the prototype dump of the same game version, and every command prints both in its header for that reason.

## `forces.<name>`

| Field | What it is |
|---|---|
| `technologies` | `researched[]`, `current`, `queue[]`, straight from the force. |
| `research` | `labSpeedModifier`, `labProductivityBonus`, `progress`. Lab capacity is derived from these plus the current technology's own `unit.time`, never from a remembered lab speed. |
| `production.item` / `production.fluid` | One `Flow` per name. **Fluids are here, not in `item`.** |
| `machines` | The census: placed count per prototype name, for every class declaring an energy source of any kind. |
| `electric` | `networks`, and `production` / `consumption` in **watts**, per prototype. What the grid actually delivered over the last hour. |
| `energy` | The engine's own resolved usage, drain and buffer per prototype in the census, copied rather than inferred, because no single drain rule fits both an assembling machine and a radar. |
| `logistic` | Contents of every logistic network on every surface, summed by item. |

### `Flow`, and the direction trap

```
{ produced, consumed, producedPerMinute, consumedPerMinute }
```

Cumulative totals since the map was created, plus the game's own one-hour rolling averages.

**On item and fluid production statistics the engine's `input_counts` is what was MADE and `output_counts` is what was USED.** That is not read off the docs, it is settled against this save: the lab item reports `input = 84` on a base with 84 labs placed, and nothing in Factorio consumes a lab. **Electric network statistics use the opposite convention**, producers in `output_counts`, and that is verified separately by 34 radars at a 300 kW nameplate landing at 10.14 MW.

Both directions are recorded because **the gap between them is the diagnosis**. A line making exactly what the base eats has no spare and cannot feed anything new, however many machines stand in it, and a single rate cannot tell that line from an idle one. `flowOf()` in `state.ts` returns the pair plus `headroomPerMinute`, which is made minus used, and normalises a pre-U7 file that carried only one rate under a production label.

A report refuses to diff a pre-U7 file against a later one and says why, because subtracting consumption from production invents a swing that never happened.

## `map[]`, the geometry

One entry per surface. Two resolutions, because one does not fit:

| Field | What it is |
|---|---|
| `cellTiles` | 32, the engine's own chunk. The map buckets into chunks so a cell boundary on the page is a cell boundary in the game. |
| `bounds` | Tile bounds of everything below, so a renderer needs no second pass. |
| `cells[]` | Per chunk: `byType` counts of the force's placed entities, `total`, and the surface's `pollution` at that chunk. |
| `ore[]` | Per chunk: remaining `amount` per resource name, summed. |
| `points[]` | Exact tile positions, only for prototypes with fewer placed instances than `MAP_POINT_LIMIT`. Which prototypes qualify is derived from the census, never listed. |

**Tile ghosts are excluded.** This save holds 136,298 of them, planned landfill, eighty percent of everything placed, and they set the density shading of the whole map on their own. Entity ghosts stay, because planned construction is part of the base.

**There is no terrain.** The collector reads entities and resources, not tiles. A map that drew water it had not measured would be a picture rather than a report, so the page says so in its footer.

## `data/state/<save>-belts.json`

Written only when the belt survey is asked for, because it is large. Every transport belt, underground, splitter and loader with position, direction and per-lane contents.

**A transport line's `line_length` is 1 per belt entity**, 1.15 on a curve, not the merged segment length. So a lane's `get_contents` count is that tile's own, and a lane holding 4 items on a span of 1 is exactly full. Measured, and the opposite assumption would have carried a whole density model.

**A survey and a state file from different ticks are two different bases.** Every saturation figure divides a rate from one by a lane count from the other, so `bun run bus` refuses a mismatch and names both ticks rather than printing a number nothing supports.

## Freshness, and how to prove the read wrote nothing

The file is as old as the last save on disk. It is never fresher than that, and the running session is out of reach by design. Every command prints `readAt`, and an answer about a base Soushi changed an hour ago is worse than no answer.

The read-only property is anti-claim A1, and its usual probe is `find ~/.factorio -newermt <run start>` returning nothing. **That probe is unreliable any time Factorio is open at all, menu included**, because the client writes `factorio-current.log`, `player-data.json`, `config.ini` and autosaves throughout and the sweep cannot tell those writes from ours. The probe that works regardless is a byte comparison across one run: hash `config.ini` and `player-data.json` before and after a `state` read. Done 2026-09-21 at 02:21 with the client running: identical.

## Who reads this file

| Reader | What it takes |
|---|---|
| `advise.ts` | Flows, research, census, electric, and the map for the places advice points at. |
| `map.ts` | `map[]` only. Clusters chunks into power blocks and ore fields. |
| `sections.ts` | All of it, cut into the six domains. |
| `power.ts` | Census and `energy`, joined to the snapshot's energy fields. |
| `next.ts` | The researched set, subtracted from the technology graph. |
| `bus.ts` | The belts file, cross-checked against this one's tick. |
| `bridge/report.ts` | Two of these files, diffed. |

A change to this schema is therefore a change to seven readers, which is why `flowOf()` exists rather than every caller reaching into the raw shape.
