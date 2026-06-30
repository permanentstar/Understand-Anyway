/**
 * `notify` subcommand dispatcher. Reads a structured nightly aggregate report
 * from disk, hands it to the configured NotifyProvider, and prints a one-line
 * JSON summary on stdout. Used as the best-effort tail step in
 * `scripts/daily-update.sh`.
 *
 *   notify nightly --report <file>            (default: LocalFileNotifyProvider)
 *   notify nightly --report <file> --notify-provider <pkg>
 *   notify nightly --report <file> --dry-run  (prints what would be sent)
 *   notify nightly --report <file> --best-effort
 *
 * The open-source default writes the report to
 * `<projectsRoot>/notifications/<run-id>.json`. External delivery (chat / IM)
 * is opt-in via `--notify-provider` or `providers.notify` in the YAML config —
 * the OSS core never imports a vendor SDK.
 */

import { mkdir, readFile as nodeReadFile, writeFile } from "node:fs/promises";
import {
  PROVIDER_FACTORY_EXPORTS,
  type NightlyReport,
  type NotifyProvider,
  type NotifyProviderFactory,
  type ResolvedConfig,
} from "@understand-anyway/plugin-api";
import {
  LocalFileNotifyProvider,
  type LocalFileNotifyProviderDeps,
} from "@understand-anyway/gateway";
import type { NotifyArgs } from "../args.js";
import { ArgsError } from "../args.js";
import { loadResolvedConfig } from "../config/load.js";

export interface RunNotifyDeps {
  loadConfig?: typeof loadResolvedConfig;
  /** Read + parse the aggregate report JSON. Injectable for tests. */
  readReport?: (path: string) => Promise<NightlyReport>;
  /** Filesystem deps forwarded to the default LocalFileNotifyProvider. */
  fsDeps?: LocalFileNotifyProviderDeps;
  /** Dynamic module loader (only used when --notify-provider is set). */
  importModule?: (pkg: string) => Promise<Record<string, unknown>>;
  log?: (message: string) => void;
  exit?: (code: number) => void;
}

const defaultReadReport = async (path: string): Promise<NightlyReport> => {
  const raw = await nodeReadFile(path, "utf8");
  return JSON.parse(raw) as NightlyReport;
};

const defaultImportModule = (pkg: string): Promise<Record<string, unknown>> =>
  import(pkg) as Promise<Record<string, unknown>>;

async function loadProvider(
  args: NotifyArgs,
  config: ResolvedConfig,
  deps: RunNotifyDeps,
): Promise<NotifyProvider> {
  const packageName = args.provider ?? config.providers?.notify?.package ?? null;
  if (!packageName) {
    const fsDeps: LocalFileNotifyProviderDeps = deps.fsDeps ?? {
      writeFile: async (path, data, encoding) => { await writeFile(path, data, encoding); },
      mkdir: async (path, options) => { await mkdir(path, options); },
    };
    return new LocalFileNotifyProvider(fsDeps);
  }
  const importModule = deps.importModule ?? defaultImportModule;
  let mod: Record<string, unknown>;
  try {
    mod = await importModule(packageName);
  } catch (err) {
    throw new ArgsError(`failed to load notify provider package '${packageName}': ${(err as Error).message}`);
  }
  const factory = mod[PROVIDER_FACTORY_EXPORTS.notify];
  if (typeof factory !== "function") {
    throw new ArgsError(
      `notify provider package '${packageName}' does not export ${PROVIDER_FACTORY_EXPORTS.notify}()`,
    );
  }
  return (factory as NotifyProviderFactory)(config.providers?.notify?.config ?? {});
}

export async function runNotify(args: NotifyArgs, deps: RunNotifyDeps = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const loadConfig = deps.loadConfig ?? loadResolvedConfig;
  const readReport = deps.readReport ?? defaultReadReport;

  const config = loadConfig(args, { cwd: process.cwd(), env: process.env });
  const report = await readReport(args.report);
  const provider = await loadProvider(args, config, deps);

  try {
    const result = await provider.sendNightlySummary(report, { dryRun: args.dryRun });
    log(
      JSON.stringify({
        provider: provider.name,
        delivered: result.delivered,
        skipped: result.skipped ?? false,
        target: result.target ?? null,
        error: result.error ?? null,
      }),
    );
    const failed = !result.delivered && !result.skipped;
    exit(failed && !args.bestEffort ? 1 : 0);
  } catch (err) {
    const message = (err as Error).message;
    log(
      JSON.stringify({
        provider: provider.name,
        delivered: false,
        skipped: false,
        target: null,
        error: message,
      }),
    );
    exit(args.bestEffort ? 0 : 1);
  }
}
