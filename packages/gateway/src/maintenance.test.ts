import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import {
  isMaintenanceActiveForProject,
  isGlobalMaintenanceActive,
  writeMaintenanceForPath,
  type MaintenanceState,
} from "./maintenance.js";

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Buffer;
  writeHead(code: number, headers?: Record<string, string>): void;
  end(chunk?: string | Buffer): void;
}

function fakeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) this.headers = { ...this.headers, ...headers };
    },
    end(chunk) {
      if (chunk !== undefined) this.body = chunk;
    },
  };
}

function asRes(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse;
}

const globalState: MaintenanceState = {
  enabled: true,
  scope: "global",
  title: "Down",
  message: "Back soon",
  eta: "10:00",
  contact: "ops@example.com",
};

describe("maintenance active checks", () => {
  it("ignores disabled state", () => {
    expect(isMaintenanceActiveForProject({ enabled: false, scope: "global" }, "alpha")).toBe(false);
    expect(isGlobalMaintenanceActive({ enabled: false, scope: "global" })).toBe(false);
    expect(isMaintenanceActiveForProject(null, "alpha")).toBe(false);
  });

  it("global scope covers every project", () => {
    expect(isGlobalMaintenanceActive(globalState)).toBe(true);
    expect(isMaintenanceActiveForProject(globalState, "anything")).toBe(true);
  });

  it("project scope covers only listed ids", () => {
    const state: MaintenanceState = { enabled: true, scope: "project", projectIds: ["alpha"] };
    expect(isGlobalMaintenanceActive(state)).toBe(false);
    expect(isMaintenanceActiveForProject(state, "alpha")).toBe(true);
    expect(isMaintenanceActiveForProject(state, "beta")).toBe(false);
  });
});

describe("writeMaintenanceForPath response shapes", () => {
  it("returns JSON for data endpoints", () => {
    const res = fakeRes();
    writeMaintenanceForPath(asRes(res), "/knowledge-graph.json?token=x", globalState);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Content-Type"]).toContain("application/json");
    expect(JSON.parse(res.body as string)).toMatchObject({
      code: "maintenance",
      title: "Down",
      message: "Back soon",
      eta: "10:00",
      contact: "ops@example.com",
    });
  });

  it("returns plain text for static assets", () => {
    const res = fakeRes();
    writeMaintenanceForPath(asRes(res), "/assets/app.js", globalState);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Content-Type"]).toContain("text/plain");
    expect(res.body).toBe("Back soon");
  });

  it("returns an HTML page otherwise", () => {
    const res = fakeRes();
    writeMaintenanceForPath(asRes(res), "/index.html", globalState);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(res.body).toContain("Down");
    expect(res.body).toContain("Back soon");
    expect(res.body).toContain("10:00");
    expect(res.body).toContain("ops@example.com");
  });

  it("falls back to neutral default copy", () => {
    const res = fakeRes();
    writeMaintenanceForPath(asRes(res), "/", { enabled: true, scope: "global" });
    expect(res.body).toContain("Under maintenance");
    expect(res.body).toContain("temporarily unavailable");
  });

  it("escapes html in copy", () => {
    const res = fakeRes();
    writeMaintenanceForPath(asRes(res), "/", {
      enabled: true,
      scope: "global",
      message: "<script>alert(1)</script>",
    });
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;");
  });
});
