import type { RecordEnvelope, RecordKind, RecordProvider } from "@understand-anyway/plugin-api";
import { FeishuSheetsClient, type FeishuSheetsClientOptions } from "./feishu-sheets-client.js";

/**
 * Per-kind worksheet mapping. `columns` seeds the header row only when the
 * sheet is blank; once a worksheet already has a schema, rows are aligned to
 * that live header instead. Missing fields render as empty cells.
 */
export interface SheetKindMapping {
  /** Worksheet title within the spreadsheet. */
  worksheet?: string;
  /** Ordered payload keys for initializing a blank sheet's header row. */
  columns?: string[];
  /**
   * Explicit source-path overrides keyed by the on-sheet header column name.
   * Used to keep writing into historical schemas after field renames.
   */
  aliases?: Partial<Record<string, string | string[]>>;
}

interface ResolvedSheetKindMapping {
  worksheet: string;
  columns: string[];
  aliases?: SheetKindMapping["aliases"];
}

export interface FeishuSheetsRecordProviderOptions extends FeishuSheetsClientOptions {
  /** Spreadsheet token (document id) the worksheets live in. */
  spreadsheetToken: string;
  /**
   * Optional worksheet title overrides. For the three built-in record kinds,
   * omitted values default to the record kind itself.
   */
  worksheets?: Partial<Record<RecordKind | "nightly" | "project", string>>;
  /**
   * Optional worksheet + column mapping per record kind. Built-in record kinds
   * are provided by default; custom kinds without a mapping are skipped.
   */
  mappings?: Partial<Record<RecordKind, SheetKindMapping>>;
  log?: (message: string) => void;
}

export const USER_EVENT_COLUMNS = [
  "eventId",
  "eventTime",
  "eventType",
  "sessionId",
  "userName",
  "userEnName",
  "openId",
  "email",
  "authReason",
  "departmentPaths",
  "sourceIp",
  "userAgent",
  "targetType",
  "targetId",
  "targetName",
  "targetUrl",
  "extra",
] as const;

export const NIGHTLY_UPDATE_COLUMNS = [
  "runId",
  "startedAt",
  "finishedAt",
  "overallStatus",
  "projectCount",
  "successCount",
  "failedCount",
  "buildSuccessCount",
  "recordProvider",
  "recordStatus",
  "resultJson",
] as const;

export const PROJECT_UPDATE_COLUMNS = [
  "runId",
  "startedAt",
  "finishedAt",
  "project",
  "repoPath",
  "stateDir",
  "overallStatus",
  "buildStatus",
  "gateStatus",
  "gateApproved",
  "gateFailureReason",
  "criticalCount",
  "warningCount",
  "needsManualIntervention",
  "commitBefore",
  "commitAfter",
  "nodeCount",
  "edgeCount",
  "containsEdges",
  "importsEdges",
  "callsEdges",
  "fileNodeCount",
  "missingFileCount",
  "moduleStatus",
  "llmEnabled",
  "llmStatus",
  "llmProvider",
  "llmModel",
  "llmRequests",
  "llmTasks",
  "llmProcessedTasks",
  "llmFailures",
  "llmTimeouts",
  "llmCandidateFiles",
  "llmProcessedFiles",
  "llmBreakerTripped",
  "llmEnrichedNodes",
  "resultJson",
  "buildLog",
  "gateJson",
  "gateLog",
] as const;

const DEFAULT_COLUMNS: Partial<Record<RecordKind, readonly string[]>> = {
  "user-event": USER_EVENT_COLUMNS,
  "nightly-update": NIGHTLY_UPDATE_COLUMNS,
  "project-update": PROJECT_UPDATE_COLUMNS,
};

