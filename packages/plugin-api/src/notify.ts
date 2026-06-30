/**
 * Notify provider — sink for nightly aggregate summaries.
 *
 * SPI-only: `@understand-anyway/plugin-api` keeps zero `node:*` imports so the
 * package can be consumed from any runtime. The default open-source filesystem
 * implementation (`LocalFileNotifyProvider`) ships in
 * `@understand-anyway/gateway`; external delivery (chat / IM / email) lives in
 * separate provider packages implementing this same `NotifyProvider` interface.
 */

/** Per-project failure detail in a nightly report. */
export interface NightlyFailure {
  project: string;
  reason: string;
  logPath?: string;
}

/** Aggregate counters mirrored on the nightly summary card. */
export interface NightlyTotals {
  success: number;
  skipped: number;
  failed: number;
}

/**
 * Nightly aggregate report passed to a NotifyProvider. Field shape mirrors what
 * `aggregate-nightly.mjs` writes to `aggregate/nightly-latest.json` so callers
 * can pass that file's parsed contents straight in.
 */
export interface NightlyReport {
  runId: string;
  overallStatus: "success" | "partial_success" | "failed" | "missing" | string;
  generatedAt: string;
  projectsRoot: string;
  success: string[];
  skipped: string[];
  failed: NightlyFailure[];
  totals: NightlyTotals;
  /** Free-form trailing fields (e.g. report path, gateway version id). */
  extras?: Record<string, unknown>;
}

/** Options every NotifyProvider call accepts. */
export interface NotifyOptions {
  /** When true, providers describe what they would send without acting on it. */
  dryRun?: boolean;
}

/** Result returned from a single send. */
export interface NotifyResult {
  delivered: boolean;
  /** True when the provider intentionally did nothing (noop / dry-run). */
  skipped?: boolean;
  /** Human-readable target identifier (path, channel, recipient). */
  target?: string;
  /** Provider-specific error string for non-fatal delivery failures. */
  error?: string;
}

export interface NotifyProvider {
  readonly name: string;
  sendNightlySummary(report: NightlyReport, options?: NotifyOptions): Promise<NotifyResult>;
}

export class NoopNotifyProvider implements NotifyProvider {
  readonly name = "noop";
  async sendNightlySummary(_report: NightlyReport, _options: NotifyOptions = {}): Promise<NotifyResult> {
    return { delivered: false, skipped: true };
  }
}
