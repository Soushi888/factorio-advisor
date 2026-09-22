/**
 * Fluid geometry: where a machine's pipes go, and whether a print's plumbing works.
 *
 * `layout.ts` lays belts and inserters, which move items. Fluids move through
 * pipes, and a print that connects a fluid machine with belts builds a row that
 * does nothing (GEN-1). This is the other half: the ports every fluid machine
 * declares, and the three checks that say whether a laid-out print is plumbed.
 *
 * Nothing here is typed in. Every offset comes from `fluid_boxes.pipe_connections`
 * on the machine's own prototype and every underground reach from the
 * pipe-to-ground's own `fluid_box`, which declares a surface connection toward
 * its facing and an underground one toward the opposite at `max_underground_distance`.
 */

import type { Data, Proto } from "./proto.ts";
import type { BpEntity } from "./blueprint.ts";

/** North, east, south, west in the sixteen-direction compass of 2.0. */
export const N = 0;
export const E = 4;
export const S = 8;
export const W = 12;

/** One tile step in a direction. */
export function step(direction: number): [number, number] {
  if (direction === N) return [0, -1];
  if (direction === E) return [1, 0];
  if (direction === S) return [0, 1];
  if (direction === W) return [-1, 0];
  // A port on a diagonal is not something this lays out, and guessing a step
  // for one would put a pipe on a tile no prototype named.
  throw new Error(`No tile step for direction ${String(direction)}: pipes run on the four axes.`);
}

/** The opposite direction, which is where an underground tunnels. */
export function opposite(direction: number): number {
  return (direction + 8) % 16;
}

/**
 * Rotate a local offset by an entity direction.
 *
 * A quarter turn clockwise is (x, y) -> (-y, x) in Factorio's coordinates, where
 * y grows downward, applied direction/4 times. Only the four axes, for the same
 * reason `step` refuses the rest.
 */
export function rotate([x, y]: [number, number], direction: number): [number, number] {
  if (direction % 4 !== 0) throw new Error(`Cannot rotate by direction ${String(direction)}.`);
  let p: [number, number] = [x, y];
  for (let i = 0; i < direction / 4; i += 1) p = [-p[1], p[0]];
  return p;
}

/** One fluid port: the tile its pipe stands on, and which way it faces out. */
export interface Port {
  /** The fluid box's own index, which is the order the recipe's fluids take. */
  box: number;
  kind: "input" | "output";
  /** Tile offset from the machine's centre, in the machine's own orientation. */
  offset: [number, number];
  /** The direction the port faces out of the machine. */
  facing: number;
}

/**
 * Every fluid port a machine declares, at direction 0.
 *
 * `position` in the prototype is the connection point on the machine's edge and
 * the PIPE stands one tile further out, in the connection's own direction. That
 * one-tile step is the whole difference between a print that connects and a
 * print whose pipes sit inside the machine's own footprint.
 *
 * Boxes keep their declared order because that order is what the recipe's fluid
 * ingredients and results are assigned to: the port that takes water on
 * light-oil-cracking takes heavy oil on lubricant, since lubricant has one
 * ingredient and it lands in box 0.
 */
export function portsOf(proto: Proto): Port[] {
  const boxes = proto["fluid_boxes"];
  if (!Array.isArray(boxes)) return [];
  const out: Port[] = [];
  boxes.forEach((raw, box) => {
    if (typeof raw !== "object" || raw === null) return;
    const fb = raw as Record<string, unknown>;
    const type = fb["production_type"];
    if (type !== "input" && type !== "output") return;
    const conns = fb["pipe_connections"];
    if (!Array.isArray(conns)) return;
    for (const c of conns) {
      if (typeof c !== "object" || c === null) continue;
      const conn = c as Record<string, unknown>;
      // An underground connection is how a pipe-to-ground reaches its partner,
      // not a port a machine offers, so it is skipped rather than laid on.
      if (conn["connection_type"] === "underground") continue;
      const pos = conn["position"];
      const dir = conn["direction"];
      if (!Array.isArray(pos) || typeof dir !== "number") continue;
      const [px, py] = [Number(pos[0]), Number(pos[1])];
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const [sx, sy] = step(dir);
      out.push({ box, kind: type, offset: [px + sx, py + sy], facing: dir });
    }
  });
  return out;
}

