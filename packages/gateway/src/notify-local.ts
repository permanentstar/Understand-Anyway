/**
 * Default local-file notify provider.
 *
 * Lives in `@understand-anyway/gateway` so the SPI package
 * `@understand-anyway/plugin-api` stays free of `node:*` imports and runtime
 * filesystem behavior. Mirrors the pattern used for {@link LocalFileRecordProvider}.
 *
 * Persists each nightly report to disk under
 * `<projectsRoot>/notifications/<run-id>.json`; the directory is created on
 * demand so first-time callers don't need to provision it.
 */

import { dirname, resolve } from "node:path";
import type {
  NightlyReport,
  NotifyOptions,
  NotifyProvider,
  NotifyResult,
} from "@understand-anyway/plugin-api";

export interface LocalFileNotifyProviderDeps {
  writeFile: (path: string, data: string, encoding?: BufferEncoding) => Promise<void>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  now?: () => Date;
}

/**
 * `runId` falls back to `notify-<unix-ms>` (matching the run-id convention in
 * `core/build/repair.ts`) when the report does not carry one.
 */
export class LocalFileNotifyProvider implements NotifyProvider {
  readonly name = "local-file";
  private readonly deps: LocalFileNotifyProviderDeps;

  constructor(deps: LocalFileNotifyProviderDeps) {
    this.deps = deps;
  }

  async sendNightlySummary(
    report: NightlyReport,
    options: NotifyOptions = {},
  ): Promise<NotifyResult> {
    if (!report.projectsRoot) {
      throw new Error("LocalFileNotifyProvider: report.projectsRoot is required");
    }
    const now = this.deps.now ?? (() => new Date());
    const runId = report.runId && report.runId.length > 0 ? report.runId : `notify-${now().getTime()}`;
    const target = resolve(report.projectsRoot, "notifications", `${runId}.json`);
    if (options.dryRun) {
      return { delivered: false, skipped: true, target };
    }
    await this.deps.mkdir(dirname(target), { recursive: true });
    await this.deps.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { delivered: true, target };
  }
}
