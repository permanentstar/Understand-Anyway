/**
 * `repair` subcommand dispatcher. Controlled, out-of-band LLM gap repair for the
 * CURRENT project's CURRENT state — never part of the nightly main path.
 *
 *   repair llm-failures        re-run the LLM file-analysis tasks that failed in
 *                              the last build, patch the affected batches,
 *                              re-merge into the existing graph, and persist.
 *   repair llm-graph-failures  re-run graph-level layer/project/tour
 *                              enrichment, then persist the current graph.
 *
 * Always implies --no-dashboard. Re-build artifacts must already exist. For
 * non-dry-run repair requires an LLM provider and fails fast when it cannot be
 * loaded; dry-run never loads it.
 *
 * Bootstrap / config / provider loaders are injectable for tests.
 */

import {
  bootstrapUpstream,
  repairLlmFailures,
  repairLlmGraphFailures,
} from "@understand-anyway/core";
import type { RepairArgs } from "../args.js";
import { buildLlmProvider } from "../build-llm.js";
import { loadResolvedConfig } from "../config/load.js";
import { resolveProjectContext } from "../project-context.js";

export interface RunRepairDeps {
  bootstrap?: typeof bootstrapUpstream;
  loadConfig?: typeof loadResolvedConfig;
  buildLlmProvider?: typeof buildLlmProvider;
  repairLlmFailures?: typeof repairLlmFailures;
  repairLlmGraphFailures?: typeof repairLlmGraphFailures;
  resolveProjectContext?: typeof resolveProjectContext;
  log?: (message: string) => void;
  exit?: (code: number) => void;
}

export async function runRepair(args: RepairArgs, deps: RunRepairDeps = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const bootstrap = deps.bootstrap ?? bootstrapUpstream;
  const loadConfig = deps.loadConfig ?? loadResolvedConfig;
  const loadLlmProvider = deps.buildLlmProvider ?? buildLlmProvider;
  const doRepairFiles = deps.repairLlmFailures ?? repairLlmFailures;
  const doRepairGraph = deps.repairLlmGraphFailures ?? repairLlmGraphFailures;
  const resolveCtx = deps.resolveProjectContext ?? resolveProjectContext;

  const ctx = resolveCtx(args.projectId);
  const projectRoot = ctx.repoPath;
  const stateRoot = ctx.stateRoot;
  const config = loadConfig({
    ...args,
    config: args.config ?? ctx.deployConfigPath,
    configExplicit: Boolean(args.config),
  }, {
    cwd: process.cwd(),
    env: process.env,
  });

  const upstream = await bootstrap({ pluginRoot: args.pluginRoot });

  if (args.action === "llm-graph-failures") {
    const provider = args.dryRun
      ? undefined
      : await loadLlmProvider({
          enabled: true,
          packageName: args.llmProvider ?? config.providers?.llm?.package ?? null,
          config,
        });
    const result = await doRepairGraph({
      core: upstream.core,
      projectRoot,
      stateRoot,
      dryRun: args.dryRun,
      llm: { provider, required: false },
      log,
    });
    log(
      JSON.stringify({
        command: result.command,
        status: result.status,
        applied: result.stats?.applied ?? 0,
        failed: result.stats?.failed ?? 0,
        nodesMissingSummary: result.gaps.nodesMissingSummary,
        missingLayers: result.gaps.missingLayers,
        missingProjectSummary: result.gaps.missingProjectSummary,
        reportPath: result.reportPath,
      }),
    );
    exit(0);
    return;
  }

  // llm-failures: dry-run plans without a provider; otherwise fail fast.
  const provider = args.dryRun
    ? undefined
    : await loadLlmProvider({
        enabled: true,
        packageName: args.llmProvider ?? config.providers?.llm?.package ?? null,
        config,
      });

  const result = await doRepairFiles({
    core: upstream.core,
    projectRoot,
    stateRoot,
    dryRun: args.dryRun,
    maxTasks: args.maxTasks ?? undefined,
    llm: { provider, required: false },
    log,
  });

  log(
    JSON.stringify({
      command: result.command,
      dryRun: result.dryRun,
      requested: result.requested,
      attempted: result.attempted,
      repaired: result.repaired,
      stillFailed: result.stillFailed,
      batchesPatched: result.batchesPatched.length,
      reportPath: result.reportPath,
    }),
  );
  exit(result.stillFailed > 0 ? 1 : 0);
}
