/**
 * Record provider — sink for nightly/project/user-event records.
 *
 * Open-source default {@link LocalFileRecordProvider} writes JSON/NDJSON to the
 * local state dir. Optional external sinks may live in standalone open-source
 * packages (for example `@understand-anyway/provider-feishu-sheets`) or in a
 * private overlay, and are wired in via `--record-provider`.
 */

/**
 * Well-known record kinds. The set is intentionally open: providers may emit or
 * accept additional kinds without a contract change (e.g. future event types),
 * hence the `(string & {})` escape hatch.
 */
export type WellKnownRecordKind =
  | "user-event"
  | "nightly-update"
  | "project-update"
  | "system-config";

// eslint-disable-next-line @typescript-eslint/ban-types
export type RecordKind = WellKnownRecordKind | (string & {});

export interface RecordEnvelope {
  kind: RecordKind;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface RecordProvider {
  readonly name: string;
  write(record: RecordEnvelope): Promise<void>;
}

/**
 * Placeholder local sink. The concrete fs-backed implementation lives in the
 * gateway/cli packages where the state-dir layout is known; this interface and
 * a no-write default keep plugin-api dependency-free.
 */
export class NoopRecordProvider implements RecordProvider {
  readonly name = "noop";
  async write(): Promise<void> {
    /* intentionally no-op */
  }
}
