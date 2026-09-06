import { beltOptions, inserterCeilings, type BeltFit } from "./belts.ts";
import type { AuditResult } from "./audit.ts";
import { byRecipe } from "./audit.ts";
import type { Data } from "./proto.ts";

/**
 * Judging a print against a target, rather than only describing it.
 *
 * The audit says what a print does. This says whether that is enough. Every
 * figure is the audit's own numbers scaled by one ratio, so nothing new is
 * measured here and nothing new can be invented: if the audit is right, this is
 * right, and if the audit is wrong this is wrong in exactly the same place.
 */

export interface StepVerdict {
  recipe: string;
  machine: string;
  /** Machines the print actually places. */
  present: number;
  /** Machines the target needs, at the print's own per-machine rate. */
  needed: number;
  /** Positive when the print has more than the target needs. */
  spare: number;
  outputPerSecond: number;
  product: string;
}

export interface BeltVerdict {
  /** The best tier the print actually places, or null if it places none. */
  present: { name: string; itemsPerSecond: number; count: number } | null;
  /** The cheapest tier that carries the target on one belt, if any does. */
  needed: BeltFit | null;
  /** Saturation of the print's own tier at the target rate. */
  presentSaturation: number | null;
  /** True when the print's tier cannot carry the target on one belt. */
  underTiered: boolean;
}

export interface InserterVerdict {
  /** Inserters in the print, by prototype. */
  present: Array<{ name: string; count: number; ceilingPerSecond: number }>;
  machines: number;
  /** Target rate divided across the machines, per machine per second. */
  perMachinePerSecond: number;
  /** Inserters each machine needs at the rotation ceiling, rounded up. */
  neededPerMachine: Array<{ name: string; count: number }>;
}

export interface TargetVerdict {
  item: string;
  targetPerSecond: number;
  achievedPerSecond: number;
  /** achieved / target. Below 1 the print is short. */
  ratio: number;
  shortfallPerSecond: number;
  steps: StepVerdict[];
  belt: BeltVerdict;
  inserters: InserterVerdict | null;
  /** Set when --item was not given and the product was chosen by net export. */
  itemChosen: boolean;
}

/** The product a print is for: the item it exports most of. */
export function mainProduct(result: AuditResult): string | null {
  let best: string | null = null;
  let bestNet = 0;
  for (const f of result.flows) {
    if (f.net > bestNet) {
      bestNet = f.net;
      best = f.item;
    }
  }
  return best;
}

export function judge(
  data: Data,
  result: AuditResult,
  targetPerSecond: number,
  item?: string,
): TargetVerdict {
  const chosen = item ?? mainProduct(result);
  if (!chosen) {
    throw new Error(
      "This print exports nothing, so there is no target to judge it against.\n" +
        "Name the item explicitly with --item=<name> if you meant an internal one.",
    );
  }

  const flow = result.flows.find((f) => f.item === chosen);
  if (!flow) {
    const exported = result.flows.filter((f) => f.net > 0).map((f) => f.item);
    throw new Error(
      `This print does not handle ${chosen}.\n` +
        (exported.length > 0
          ? `It exports: ${exported.join(", ")}.`
          : "It exports nothing."),
    );
  }

  // The print's own rate for the target item is its net export: what leaves.
  const achieved = flow.net;
  const ratio = targetPerSecond === 0 ? Infinity : achieved / targetPerSecond;

  // Each step is scaled by the same ratio. A step making the target item is
  // sized against it directly; an upstream step is sized by the same factor,
  // because the whole print scales together.
  const scale = achieved > 0 ? targetPerSecond / achieved : Infinity;
  const steps: StepVerdict[] = byRecipe(result).map((g) => {
    const needed = Number.isFinite(scale) ? g.count * scale : Infinity;
    return {
      recipe: g.recipe,
      machine: g.machine,
      present: g.count,
      needed,
      spare: g.count - needed,
      outputPerSecond: g.outputPerSecond,
      product: g.product,
    };
  });

  // Belts. The print's own best tier against the tier the target would want.
  const present = result.beltsPresent[0] ?? null;
  const fits = beltOptions(data, targetPerSecond);
  const needed = fits.find((f) => f.saturation <= 1) ?? null;
  const presentSaturation = present ? targetPerSecond / present.itemsPerSecond : null;

  const belt: BeltVerdict = {
    present,
    needed,
    presentSaturation,
    underTiered: presentSaturation !== null && presentSaturation > 1,
  };

  // Inserters. A ceiling from rotation alone, as everywhere else in this tool:
  // real throughput depends on belt chasing and the capacity research, which are
  // not prototype facts, so this says how many are needed AT THE CEILING and
  // says that is what it is.
  const inserterNames = new Set(
    inserterCeilings(data).map((c) => String(c.inserter["name"])),
  );
  const inPrint = result.census.filter((c) => inserterNames.has(c.name));
  const machines = result.machines.length;
  let inserters: InserterVerdict | null = null;
  if (machines > 0) {
    const perMachine = targetPerSecond / machines;
    const ceilings = inserterCeilings(data);
    inserters = {
      present: inPrint.map((c) => ({
        name: c.name,
        count: c.count,
        ceilingPerSecond:
          ceilings.find((x) => String(x.inserter["name"]) === c.name)
            ?.itemsPerSecondCeiling ?? 0,
      })),
      machines,
      perMachinePerSecond: perMachine,
      neededPerMachine: ceilings
        .filter((c) => c.itemsPerSecondCeiling > 0)
        .map((c) => ({
          name: String(c.inserter["name"]),
          count: Math.ceil(perMachine / c.itemsPerSecondCeiling),
        })),
    };
  }

  return {
    item: chosen,
    targetPerSecond,
    achievedPerSecond: achieved,
    ratio,
    shortfallPerSecond: Math.max(0, targetPerSecond - achieved),
    steps,
    belt,
    inserters,
    itemChosen: item === undefined,
  };
}