/** The same ports for a machine placed at a position and a direction. */
export function portsAt(
  proto: Proto,
  centre: [number, number],
  direction: number,
): Array<Port & { tile: [number, number] }> {
  return portsOf(proto).map((p) => {
    const [dx, dy] = rotate(p.offset, direction);
    return {
      ...p,
      facing: (p.facing + direction) % 16,
      tile: [centre[0] + dx, centre[1] + dy] as [number, number],
    };
  });
}

/** How far a pipe-to-ground reaches, from its own prototype. */
export function undergroundReach(data: Data): number {
  // The entity, explicitly, never `find` on the bare name. `pipe-to-ground` is
  // carried by an item and an entity alike, and the item declares no fluid box:
  // the same trap that made every entity in a blueprint measure one tile when
  // the audit took a name's first prototype (CLAUDE.md, bus#10).
  const proto = data.find("pipe-to-ground", ["pipe-to-ground"]);
  const fb = proto?.["fluid_box"];
  if (typeof fb === "object" && fb !== null) {
    const conns = (fb as Record<string, unknown>)["pipe_connections"];
    if (Array.isArray(conns)) {
      for (const c of conns) {
        if (typeof c !== "object" || c === null) continue;
        const conn = c as Record<string, unknown>;
        const d = conn["max_underground_distance"];
        if (typeof d === "number" && Number.isFinite(d)) return d;
      }
    }
  }
  throw new Error(
    "pipe-to-ground declares no max_underground_distance in this snapshot, so how\n" +
      "far a tunnel reaches is unknown and laying one would be inventing it.",
  );
}

/** One thing wrong with a print's plumbing, in the terms a reader can check. */
export interface PlumbingFault {
  kind: "unconnected-port" | "mixed-network" | "underground-to-nowhere";
  where: [number, number];
  what: string;
}

interface Node {
  tile: [number, number];
  /** Directions this entity connects on, at the surface. */
  surface: number[];
  /** For a pipe-to-ground, the direction it tunnels and how far it may reach. */
  tunnel?: { direction: number; reach: number };
  label: string;
  /** The fluid this node is a port for, when it is one. */
  fluid?: string;
}

/**
 * The three checks a laid-out fluid print has to pass before anybody pastes it.
 *
 * None of them proves throughput. They prove the print is not wrong for a reason
 * a reader could have caught first, which is a different and smaller claim, and
 * the sandbox paste stays the only falsifier for flow. Each one exists because
 * it caught something: a missing tile between a port and its header, a tunnel
 * whose partner was not where the layout thought, and a header carrying two
 * fluids into one network. All three produce a print that pastes cleanly and
 * does nothing, which is the output class this project exists not to produce.
 */