function resolvePath(payload: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return payload[path];
  let cursor: unknown = payload;
  for (const segment of path.split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function renderCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const BUILTIN_HEADER_ALIASES: Partial<Record<RecordKind, Record<string, string[]>>> = {
  "user-event": {
    timestamp: ["eventTime", "timestamp"],
    userName: ["displayName"],
    userEnName: ["raw.en_name", "raw.enName", "raw.name_en"],
    openId: ["raw.open_id", "raw.openId", "raw.user_id", "userId"],
    authReason: ["authReason", "extra.authReason", "extra.reason", "raw.authReason"],
    departmentPaths: ["departmentPaths", "raw.departmentPaths"],
    sessionId: ["sessionId", "raw.sessionId"],
  },
  "nightly-update": {
    timestamp: ["finishedAt", "timestamp"],
    aggregateStatus: ["overallStatus"],
    projectsCount: ["projectCount"],
  },
  "project-update": {
    timestamp: ["finishedAt", "timestamp"],
    projectId: ["projectName"],
    aggregateStatus: ["overallStatus"],
    commit: ["git.commitAfter"],
    "llm.providerName": ["llm.provider"],
  },
};

function resolveEnvelopePath(record: RecordEnvelope, path: string): unknown {
  if (path === "timestamp") return record.timestamp;
  if (path === "kind") return record.kind;
  return resolvePath(record.payload, path);
}

function normalizeAliases(
  aliases: SheetKindMapping["aliases"] | undefined,
): Record<string, string[]> {
  if (!aliases) return {};
  const normalized: Record<string, string[]> = {};
  for (const [header, source] of Object.entries(aliases)) {
    const paths = (Array.isArray(source) ? source.map(String) : [String(source)])
      .map((item) => item.trim())
      .filter(Boolean);
    if (paths.length > 0) normalized[header] = paths;
  }
  return normalized;
}

function mergeAliases(kind: RecordKind, mapping: ResolvedSheetKindMapping): Record<string, string[]> {
  return {
    ...(BUILTIN_HEADER_ALIASES[kind] ?? {}),
    ...normalizeAliases(mapping.aliases),
  };
}

function renderDepartmentPaths(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return renderCell(value);
  const rendered = value.map((entry) => {
    if (Array.isArray(entry)) {
      return entry.map((segment) => String(segment ?? "").trim()).filter(Boolean).join(" > ");
    }
    return String(entry ?? "").trim();
  }).filter(Boolean);
  return rendered.join(" | ");
}

function renderColumnCell(column: string, value: unknown): string {
  if (column === "departmentPaths") return renderDepartmentPaths(value);
  return renderCell(value);
}

function buildRow(record: RecordEnvelope, header: readonly string[], mapping: ResolvedSheetKindMapping): string[] {
  const aliases = mergeAliases(record.kind, mapping);
  return header.map((column) => {
    const candidates = [...(aliases[column] ?? []), column];
    for (const candidate of candidates) {
      const value = resolveEnvelopePath(record, candidate);
      if (value !== undefined) return renderColumnCell(column, value);
    }
    return "";
  });
}

function resolveWorksheetOverride(
  kind: RecordKind,
  worksheets: FeishuSheetsRecordProviderOptions["worksheets"],
): string | undefined {
  if (!worksheets) return undefined;
  const direct = worksheets[kind];
  if (direct) return direct;
  if (kind === "nightly-update") return worksheets.nightly;
  if (kind === "project-update") return worksheets.project;
  return undefined;
}

function resolveMappings(options: FeishuSheetsRecordProviderOptions): Map<RecordKind, ResolvedSheetKindMapping> {
  const configured = options.mappings ?? {};
  const kinds = new Set<RecordKind>([
    "user-event",
    "nightly-update",
    "project-update",
    ...Object.keys(configured),
  ] as RecordKind[]);
  const resolved = new Map<RecordKind, ResolvedSheetKindMapping>();
  for (const kind of kinds) {
    const mapping = configured[kind];
    const defaultColumns = DEFAULT_COLUMNS[kind];
    const columns = Array.isArray(mapping?.columns) && mapping.columns.length > 0
      ? mapping.columns.map(String)
      : defaultColumns
        ? [...defaultColumns]
        : undefined;
    if (!columns) continue;
    resolved.set(kind, {
      worksheet: String(mapping?.worksheet || resolveWorksheetOverride(kind, options.worksheets) || kind),
      columns,
      aliases: mapping?.aliases,
    });
  }
  return resolved;
}

export class FeishuSheetsRecordProvider implements RecordProvider {
  readonly name = "feishu-sheets";
  private readonly client: FeishuSheetsClient;
  private readonly spreadsheetToken: string;
  private readonly mappings: Map<RecordKind, ResolvedSheetKindMapping>;
  private readonly log: (message: string) => void;

  constructor(options: FeishuSheetsRecordProviderOptions) {
    if (!options.spreadsheetToken) throw new Error("FeishuSheetsRecordProvider requires spreadsheetToken");
    this.client = new FeishuSheetsClient(options);
    this.spreadsheetToken = options.spreadsheetToken;
    this.mappings = resolveMappings(options);
    this.log = options.log ?? (() => {});
  }

  async write(record: RecordEnvelope): Promise<void> {
    const mapping = this.mappings.get(record.kind);
    if (!mapping) return;
    try {
      const worksheet = await this.client.ensureWorksheet(this.spreadsheetToken, mapping.worksheet);
      const header = await this.client.ensureHeader(this.spreadsheetToken, worksheet.sheetId, mapping.columns);
      const row = buildRow(record, header, mapping);
      await this.client.appendRow(this.spreadsheetToken, worksheet.sheetId, row);
    } catch (err) {
      this.log(`feishu-sheets record write failed (${record.kind}): ${(err as Error).message}`);
    }
  }
}
