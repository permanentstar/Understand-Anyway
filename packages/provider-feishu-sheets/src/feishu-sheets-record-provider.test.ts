import { describe, expect, it } from "vitest";
import type { RecordEnvelope } from "@understand-anyway/plugin-api";
import { columnLetter, type FetchLike } from "./feishu-sheets-client.js";
import { FeishuSheetsRecordProvider } from "./feishu-sheets-record-provider.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Fake Feishu API: returns tenant token, a spreadsheet with one existing
 * worksheet ("user-event", sheetId "shtUE"), an empty header, and accepts
 * appends. Records every call for assertions.
 */
function fakeFeishu(calls: Call[]): FetchLike {
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
      return respond({ sheets: [{ sheetId: "shtUE", title: "user-event" }] });
    }
    if (u.pathname.includes("/values/") && method === "GET") {
      return respond({ valueRange: { values: [[]] } });
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

function provider(calls: Call[]): FeishuSheetsRecordProvider {
  return new FeishuSheetsRecordProvider({
    appId: "cli_x",
    appSecret: "secret_x",
    spreadsheetToken: "shtTOKEN",
    fetchImpl: fakeFeishu(calls),
    mappings: {
      "user-event": { worksheet: "user-event", columns: ["eventType", "userId", "raw.open_id"] },
    },
  });
}

function envelope(kind: RecordEnvelope["kind"], payload: Record<string, unknown>): RecordEnvelope {
  return { kind, timestamp: new Date().toISOString(), payload };
}

describe("FeishuSheetsRecordProvider", () => {
  it("requires a spreadsheet token", () => {
    expect(() => new FeishuSheetsRecordProvider({ appId: "x", appSecret: "y", spreadsheetToken: "", mappings: {} })).toThrow(/spreadsheetToken/);
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

  it("skips kinds without a mapping (no API calls)", async () => {
    const calls: Call[] = [];
    await provider(calls).write(envelope("nightly-update", { runId: "r1" }));
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
});

describe("columnLetter", () => {
  it("maps counts to spreadsheet column letters", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(3)).toBe("C");
    expect(columnLetter(26)).toBe("Z");
    expect(columnLetter(27)).toBe("AA");
  });
});
