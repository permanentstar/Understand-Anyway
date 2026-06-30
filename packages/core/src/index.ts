/**
 * @understand-anyway/core
 *
 * Multi-project orchestration over upstream Understand-Anything.
 *
 * Boundary:
 * - Deterministic phases (scan/batch/merge) are delegated to upstream scripts
 *   and `@understand-anything/core`; we do NOT reimplement them.
 * - The semantic phase reuses upstream prompt/parser exports; we only own the
 *   orchestration and which LlmProvider executes the prompt.
 */

export const CORE_PACKAGE = "@understand-anyway/core";

export * from "./upstream.js";
export * from "./build/index.js";
export * from "./compat/index.js";
export * from "./review/index.js";