export function checkPlumbing(
  data: Data,
  entities: BpEntity[],
  fluidOf: (entity: BpEntity) => Map<number, string> | null,
): PlumbingFault[] {
  const faults: PlumbingFault[] = [];
  const reach = undergroundReach(data);
  const at = new Map<string, Node>();
  const key = (x: number, y: number): string => `${String(Math.round(x))}:${String(Math.round(y))}`;

  for (const e of entities) {
    const x = e.position?.x ?? 0;
    const y = e.position?.y ?? 0;
    const dir = e.direction ?? 0;
    if (e.name === "pipe") {
      at.set(key(x, y), { tile: [x, y], surface: [N, E, S, W], label: "pipe" });
    } else if (e.name === "pipe-to-ground") {
      at.set(key(x, y), {
        tile: [x, y],
        surface: [dir],
        tunnel: { direction: opposite(dir), reach },
        label: "pipe-to-ground",
      });
    } else {
      const proto = data.find(e.name, data.entityClasses());
      if (!proto) continue;
      const want = fluidOf(e);
      for (const p of portsAt(proto, [x, y], dir)) {
        // The node sits on the machine's EDGE, not on the port tile, and it
        // connects outward. Putting it on the port tile made a pipe standing
        // there overwrite it, which silently emptied every network of the very
        // ports that give it a fluid, so the mixed-network check could not fire
        // and an underground mouth facing its own machine read as empty ground.
        const [sx, sy] = step(p.facing);
        const edge: [number, number] = [p.tile[0] - sx, p.tile[1] - sy];
        const fluid = want?.get(p.box);
        at.set(key(edge[0], edge[1]), {
          tile: edge,
          surface: [p.facing],
          label: `${e.name} box ${String(p.box)}`,
          ...(fluid ? { fluid } : {}),
        });
      }
    }
  }

  // 1. Every machine port has something on its tile that can take a fluid.
  for (const e of entities) {
    if (e.name === "pipe" || e.name === "pipe-to-ground") continue;
    const proto = data.find(e.name, data.entityClasses());
    if (!proto) continue;
    const want = fluidOf(e);
    if (!want) continue;
    for (const p of portsAt(proto, [e.position?.x ?? 0, e.position?.y ?? 0], e.direction ?? 0)) {
      if (!want.has(p.box)) continue;
      const here = at.get(key(p.tile[0], p.tile[1]));
      // The port itself registers a node, so what is being asked is whether
      // anything ELSE stands there: a pipe, or an underground facing it.
      const plumbed = entities.some(
        (o) =>
          (o.name === "pipe" || o.name === "pipe-to-ground") &&
          Math.round(o.position?.x ?? NaN) === Math.round(p.tile[0]) &&
          Math.round(o.position?.y ?? NaN) === Math.round(p.tile[1]),
      );
      if (!plumbed) {
        faults.push({
          kind: "unconnected-port",
          where: p.tile,
          what: `${e.name} ${p.kind} box ${String(p.box)} (${want.get(p.box) ?? "?"}) has no pipe on its port tile`,
        });
      } else if (here?.label === "pipe-to-ground") {
        // An underground standing on a port tile has to open back toward the
        // machine, which is the opposite of the way the port faces out.
        if (!here.surface.includes(opposite(p.facing))) {
          faults.push({
            kind: "unconnected-port",
            where: p.tile,
            what: `${e.name} ${p.kind} box ${String(p.box)} meets a pipe-to-ground facing the wrong way`,
          });
        }
      }
    }
  }

  // 3. Every underground mouth faces something, and its tunnel finds a partner.
  for (const e of entities) {
    if (e.name !== "pipe-to-ground") continue;
    const x = Math.round(e.position?.x ?? 0);
    const y = Math.round(e.position?.y ?? 0);
    const dir = e.direction ?? 0;
    const [sx, sy] = step(dir);
    if (!at.has(key(x + sx, y + sy))) {
      faults.push({
        kind: "underground-to-nowhere",
        where: [x, y],
        what: "the surface mouth opens on empty ground",
      });
    }
    const [tx, ty] = step(opposite(dir));
    let found = false;
    for (let i = 1; i <= reach; i += 1) {
      const other = at.get(key(x + tx * i, y + ty * i));
      // A tunnel runs UNDER the surface, so pipes and machines standing on the
      // path are transparent to it and only another pipe-to-ground decides. An
      // earlier version broke on the first node of any kind, which reported
      // eighteen dead tunnels in a print whose tunnels were the whole point:
      // the crossing header they pass beneath was reading as an obstacle.
      if (!other?.tunnel) continue;
      found = other.tunnel.direction === dir;
      break;
    }
    if (!found) {
      faults.push({
        kind: "underground-to-nowhere",
        where: [x, y],
        what: `no partner within ${String(reach)} tiles in the direction it tunnels`,
      });
    }
  }

  // 2. Every connected network carries one fluid.
  const seen = new Set<string>();
  for (const [k, node] of at) {
    if (seen.has(k)) continue;
    const group: Node[] = [];
    const stack = [k];
    seen.add(k);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const n = at.get(cur);
      if (!n) continue;
      group.push(n);
      for (const dir of n.surface) {
        const [dx, dy] = step(dir);
        const nk = key(n.tile[0] + dx, n.tile[1] + dy);
        const other = at.get(nk);
        if (!other || seen.has(nk)) continue;
        if (!other.surface.includes(opposite(dir))) continue;
        seen.add(nk);
        stack.push(nk);
      }
      if (n.tunnel) {
        const [tx, ty] = step(n.tunnel.direction);
        for (let i = 1; i <= n.tunnel.reach; i += 1) {
          const nk = key(n.tile[0] + tx * i, n.tile[1] + ty * i);
          const other = at.get(nk);
          if (!other?.tunnel) continue;
          if (other.tunnel.direction === opposite(n.tunnel.direction) && !seen.has(nk)) {
            seen.add(nk);
            stack.push(nk);
          }
          break;
        }
      }
    }
    const fluids = new Set<string>();
    for (const n of group) if (n.fluid) fluids.add(n.fluid);
    if (fluids.size > 1) {
      faults.push({
        kind: "mixed-network",
        where: node.tile,
        what: `one network reaches ports for ${[...fluids].sort().join(" and ")}`,
      });
    }
  }
  return faults;
}
