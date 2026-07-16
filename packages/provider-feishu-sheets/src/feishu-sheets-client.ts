import { readFileSync } from "node:fs";

const DEFAULT_API_ORIGIN = "https://open.feishu.cn";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface FeishuSheetsClientOptions {
  appId: string;
  /** Provide the secret directly, or via `appSecretFile` / `appSecretEnv`. */
  appSecret?: string;
  appSecretFile?: string;
  /** Env var holding the secret; defaults to FEISHU_APP_SECRET. */
  appSecretEnv?: string;
  /** Override the API origin (defaults to the public Feishu endpoint). */
  apiOrigin?: string;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

interface FeishuApiResponse {
  code?: number;
  msg?: string;
  message?: string;
  data?: Record<string, unknown>;
  tenant_access_token?: string;
  expire?: number;
}

interface WorksheetMeta {
  sheetId: string;
  title: string;
}

interface WorksheetHeaderSchema {
  columns: readonly string[];
  lastColumn: string;
}

const HEADER_SCAN_COLUMNS = 256;

function resolveSecret(options: FeishuSheetsClientOptions): string {
  if (options.appSecret) return options.appSecret;
  if (options.appSecretFile) {
    const secret = readFileSync(options.appSecretFile, "utf8").trim();
    if (!secret) throw new Error(`empty Feishu app secret file: ${options.appSecretFile}`);
    return secret;
  }
  const envName = options.appSecretEnv ?? "FEISHU_APP_SECRET";
  const secret = process.env[envName];
  if (!secret) throw new Error(`missing Feishu app secret env: ${envName}`);
  return secret;
}

function pickSheetId(sheet: Record<string, unknown> | null | undefined): string {
  if (!sheet) return "";
  const props = (sheet.properties as Record<string, unknown> | undefined) ?? {};
  return (
    (sheet.sheetId as string) ||
    (sheet.sheet_id as string) ||
    (props.sheetId as string) ||
    (props.sheet_id as string) ||
    ""
  );
}

function pickSheetTitle(sheet: Record<string, unknown> | null | undefined): string {
  if (!sheet) return "";
  const props = (sheet.properties as Record<string, unknown> | undefined) ?? {};
  return (sheet.title as string) || (props.title as string) || "";
}

export class FeishuSheetsClient {
  private readonly options: FeishuSheetsClientOptions;
  private readonly apiOrigin: string;
  private readonly fetchImpl: FetchLike;
  private tokenCache: { value: string; expiresAt: number } | null = null;
  private readonly worksheetCache = new Map<string, WorksheetMeta>();
  private readonly headerSchemaCache = new Map<string, Map<string, WorksheetHeaderSchema>>();

  constructor(options: FeishuSheetsClientOptions) {
    if (!options.appId) throw new Error("FeishuSheetsClient requires appId");
    this.options = options;
    this.apiOrigin = options.apiOrigin ?? DEFAULT_API_ORIGIN;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  }

  private async request(
    pathname: string,
    init: { method?: string; accessToken?: string; query?: Record<string, string>; body?: unknown; errorMessage?: string },
  ): Promise<Record<string, unknown>> {
    const url = new URL(pathname, this.apiOrigin);
    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, value);
      }
    }
    const headers: Record<string, string> = {};
    if (init.accessToken) headers.Authorization = `Bearer ${init.accessToken}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    const response = await this.fetchImpl(url.toString(), {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const payload = (await response.json().catch(() => null)) as FeishuApiResponse | null;
    if (!response.ok || !payload || payload.code !== 0) {
      throw new Error(payload?.msg || payload?.message || init.errorMessage || `Feishu API failed: ${pathname}`);
    }
    return payload.data ?? (payload as Record<string, unknown>);
  }

  async getTenantAccessToken(): Promise<string> {
    const cached = this.tokenCache;
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
    const response = await this.fetchImpl(`${this.apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.options.appId, app_secret: resolveSecret(this.options) }),
    });
    const payload = (await response.json().catch(() => null)) as FeishuApiResponse | null;
    if (!response.ok || !payload || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(payload?.msg || payload?.message || "failed to acquire tenant_access_token");
    }
    this.tokenCache = {
      value: payload.tenant_access_token,
      expiresAt: Date.now() + Math.max(0, Number(payload.expire ?? 0) - 60) * 1000,
    };
    return this.tokenCache.value;
  }

  async ensureWorksheet(spreadsheetToken: string, title: string): Promise<WorksheetMeta> {
    const cacheKey = `${spreadsheetToken}:${title}`;
    const cached = this.worksheetCache.get(cacheKey);
    if (cached) return cached;
    const accessToken = await this.getTenantAccessToken();
    const meta = await this.request(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/metainfo`,
      { accessToken, errorMessage: `failed to fetch sheet metadata: ${spreadsheetToken}` },
    );
    const sheets = Array.isArray(meta.sheets) ? (meta.sheets as Record<string, unknown>[]) : [];
    const existing = sheets.find((sheet) => pickSheetTitle(sheet) === title);
    if (existing && pickSheetId(existing)) {
      const found = { sheetId: pickSheetId(existing), title };
      this.worksheetCache.set(cacheKey, found);
      return found;
    }
    const created = await this.request(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets_batch_update`,
      {
        method: "POST",
        accessToken,
        body: { requests: [{ addSheet: { properties: { title, index: sheets.length } } }] },
        errorMessage: `failed to create worksheet: ${spreadsheetToken}`,
      },
    );
    const replies = Array.isArray(created.replies) ? (created.replies as Record<string, unknown>[]) : [];
    for (const reply of replies) {
      const props = (reply.addSheet as Record<string, unknown> | undefined)?.properties as Record<string, unknown> | undefined;
      const sheetId = pickSheetId(props);
      if (sheetId) {
        const result = { sheetId, title: pickSheetTitle(props) || title };
        this.worksheetCache.set(cacheKey, result);
        return result;
      }
    }
    throw new Error(`worksheet creation returned no sheetId: ${spreadsheetToken}`);
  }

  async ensureHeader(spreadsheetToken: string, sheetId: string, header: string[]): Promise<readonly string[]> {
    const cached = this.getCachedHeaderSchema(spreadsheetToken, sheetId);
    if (cached) return [...cached.columns];
    const accessToken = await this.getTenantAccessToken();
    const readLastCol = columnLetter(Math.max(header.length, HEADER_SCAN_COLUMNS));
    const data = await this.request(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(`${sheetId}!A1:${readLastCol}1`)}`,
      {
        accessToken,
        query: { valueRenderOption: "ToString", dateTimeRenderOption: "FormattedString" },
        errorMessage: `failed to read header range: ${spreadsheetToken}`,
      },
    );
    const valueRange = data.valueRange as { values?: unknown[][] } | undefined;
    const firstRow = normalizeHeaderRow(Array.isArray(valueRange?.values?.[0]) ? valueRange!.values![0]! : []);
    if (firstRow.length > 0) {
      validateHeader(firstRow, spreadsheetToken, sheetId);
      return [...this.cacheHeaderSchema(spreadsheetToken, sheetId, firstRow).columns];
    }
    const initialSchema = buildWorksheetHeaderSchema(header);
    await this.request(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`, {
      method: "PUT",
      accessToken,
      body: { valueRange: { range: `${sheetId}!A1:${initialSchema.lastColumn}1`, values: [header] } },
      errorMessage: `failed to initialize header: ${spreadsheetToken}`,
    });
    return [...this.cacheHeaderSchema(spreadsheetToken, sheetId, header).columns];
  }

  async appendRow(spreadsheetToken: string, sheetId: string, row: string[]): Promise<void> {
    const accessToken = await this.getTenantAccessToken();
    const lastCol = columnLetter(row.length);
    await this.request(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_append`, {
      method: "POST",
      accessToken,
      query: { insertDataOption: "INSERT_ROWS" },
      body: { valueRange: { range: `${sheetId}!A:${lastCol}`, values: [row] } },
      errorMessage: `failed to append row: ${spreadsheetToken}`,
    });
  }

  private getCachedHeaderSchema(
    spreadsheetToken: string,
    sheetId: string,
  ): WorksheetHeaderSchema | undefined {
    return this.headerSchemaCache.get(spreadsheetToken)?.get(sheetId);
  }

  private cacheHeaderSchema(
    spreadsheetToken: string,
    sheetId: string,
    columns: string[],
  ): WorksheetHeaderSchema {
    const schema = buildWorksheetHeaderSchema(columns);
    const workbook = this.headerSchemaCache.get(spreadsheetToken) ?? new Map<string, WorksheetHeaderSchema>();
    workbook.set(sheetId, schema);
    this.headerSchemaCache.set(spreadsheetToken, workbook);
    return schema;
  }
}

/** 1 -> A, 26 -> Z, 27 -> AA. */
export function columnLetter(count: number): string {
  let n = Math.max(1, count);
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function buildWorksheetHeaderSchema(columns: string[]): WorksheetHeaderSchema {
  const snapshot = Object.freeze([...columns]) as readonly string[];
  return {
    columns: snapshot,
    lastColumn: columnLetter(snapshot.length),
  };
}

function normalizeHeaderRow(row: unknown[]): string[] {
  const normalized = row.map((cell) => String(cell ?? "").trim());
  while (normalized.length > 0 && normalized[normalized.length - 1] === "") {
    normalized.pop();
  }
  return normalized;
}

function validateHeader(header: string[], spreadsheetToken: string, sheetId: string): void {
  if (header.some((cell) => cell === "")) {
    throw new Error(`invalid worksheet header (blank column) for ${spreadsheetToken}:${sheetId}`);
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const cell of header) {
    if (seen.has(cell)) duplicates.add(cell);
    seen.add(cell);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `invalid worksheet header (duplicate columns: ${[...duplicates].join(", ")}) for ${spreadsheetToken}:${sheetId}`,
    );
  }
}
