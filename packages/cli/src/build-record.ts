/**
 * Assembles the gateway record sink from the resolved deploy config + flags.
 *
 * Open-source default is no recording: when no providers are requested this
 * returns `undefined` and the gateway falls back to NoopRecordProvider. The
 * local NDJSON sink is dependency-free; the Feishu Sheets sink is opt-in and
 * loaded lazily via dynamic import so users who never enable it don't pay
 * the install / load cost. `record.config.feishu-sheets` drives its runtime
 * options; the provider owns standard worksheet headers so deployments only
 * need token/worksheet wiring by default.
 *
 * The effective provider list is `--record-provider` when given, else
 * `record.providers` from the config (layer 1 flag override of layers 3/4).
 */

import type { RecordProvider, RecordSection } from "@understand-anyway/plugin-api";
import { CompositeRecordProvider, LocalFileRecordProvider } from "@understand-anyway/gateway";
import { ArgsError, type RecordProviderName, type ServeArgs } from "./args.js";

const VALID_RECORD_PROVIDERS: readonly RecordProviderName[] = ["local", "feishu-sheets"];
const FEISHU_SHEETS_PACKAGE = "@understand-anyway/provider-feishu-sheets";

interface LocalRecordConfig {
  runtimeRoot?: string;
}

/** Loose shape of the Feishu Sheets record provider config; full schema lives
 *  inside the optional `@understand-anyway/provider-feishu-sheets` package and
 *  is intentionally not imported eagerly. */
interface FeishuSheetsRecordConfig {
  spreadsheetToken?: string;
  mappings?: unknown;
  [key: string]: unknown;
}

export interface BuildRecordProviderDeps {
  /** State root, used as the default local NDJSON root. */
  stateRoot: string;
  /** Resolved record section from the deploy config. */
  record?: RecordSection;
  log?: (message: string) => void;
}

function resolveProviderNames(args: ServeArgs, record: RecordSection): RecordProviderName[] {
  const raw = args.recordProviders.length > 0 ? args.recordProviders : record.providers ?? [];
  for (const name of raw) {
    if (!VALID_RECORD_PROVIDERS.includes(name as RecordProviderName)) {
      throw new ArgsError(
        `invalid record provider: ${name} (expected one of ${VALID_RECORD_PROVIDERS.join(", ")})`,
      );
    }
  }
  return raw as RecordProviderName[];
}

async function loadFeishuSheetsProvider(): Promise<new (options: unknown) => RecordProvider> {
  try {
    const mod = (await import(FEISHU_SHEETS_PACKAGE)) as {
      FeishuSheetsRecordProvider?: new (options: unknown) => RecordProvider;
    };
    if (!mod.FeishuSheetsRecordProvider) {
      throw new ArgsError(
        `record provider 'feishu-sheets': loaded ${FEISHU_SHEETS_PACKAGE} does not export FeishuSheetsRecordProvider`,
      );
    }
    return mod.FeishuSheetsRecordProvider;
  } catch (err) {
    if (err instanceof ArgsError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ArgsError(
      `record provider 'feishu-sheets' requires '${FEISHU_SHEETS_PACKAGE}' to be installed: ${reason}`,
    );
  }
}

async function buildOne(
  name: RecordProviderName,
  record: RecordSection,
  deps: BuildRecordProviderDeps,
): Promise<RecordProvider> {
  const log = deps.log;
  const config = record.config ?? {};
  if (name === "local") {
    const local = config.local as LocalRecordConfig | undefined;
    return new LocalFileRecordProvider({
      runtimeRoot: local?.runtimeRoot ?? deps.stateRoot,
      log,
    });
  }
  const sheets = config["feishu-sheets"] as FeishuSheetsRecordConfig | undefined;
  if (!sheets || !sheets.spreadsheetToken) {
    throw new ArgsError(
      "record provider 'feishu-sheets' requires config record.config.feishu-sheets.spreadsheetToken",
    );
  }
  const FeishuSheetsRecordProvider = await loadFeishuSheetsProvider();
  return new FeishuSheetsRecordProvider({ ...sheets, log });
}

export async function buildRecordProvider(
  args: ServeArgs,
  deps: BuildRecordProviderDeps,
): Promise<RecordProvider | undefined> {
  const record = deps.record ?? {};
  const names = resolveProviderNames(args, record);
  if (names.length === 0) return undefined;

  const providers: RecordProvider[] = [];
  for (const name of names) {
    providers.push(await buildOne(name, record, deps));
  }
  if (providers.length === 1) return providers[0]!;
  return new CompositeRecordProvider(providers, { log: deps.log });
}
