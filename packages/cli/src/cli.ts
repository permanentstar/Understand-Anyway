#!/usr/bin/env node
/**
 * understand-anyway CLI entry.
 *
 * Implemented commands:
 *   build                   deterministic full-build of a repo's knowledge graph
 *   compat                  upstream schema drift probe against the committed baseline
 *   serve                   start the read-only gateway against a pre-built state dir
 *   batch-mapper-worker     (internal, hidden) child entry spawned by the segmented
 *                           mapper scheduler — not stable, not part of the public CLI
 */

import { ArgsError, helpText, parseArgs, parseServeDaemonArgs } from "./args.js";
import { runBuild } from "./build.js";
import { runCompat } from "./compat.js";
import { runInit } from "./init.js";
import { runServe } from "./serve.js";
import { parseWorkerArgs, runBatchMapperWorker } from "./batch-mapper-worker.js";
import { buildLlmProvider } from "./build-llm.js";
import { runDashboard } from "./dashboard-prod/index.js";
import { runDashboardServer } from "./dashboard-prod/dashboard-server.js";
import { DASHBOARD_SERVER_SUBCOMMAND } from "./dashboard-prod/dashboard-start.js";
import { runGateway } from "./gateway/index.js";
import { runProjectState } from "./gateway/project-state.js";
import { runReviewGraphHealth } from "./review/run-graph-health-review.js";
import { runReviewHookCli } from "./review/run-review-hook.js";
import { runRepair } from "./repair/index.js";
import { runNotify } from "./notify/index.js";
import { runOpsScript } from "./ops/run-ops-script.js";
import { loadResolvedConfig } from "./config/load.js";
import { installParentSignalReaper } from "@understand-anyway/core";

/** Absolute path of this CLI entry, exposed so build.ts and dashboard-prod can
 *  hand it to spawned children. Re-exported from `cli-entry.ts` to keep the
 *  symbol stable while avoiding cycles with subcommand dispatchers. */
export { CLI_ENTRY } from "./cli-entry.js";

async function main(argv: string[]): Promise<void> {
  // Ops orchestration passthrough. `ops <name> [args...]` runs a bundled shell
  // script (daily-update / nightly-project-sync / refresh-prod-server) whose
  // argv shape is deliberately outside the structured parser — args are
  // forwarded verbatim to the script.
  if (argv[0] === "ops") {
    const name = argv[1] ?? "";
    if (!name || name === "--help" || name === "-h") {
      process.stdout.write("usage: understand-anyway ops <daily-update|nightly-project-sync|refresh-prod-server> [args...]\n");
      process.exit(name ? 0 : 2);
    }
    const code = runOpsScript(name, argv.slice(2));
    process.exit(code);
  }

  // Hidden subcommand for the spawned worker. Handled before the public
  // parser so its argv shape (very different from `build`) stays isolated.
  if (argv[0] === "batch-mapper-worker") {
    try {
      const workerArgs = parseWorkerArgs(argv.slice(1));
      const log = (line: string) => process.stdout.write(`${line}\n`);
      await runBatchMapperWorker(workerArgs, log, {
        loadLlmProvider: async (packageName, configPath) => {
          // Reuse the public CLI loader so the worker honours the same
          // ProviderRegistry contract as the parent.
          const config = loadResolvedConfig({ config: configPath, configExplicit: Boolean(configPath) }, {
            cwd: process.cwd(),
            env: process.env,
          });
          const provider = await buildLlmProvider({ enabled: true, packageName, config });
          return provider;
        },
      });
      return;
    } catch (err) {
      if (err instanceof ArgsError) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
  }

  // Hidden daemon subcommand spawned by `dashboard start`. It accepts the
  // internal state/dist/token triplet that is deliberately absent from the
  // public `serve` parser.
  if (argv[0] === DASHBOARD_SERVER_SUBCOMMAND) {
    let serveArgs;
    try {
      serveArgs = parseServeDaemonArgs(argv.slice(1));
    } catch (err) {
      if (err instanceof ArgsError) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
    if (serveArgs.command !== "serve") {
      process.stderr.write(`error: dashboard-server expects serve-shaped args\n`);
      process.exit(2);
    }
    await runDashboardServer(serveArgs);
    return;
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgsError) {
      process.stderr.write(`error: ${err.message}\n\n${helpText()}`);
      process.exit(2);
    }
    throw err;
  }

  if (parsed.command === "help") {
    process.stdout.write(helpText());
    return;
  }

  if (parsed.command === "build") {
    // C7 spawns child workers; install the reaper so SIGINT/SIGTERM cleans
    // them up. Other commands have no spawned children to reap.
    installParentSignalReaper();
    await runBuild(parsed);
    return;
  }

  if (parsed.command === "compat") {
    const result = await runCompat(parsed);
    if (!result.ok) process.exit(1);
    return;
  }

  if (parsed.command === "dashboard") {
    if (parsed.action === "dev") {
      // D3-dev: dynamic import keeps dashboard-dev/ deletable without breaking
      // the main pipeline build (an explicit acceptance of D3-dev).
      const { runDashboardDev } = await import("./dashboard-dev/index.js");
      const { resolveProjectContext } = await import("./project-context.js");
      const ctx = resolveProjectContext(parsed.projectId);
      await runDashboardDev({
        command: "dashboard",
        action: "dev",
        stateDir: ctx.stateRoot,
        pluginRoot: parsed.pluginRoot,
        host: parsed.host,
        port: parsed.port,
        noOpen: parsed.noOpen,
      });
      return;
    }
    await runDashboard(parsed);
    return;
  }

  if (parsed.command === "gateway") {
    await runGateway(parsed);
    return;
  }

  if (parsed.command === "project-state") {
    await runProjectState(parsed);
    return;
  }

  if (parsed.command === "review-graph-health") {
    runReviewGraphHealth(parsed);
    return;
  }

  if (parsed.command === "run-review-hook") {
    runReviewHookCli(parsed);
    return;
  }

  if (parsed.command === "repair") {
    await runRepair(parsed);
    return;
  }

  if (parsed.command === "notify") {
    await runNotify(parsed);
    return;
  }

  if (parsed.command === "init") {
    await runInit(parsed);
    return;
  }

  await runServe(parsed);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
