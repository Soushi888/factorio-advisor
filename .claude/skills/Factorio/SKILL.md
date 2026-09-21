---
name: Factorio
category: personal
description: >
  Advise Soushi on his vanilla Factorio 2.0 Space Age playthrough from the game's own
  declared data and the state of his save, never from recall. Renders the sectioned
  dashboard, answers a specific question about the base, and turns either into an ordered
  battle plan that names what to build, how much, and where.
  USE WHEN: factorio, factorio advisor, my factorio game, game 4, what should I build next,
  my base, my factory, science per minute, SPM, what is my bottleneck, ratio, how many
  machines, research path, what can I research, my power, am I short on power, blueprint
  audit, judge this blueprint, belt saturation, where do I expand, which patch, ore patch,
  read my save, factorio dashboard, factorio report, advise my base.
  NOT FOR: playing the game, sending input to it, or any question the snapshot and the
  save cannot answer.
argument-hint: "[Dashboard | Analysis <question> | Plan]"
compatibility: claude-code
---

# Factorio, the advisor over Soushi's own save

**This skill lives inside the repo it describes**, at `.claude/skills/Factorio`, and `~/.claude/skills/Factorio` is a symlink to it so it still routes from any directory. That is deliberate: `Commands.md` is a description of this repo's CLI surface, and a copy living anywhere else drifts the first time a flag changes. One source, versioned with the code it documents.

Soushi plays every minute himself. This skill reads, derives and advises; it never sends input to the game and never writes to a game directory.

**`CLAUDE.md` in the repo root is the authority on how the code must behave.** This skill is the authority on how to use it and how to read a game. Where they would overlap, this skill points.

## The rule that holds everything else

**Every number comes from the prototype snapshot or from the engine's own report on a copy of his save. Nothing is recalled, and a gap is reported as a gap.**

That is the whole value. A Factorio wiki number from memory is worth nothing to him: he can read the wiki. What he cannot do is ask his own factory what it is doing and get an answer with the measurement attached. So the falsifier is blunt: **a figure that no snapshot path and no state path produced is a defect, whatever else it gets right.** The tool already refuses to predict inserter throughput past its rotation ceiling and refuses to scale quality modules; those refusals are features and never get "improved" into a plausible multiplier.

Second rule, downstream of the first: **every recommendation carries the measurement that produced it.** "Build more smelters" is a horoscope. "Iron ore is running 263/min behind what your furnaces eat" is advice.

## What the tool can and cannot see

It sees: research and the technology graph, production and consumption per item and per fluid as one-hour averages, the machine census, the electric network's delivered watts, evolution and pollution, the logistic network's contents and robot fleets, every train with its schedule and its cargo, every train stop by the name Soushi gave it, and the geometry tile by tile: every placed entity's position, water and ore as tile runs, the charted extent, and the enemy nests inside it.

It does not see: which recipe a given machine is set to, what modules are in it, cliffs, trees, the running session, or anything newer than the last save on disk. **When Soushi is mid-game, the answer usually starts with asking him to hit Ctrl+S.**

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "dashboard", "report", "how is my base", no argument mid-session | `Workflows/Dashboard.md` |
| a specific question: a ratio, a tech, a blueprint, a bottleneck, "why is X slow" | `Workflows/Analysis.md` |
| "what should I build next", "plan", "where do I expand" | `Workflows/Plan.md` |

## Quick reference

- Refresh from a save: `bun run report --save="game 4"` from the **main tree** (worktrees share `data/state/` by symlink).
- Redraw the page without re-reading the save: `bun run report --page`. This is the loop for working on the dashboard rather than on the base.
- What is holding the factory back: `bun run bottleneck`.
- The standing loop: `bun run watch`, which turns each save into a report and refreshes `reports/index.html`.
- The synthesis alone: `bun run advise --spm=45`.
- Every command and what it refuses to answer: `Commands.md`.
- How to read a base, in order: `Reading.md`.
- The traps that have already cost a run, beyond the ones `CLAUDE.md` already states: `Gotchas.md`.

## Guards

- **Never claim the game state without a fresh read.** The state file is as old as the last save; say its age.
- **Never commit in this repo without Soushi's word,** and check `.local/convene/` first: other agent sessions work this repo under a covenant, and a hold precedes an edit.
- **Never invent a machine he does not have.** The solver picks the best prototype in the snapshot; his census says what is actually placed.
- **Never announce a page without opening it.** Web output is verified in real Chrome through `Interceptor` before Soushi is told it exists, zoomed in as well as out.
- **Never copy the game's assets into this repository.** The icons are Wube's art and the repo is public; `src/icons.ts` points at Soushi's own installation by file URL, and that is the only sanctioned path.

## Examples

```
/Factorio Dashboard
/Factorio Analysis why is my purple science the slowest
/Factorio Plan
```
