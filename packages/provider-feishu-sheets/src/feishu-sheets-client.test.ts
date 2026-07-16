import { describe, expect, it } from "vitest";
import { FeishuSheetsClient, type FetchLike } from "./feishu-sheets-client.js";

interface Call {
  url: string;
  method: string;
}

function headerFetch(
  calls: Call[],
  headers: Record<string, Record<string, string[]>>,
): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const u = new URL(url);
    const respond = (data: unknown) => ({ ok: true, async json() { return { code: 0, data }; } });
    if (u.pathname.endsWith("/tenant_access_token/internal")) {
      return { ok: true, async json() { return { code: 0, tenant_access_token: "t-abc", expire: 7200 }; } };
    }
    if (u.pathname.includes("/values/") && method === "GET") {
      const encoded = u.pathname.split("/values/")[1] || "";
      const range = decodeURIComponent(encoded);
      const bang = range.indexOf("!");
      const sheetId = bang >= 0 ? range.slice(0, bang) : range;
      const spreadsheetToken = decodeURIComponent(u.pathname.split("/spreadsheets/")[1]?.split("/values/")[0] || "");
      return respond({ valueRange: { values: [headers[spreadsheetToken]?.[sheetId] ?? []] } });
    }
    if (u.pathname.endsWith("/values") && method === "PUT") {
      return respond({});
    }
    return { ok: false, async json() { return { code: 1, msg: `unexpected ${u.pathname}` }; } };
  };
}

describe("FeishuSheetsClient.ensureHeader", () => {
  it("caches worksheet schemas without colliding on ':' inside ids", async () => {
    const calls: Call[] = [];
    const client = new FeishuSheetsClient({
      appId: "cli_x",
      appSecret: "secret_x",
      fetchImpl: headerFetch(calls, {
        "book:alpha": { "sheet:beta": ["alphaHeader"] },
        book: { "alpha:sheet:beta": ["betaHeader"] },
      }),
    });

    const first = await client.ensureHeader("book:alpha", "sheet:beta", ["alphaHeader"]);
    const second = await client.ensureHeader("book", "alpha:sheet:beta", ["betaHeader"]);

    expect(first).toEqual(["alphaHeader"]);
    expect(second).toEqual(["betaHeader"]);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });
});
