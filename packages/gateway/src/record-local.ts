/**
 * Open-source default record sink: appends each envelope as one NDJSON line to
 * a per-kind file under the configured runtime root. Zero external dependency.
 *
 * External data-system sinks (Feishu/Google sheets) implement the same
 * {@link RecordProvider} interface in their own packages and are opt-in.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RecordEnvelope, RecordKind, RecordProvider } from "@understand-anyway/plugin-api";

const KIND_FILES: Record<string, string> = {
  "user-event": "portal-analytics.ndjson",
  "nightly-update": "nightly-events.ndjson",
  "project-update": "project-events.ndjson",
  "system-config": "system-config.ndjson",
};

function fileForKind(kind: RecordKind): string {
  return KIND_FILES[kind] ?? "records.ndjson";
}

export interface LocalFileRecordProviderOptions {
  /** Directory the NDJSON files are written under. Created on demand. */
  runtimeRoot: string;
  log?: (message: string) => void;
}

export class LocalFileRecordProvider implements RecordProvider {
  readonly name = "local-file";
  private readonly runtimeRoot: string;
  private readonly log: (message: string) => void;

  constructor(options: LocalFileRecordProviderOptions) {
    this.runtimeRoot = options.runtimeRoot;
    this.log = options.log ?? (() => {});
  }

  async write(record: RecordEnvelope): Promise<void> {
    try {
      mkdirSync(this.runtimeRoot, { recursive: true });
      const filePath = resolve(this.runtimeRoot, fileForKind(record.kind));
      appendFileSync(filePath, `${JSON.stringify(record)}\n`);
    } catch (err) {
      this.log(`record-local write failed: ${(err as Error).message}`);
    }
  }
}
