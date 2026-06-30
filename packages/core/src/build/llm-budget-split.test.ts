import { describe, expect, it } from "vitest";
import { splitIntegerBudget, splitLlmBudgetForMapperSlots } from "./llm-budget-split.js";

describe("splitIntegerBudget", () => {
  it("returns N slots of 1 when total <= slots", () => {
    expect(splitIntegerBudget(1, 4)).toEqual([1, 1, 1, 1]);
    expect(splitIntegerBudget(2, 4)).toEqual([1, 1, 1, 1]);
  });

  it("distributes the integer remainder to the first slots", () => {
    expect(splitIntegerBudget(10, 4)).toEqual([3, 3, 2, 2]); // 10/4 = 2 r 2 -> first two get +1
    expect(splitIntegerBudget(7, 3)).toEqual([3, 2, 2]); // 7/3 = 2 r 1 -> first gets +1
  });

  it("returns a single slot equal to the total when slots = 1", () => {
    expect(splitIntegerBudget(10, 1)).toEqual([10]);
  });

  it("normalises non-positive inputs to at least 1", () => {
    expect(splitIntegerBudget(0, 3)).toEqual([1, 1, 1]);
    expect(splitIntegerBudget(5, 0)).toEqual([5]);
    expect(splitIntegerBudget(-1, -1)).toEqual([1]);
  });

  it("floors fractional totals", () => {
    expect(splitIntegerBudget(7.9, 2)).toEqual([4, 3]);
  });
});

describe("splitLlmBudgetForMapperSlots", () => {
  it("splits both global concurrency and qpm evenly when total divides cleanly", () => {
    const slots = splitLlmBudgetForMapperSlots({ globalConcurrency: 4, qpmLimit: 12 }, 4);
    expect(slots).toEqual([
      { globalConcurrency: 1, qpmLimit: 3 },
      { globalConcurrency: 1, qpmLimit: 3 },
      { globalConcurrency: 1, qpmLimit: 3 },
      { globalConcurrency: 1, qpmLimit: 3 },
    ]);
  });

  it("front-loads the remainder on both budgets when they do not divide cleanly", () => {
    const slots = splitLlmBudgetForMapperSlots({ globalConcurrency: 5, qpmLimit: 11 }, 4);
    expect(slots).toEqual([
      { globalConcurrency: 2, qpmLimit: 3 },
      { globalConcurrency: 1, qpmLimit: 3 },
      { globalConcurrency: 1, qpmLimit: 3 },
      { globalConcurrency: 1, qpmLimit: 2 },
    ]);
  });

  it("returns a single full-budget slot when slots <= 1", () => {
    expect(splitLlmBudgetForMapperSlots({ globalConcurrency: 8, qpmLimit: 16 }, 1)).toEqual([
      { globalConcurrency: 8, qpmLimit: 16 },
    ]);
    expect(splitLlmBudgetForMapperSlots({ globalConcurrency: 8, qpmLimit: 16 }, 0)).toEqual([
      { globalConcurrency: 8, qpmLimit: 16 },
    ]);
  });

  it("never produces a slot with 0 in either dimension", () => {
    const slots = splitLlmBudgetForMapperSlots({ globalConcurrency: 1, qpmLimit: 1 }, 4);
    for (const slot of slots) {
      expect(slot.globalConcurrency).toBeGreaterThanOrEqual(1);
      expect(slot.qpmLimit).toBeGreaterThanOrEqual(1);
    }
  });
});
