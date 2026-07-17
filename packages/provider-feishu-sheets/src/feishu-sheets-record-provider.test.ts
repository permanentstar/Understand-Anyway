import { describe, expect, it } from "vitest";
import type { RecordEnvelope } from "@understand-anyway/plugin-api";
import { columnLetter, type FetchLike } from "./feishu-sheets-client.js";
import { FeishuSheetsRecordProvider } from "./feishu-sheets-record-provider.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface FakeFeishuOptions {
  sheets?: Array<{ sheetId: string; title: string }>;
  headers?: Record<string, string[]>;
}

function sheetIdFromValuesUrl(url: URL): string {
  const encoded = url.pathname.split("/values/")[1] || "";
  const range = decodeURIComponent(encoded);
  return range.split("!")[0] || "";
}

/**
 * Fake Feishu API: returns tenant token, sheet metadata, configurable headers,
 * and accepts appends. Records every call for assertions.
 */
function fakeFeishu(calls: Call[], options: FakeFeishuOptions = {}): FetchLike {
  const sheets = options.sheets ?? [{ sheetId: "shtUE", title: "user-event" }];
  const headers = options.headers ?? {};
  return async (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const u = new URL(url);
    const respond = (data: unknown) => ({ ok: true, async json() { return { code: 0, data }; } });
    if (u.pathname.endsWith("/tenant_access_token/internal")) {
      return { ok: true, async json() { return { code: 0, tenant_access_token: "t-abc", expire: 7200 }; } };
    }
    if (u.pathname.endsWith("/metainfo")) {
      return respond({ sheets });
    }
    if (u.pathname.includes("/values/") && method === "GET") {
      return respond({ valueRange: { values: [headers[sheetIdFromValuesUrl(u)] ?? []] } });
    }
    if (u.pathname.endsWith("/values") && method === "PUT") {
      return respond({});
    }
    if (u.pathname.endsWith("/values_append")) {
      return respond({});
    }
    if (u.pathname.endsWith("/sheets_batch_update")) {
      return respond({ replies: [{ addSheet: { properties: { sheetId: "shtNEW", title: body.requests[0].addSheet.properties.title } } }] });
    }
    return { ok: false, async json() { return { code: 1, msg: `unexpected ${u.pathname}` }; } };
  };
}

function provider(calls: Call[], overrides: Partial<ConstructorParameters<typeof FeishuSheetsRecordProvider>[0]> = {}): FeishuSheetsRecordProvider {
  return new FeishuSheetsRecordProvider({
    appId: "cli_x",
    appSecret: "secret_x",
    spreadsheetToken: "shtTOKEN",
    fetchImpl: fakeFeishu(calls),
    mappings: {
      "user-event": { worksheet: "user-event", columns: ["eventType", "userId", "raw.open_id"] },
    },
    ...overrides,
  });
}

function envelope(kind: RecordEnvelope["kind"], payload: Record<string, unknown>): RecordEnvelope {
  return { kind, timestamp: new Date().toISOString(), payload };
}

