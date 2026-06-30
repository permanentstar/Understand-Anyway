import type { RecordEnvelope, RecordKind, RecordProvider } from "@understand-anyway/plugin-api";
import { FeishuSheetsClient, type FeishuSheetsClientOptions } from "./feishu-sheets-client.js";

/**
 * Per-kind worksheet mapping. `columns` defines both the header row and the
 * field order; each column is a key looked up in the envelope payload (dotted
 * paths supported, e.g. `raw.open_id`). Missing fields render as empty cells.
 */
export interface SheetKindMapping {
  /** Worksheet title within the spreadsheet. */
  worksheet: string;
  /** Ordered payload keys; doubles as the header row. */
  columns: string[];
}

export interface FeishuSheetsRecordProviderOptions extends FeishuSheetsClientOptions {
  /** Spreadsheet token (document id) the worksheets live in. */
  spreadsheetToken: string;
  /** Worksheet + column mapping per record kind. Kinds without a mapping are skipped. */
  mappings: Partial<Record<RecordKind, SheetKindMapping>>;
  log?: (message: string) => void;
}

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

export class FeishuSheetsRecordProvider implements RecordProvider {
  readonly name = "feishu-sheets";
  private readonly client: FeishuSheetsClient;
  private readonly spreadsheetToken: string;
  private readonly mappings: Partial<Record<RecordKind, SheetKindMapping>>;
  private readonly log: (message: string) => void;

  constructor(options: FeishuSheetsRecordProviderOptions) {
    if (!options.spreadsheetToken) throw new Error("FeishuSheetsRecordProvider requires spreadsheetToken");
    this.client = new FeishuSheetsClient(options);
    this.spreadsheetToken = options.spreadsheetToken;
    this.mappings = options.mappings;
    this.log = options.log ?? (() => {});
  }

  async write(record: RecordEnvelope): Promise<void> {
    const mapping = this.mappings[record.kind];
    if (!mapping) return;
    try {
      const worksheet = await this.client.ensureWorksheet(this.spreadsheetToken, mapping.worksheet);
      await this.client.ensureHeader(this.spreadsheetToken, worksheet.sheetId, mapping.columns);
      const row = mapping.columns.map((column) => renderCell(resolvePath(record.payload, column)));
      await this.client.appendRow(this.spreadsheetToken, worksheet.sheetId, row);
    } catch (err) {
      this.log(`feishu-sheets record write failed (${record.kind}): ${(err as Error).message}`);
    }
  }
}
