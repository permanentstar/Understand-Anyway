/**
 * Dashboard dev subcommand barrel — `understand-anyway dashboard dev`.
 *
 * Strictly isolated from the prod dashboard daemon (D3) and the main pipeline:
 * see `scripts/lint-isolation.mjs`. The CLI dispatcher in `cli.ts` is the only
 * caller, and it imports this module dynamically so deleting the entire
 * `dashboard-dev/` directory leaves the rest of the build green (an explicit
 * acceptance of D3-dev).
 */

export { runDashboardDev } from "./dashboard-dev.js";
export type { DashboardDevArgs, RunDashboardDevDeps, DashboardDevResult } from "./dashboard-dev.js";