describe("FeishuSheetsRecordProvider", () => {
  it("requires a spreadsheet token", () => {
    expect(() => new FeishuSheetsRecordProvider({ appId: "x", appSecret: "y", spreadsheetToken: "" })).toThrow(/spreadsheetToken/);
  });

  it("uses built-in worksheet names and legacy headers for standard record kinds by default", async () => {
    const calls: Call[] = [];
    const p = new FeishuSheetsRecordProvider({
      appId: "cli_x",
      appSecret: "secret_x",
      spreadsheetToken: "shtTOKEN",
      fetchImpl: fakeFeishu(calls, {
        sheets: [
          { sheetId: "shtUE", title: "user-event" },
          { sheetId: "shtNU", title: "nightly-update" },
          { sheetId: "shtPU", title: "project-update" },
        ],
      }),
    });

    await p.write(envelope("user-event", { eventId: "evt-1", eventType: "login" }));
    await p.write(envelope("nightly-update", { runId: "run-1", overallStatus: "success" }));
    await p.write(envelope("project-update", { runId: "run-1", project: "alpha" }));

    const headerPuts = calls.filter((c) => c.method === "PUT" && c.url.endsWith("/values"));
    expect(headerPuts.map((c) => (c.body as { valueRange: { range: string } }).valueRange.range)).toEqual([
      "shtUE!A1:Q1",
      "shtNU!A1:K1",
      "shtPU!A1:AO1",
    ]);
    expect((headerPuts[0]!.body as { valueRange: { values: string[][] } }).valueRange.values[0]).toEqual([
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
    ]);
    expect((headerPuts[1]!.body as { valueRange: { values: string[][] } }).valueRange.values[0]).toEqual([
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
    ]);
    expect((headerPuts[2]!.body as { valueRange: { values: string[][] } }).valueRange.values[0]).toHaveLength(41);
  });

  it("appends a mapped row resolving dotted payload paths", async () => {
    const calls: Call[] = [];
    await provider(calls).write(envelope("user-event", { eventType: "login", userId: "u1", raw: { open_id: "ou_9" } }));
    const append = calls.find((c) => c.url.includes("/values_append"));
    expect(append).toBeDefined();
    const valueRange = (append!.body as { valueRange: { values: string[][]; range: string } }).valueRange;
    expect(valueRange.values[0]).toEqual(["login", "u1", "ou_9"]);
    expect(valueRange.range).toBe("shtUE!A:C");
  });

  it("writes the header row when the sheet header is empty", async () => {
    const calls: Call[] = [];
    await provider(calls).write(envelope("user-event", { eventType: "x", userId: "u" }));
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/values"));
    expect(put).toBeDefined();
    const valueRange = (put!.body as { valueRange: { values: string[][] } }).valueRange;
    expect(valueRange.values[0]).toEqual(["eventType", "userId", "raw.open_id"]);
  });

  it("preserves an existing header and appends rows aligned to the live schema", async () => {
    const calls: Call[] = [];
    const p = new FeishuSheetsRecordProvider({
      appId: "cli_x",
      appSecret: "secret_x",
      spreadsheetToken: "shtTOKEN",
      fetchImpl: fakeFeishu(calls, {
        headers: {
          shtUE: ["timestamp", "eventType", "userId", "userName", "raw.open_id"],
        },
      }),
      mappings: {
        "user-event": { worksheet: "user-event", columns: ["eventTime", "eventType", "userId", "displayName", "raw.open_id"] },
      },
    });

    await p.write(envelope("user-event", {
      eventTime: "2026-07-14T12:00:00.000Z",
      eventType: "login",
      userId: "u1",
      displayName: "Alice",
      raw: { open_id: "ou_9" },
    }));

    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/values"))).toBe(false);
    const append = calls.find((c) => c.url.includes("/values_append"));
    expect(append).toBeDefined();
    const valueRange = (append!.body as { valueRange: { values: string[][]; range: string } }).valueRange;
    expect(valueRange.range).toBe("shtUE!A:E");
    expect(valueRange.values[0]).toEqual([
      "2026-07-14T12:00:00.000Z",
      "login",
      "u1",
      "Alice",
      "ou_9",
    ]);
  });

  it("supports explicit alias overrides for historical custom headers", async () => {
    const calls: Call[] = [];
    const p = new FeishuSheetsRecordProvider({
      appId: "cli_x",
      appSecret: "secret_x",
      spreadsheetToken: "shtTOKEN",
      fetchImpl: fakeFeishu(calls, {
        headers: {
          shtUE: ["actorName", "eventType"],
        },
      }),
      mappings: {
        "user-event": {
          worksheet: "user-event",
          columns: ["displayName", "eventType"],
          aliases: { actorName: "displayName" },
        },
      },
    });

    await p.write(envelope("user-event", { displayName: "Alice", eventType: "login" }));

    const append = calls.find((c) => c.url.includes("/values_append"));
    expect(append).toBeDefined();
    const valueRange = (append!.body as { valueRange: { values: string[][] } }).valueRange;
    expect(valueRange.values[0]).toEqual(["Alice", "login"]);
  });

  it("maps legacy user-event headers including auth reason and department paths", async () => {
    const calls: Call[] = [];
    const p = new FeishuSheetsRecordProvider({
      appId: "cli_x",
      appSecret: "secret_x",
      spreadsheetToken: "shtTOKEN",
      fetchImpl: fakeFeishu(calls),
      mappings: {
        "user-event": {
          worksheet: "user-event",
          columns: [
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
          ],
        },
      },
    });

    await p.write(envelope("user-event", {
      eventId: "evt-1",
      eventTime: "2026-07-14T12:00:00.000Z",
      eventType: "authz_denied",
      displayName: "苏恒",
      email: "heng.su@example.com",
      sourceIp: "10.0.0.1",
      userAgent: "Chrome",
      targetType: "project",
      targetId: "deer-flow",
      targetName: "deer-flow",
      targetUrl: "/project/deer-flow/",
      extra: { reason: "department_scope_not_authorized" },
      raw: {
        open_id: "ou_1",
        en_name: "Heng Su",
        departmentPaths: [["Data", "数据平台"], ["Data", "数据平台", "计算平台"]],
      },
    }));

    const append = calls.find((c) => c.url.includes("/values_append"));
    expect(append).toBeDefined();
    const valueRange = (append!.body as { valueRange: { values: string[][] } }).valueRange;
    expect(valueRange.values[0]).toEqual([
      "evt-1",
      "2026-07-14T12:00:00.000Z",
      "authz_denied",
      "",
      "苏恒",
      "Heng Su",
      "ou_1",
      "heng.su@example.com",
      "department_scope_not_authorized",
      "Data > 数据平台 | Data > 数据平台 > 计算平台",
      "10.0.0.1",
      "Chrome",
      "project",
      "deer-flow",
      "deer-flow",
      "/project/deer-flow/",
      "{\"reason\":\"department_scope_not_authorized\"}",
    ]);
  });

  it("maps gateway top-level org audit fields into legacy user-event headers", async () => {
    const calls: Call[] = [];
    const p = new FeishuSheetsRecordProvider({
      appId: "cli_x",
      appSecret: "secret_x",
      spreadsheetToken: "shtTOKEN",
      fetchImpl: fakeFeishu(calls),
      mappings: {
        "user-event": {
          worksheet: "user-event",
          columns: ["eventType", "authReason", "departmentPaths", "extra"],
        },
      },
    });

    await p.write(envelope("user-event", {
      eventType: "project_view",
      authReason: "department_exact_match",
      departmentPaths: [["Data", "数据平台", "计算平台"]],
      extra: { reason: "legacy_reason" },
      raw: { open_id: "ou_1" },
    }));

    const append = calls.find((c) => c.url.includes("/values_append"));
    expect(append).toBeDefined();
    const valueRange = (append!.body as { valueRange: { values: string[][] } }).valueRange;
    expect(valueRange.values[0]).toEqual([
      "project_view",
      "department_exact_match",
      "Data > 数据平台 > 计算平台",
      "{\"reason\":\"legacy_reason\"}",
    ]);
  });

  it("skips non-standard kinds without a mapping (no API calls)", async () => {
    const calls: Call[] = [];
    await provider(calls).write(envelope("system-config", { key: "x" }));
    expect(calls).toHaveLength(0);
  });

  it("does not throw on API failure (reports via log)", async () => {
    const messages: string[] = [];
    const failing = new FeishuSheetsRecordProvider({
      appId: "x",
      appSecret: "y",
      spreadsheetToken: "shtTOKEN",
      fetchImpl: async () => ({ ok: false, async json() { return { code: 1, msg: "boom" }; } }),
      mappings: { "user-event": { worksheet: "user-event", columns: ["eventType"] } },
      log: (m) => messages.push(m),
    });
    await expect(failing.write(envelope("user-event", { eventType: "x" }))).resolves.toBeUndefined();
    expect(messages.some((m) => m.includes("feishu-sheets record write failed"))).toBe(true);
  });

  it("creates the worksheet when missing", async () => {
    const calls: Call[] = [];
    const p = new FeishuSheetsRecordProvider({
      appId: "x",
      appSecret: "y",
      spreadsheetToken: "shtTOKEN",
      fetchImpl: fakeFeishu(calls),
      mappings: { "system-config": { worksheet: "system-config", columns: ["key"] } },
    });
    await p.write(envelope("system-config", { key: "v" }));
    const create = calls.find((c) => c.url.endsWith("/sheets_batch_update"));
    expect(create).toBeDefined();
    const append = calls.find((c) => c.url.includes("/values_append"));
    expect((append!.body as { valueRange: { values: string[][]; range: string } }).valueRange.range).toBe("shtNEW!A:A");
  });

  it("refuses sparse historical headers instead of rewriting them", async () => {
    const messages: string[] = [];
    const calls: Call[] = [];
    const p = new FeishuSheetsRecordProvider({
      appId: "cli_x",
      appSecret: "secret_x",
      spreadsheetToken: "shtTOKEN",
      fetchImpl: fakeFeishu(calls, {
        headers: {
          shtUE: ["eventType", "", "userId"],
        },
      }),
      mappings: {
        "user-event": { worksheet: "user-event", columns: ["eventType", "userId"] },
      },
      log: (message) => messages.push(message),
    });

    await p.write(envelope("user-event", { eventType: "login", userId: "u1" }));

    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/values"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/values_append"))).toBe(false);
    expect(messages.some((message) => message.includes("invalid worksheet header"))).toBe(true);
  });
});

describe("columnLetter", () => {
  it("maps counts to spreadsheet column letters", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(3)).toBe("C");
    expect(columnLetter(26)).toBe("Z");
    expect(columnLetter(27)).toBe("AA");
  });
});
