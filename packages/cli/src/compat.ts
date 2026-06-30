/**
 * `compat` command: upstream schema drift probe.
 *
 * Bootstraps the installed upstream plugin, extracts its current schema
 * fingerprint, and diffs it against the committed `compat.json` baseline.
 * `--update` instead prints a fresh baseline extracted from the live upstream
 * (used to regenerate `compat.json` after a verified upstream bump).
 *
 * Exit semantics: fatal drift exits non-zero so CI / nightly can gate on it;
 * warnings (added enum values / new optional fields) are surfaced but pass.
 */

import {
  buildBaseline,
  runCompatCheck,
  type CompatBaseline,
  type CompatReport,
} from "@understand-anyway/core";
import type { CompatArgs } from "./args.js";

export interface RunCompatDeps {
  check?: typeof runCompatCheck;
  build?: typeof buildBaseline;
}

export interface RunCompatOptions {
  log?: (message: string) => void;
  deps?: RunCompatDeps;
}

export interface RunCompatResult {
  ok: boolean;
  report?: CompatReport;
  baseline?: CompatBaseline;
}

function renderReport(report: CompatReport, log: (message: string) => void): void {
  log(`upstream plugin: ${report.pluginRoot}`);
  log(`installed version: ${report.installedVersion ?? "unknown"} (baseline verified: ${report.verifiedVersion})`);
  if (!report.versionMatch) {
    log(`note: installed upstream version differs from the verified baseline version`);
  }
  log(`node types: ${report.current.nodeTypes.length}, edge types: ${report.current.edgeTypes.length}`);

  if (report.diff.warnings.length > 0) {
    log(`warnings (${report.diff.warnings.length}):`);
    for (const change of report.diff.warnings) log(`  - ${change.detail}`);
  }
  if (report.diff.fatal.length > 0) {
    log(`fatal drift (${report.diff.fatal.length}):`);
    for (const change of report.diff.fatal) log(`  ! ${change.detail}`);
  }
  log(report.ok ? "compat: OK" : "compat: FATAL schema drift detected");
}

export async function runCompat(args: CompatArgs, options: RunCompatOptions = {}): Promise<RunCompatResult> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const check = options.deps?.check ?? runCompatCheck;
  const build = options.deps?.build ?? buildBaseline;

  if (args.update) {
    const baseline = await build({ pluginRoot: args.pluginRoot });
    if (args.json) {
      log(JSON.stringify(baseline, null, 2));
    } else {
      log(`baseline extracted from upstream ${baseline.verifiedUpstreamVersion}`);
      log(JSON.stringify(baseline, null, 2));
    }
    return { ok: true, baseline };
  }

  const report = await check({ pluginRoot: args.pluginRoot });
  if (args.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    renderReport(report, log);
  }
  return { ok: report.ok, report };
}
