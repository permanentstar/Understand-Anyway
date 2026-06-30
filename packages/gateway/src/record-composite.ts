/**
 * Fans a record envelope out to several {@link RecordProvider}s (e.g. a local
 * NDJSON sink plus an external sheet sink). Each child write is awaited
 * independently; one failing sink never blocks the others.
 */

import type { RecordEnvelope, RecordProvider } from "@understand-anyway/plugin-api";

export interface CompositeRecordProviderOptions {
  log?: (message: string) => void;
}

export class CompositeRecordProvider implements RecordProvider {
  readonly name = "composite";
  private readonly providers: RecordProvider[];
  private readonly log: (message: string) => void;

  constructor(providers: RecordProvider[], options: CompositeRecordProviderOptions = {}) {
    this.providers = providers;
    this.log = options.log ?? (() => {});
  }

  async write(record: RecordEnvelope): Promise<void> {
    await Promise.all(
      this.providers.map((provider) =>
        provider.write(record).catch((err) => {
          this.log(`composite record write failed (${provider.name}): ${(err as Error).message}`);
        }),
      ),
    );
  }
}
