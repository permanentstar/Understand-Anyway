/**
 * Splits a single LLM call budget (global concurrency + QPM) across N mapper
 * worker slots. Pure function, ported from deploy
 * `splitLlmBudgetForMapperSlots` / `splitIntegerBudget` with `slot < 1`
 * normalised to a single slot and integer rounding documented inline.
 *
 * Each per-slot budget keeps `>= 1` to avoid handing out a no-op slice.
 * Remainder is distributed to the first `total % slots` slots (deploy keeps
 * this front-loaded behaviour; preserved for determinism).
 */

export interface LlmBudgetInput {
  /** Total simultaneous LLM in-flight calls across all slots. */
  globalConcurrency: number;
  /** Total per-minute call quota across all slots. */
  qpmLimit: number;
}

export interface LlmBudgetSlot {
  globalConcurrency: number;
  qpmLimit: number;
}

export function splitIntegerBudget(total: number, slots: number): number[] {
  const normalisedTotal = Math.max(1, Math.floor(Number(total) || 1));
  const normalisedSlots = Math.max(1, Math.floor(Number(slots) || 1));
  const base = Math.floor(normalisedTotal / normalisedSlots);
  const remainder = normalisedTotal % normalisedSlots;
  return Array.from({ length: normalisedSlots }, (_, index) => Math.max(1, base + (index < remainder ? 1 : 0)));
}

export function splitLlmBudgetForMapperSlots(budget: LlmBudgetInput, slots: number): LlmBudgetSlot[] {
  const normalisedSlots = Math.max(1, Math.floor(Number(slots) || 1));
  const concurrency = splitIntegerBudget(budget.globalConcurrency, normalisedSlots);
  const qpm = splitIntegerBudget(budget.qpmLimit, normalisedSlots);
  return Array.from({ length: normalisedSlots }, (_, index) => ({
    globalConcurrency: concurrency[index]!,
    qpmLimit: qpm[index]!,
  }));
}
