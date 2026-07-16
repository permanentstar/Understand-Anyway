import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import type { AuthSession } from "@understand-anyway/plugin-api";
import { buildUserEventPayload } from "./portal-events.js";

function fakeReq(headers: Record<string, string | string[] | undefined> = {}, remote = "203.0.113.9"): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: remote } as unknown,
  } as unknown as IncomingMessage;
}

function session(user: AuthSession["user"]): AuthSession {
  return { user, createdAt: Date.now() };
}

describe("buildUserEventPayload", () => {
  it("builds a user-event envelope from the standard AuthedUser fields", () => {
    const env = buildUserEventPayload(
      session({ id: "u1", email: "a@b.c", displayName: "Alice" }),
      fakeReq({ "user-agent": "UA/1.0" }),
      { eventType: "project_view", targetType: "project", targetId: "demo" },
    );
    expect(env.kind).toBe("user-event");
    expect(env.payload.userId).toBe("u1");
    expect(env.payload.email).toBe("a@b.c");
    expect(env.payload.displayName).toBe("Alice");
    expect(env.payload.eventType).toBe("project_view");
    expect(env.payload.targetId).toBe("demo");
    expect(env.payload.userAgent).toBe("UA/1.0");
    expect(typeof env.payload.eventId).toBe("string");
  });

  it("degrades gracefully without a session", () => {
    const env = buildUserEventPayload(null, fakeReq(), { eventType: "authz_denied" });
    expect(env.payload.userId).toBe("");
    expect(env.payload.email).toBe("");
    expect(env.payload.displayName).toBe("");
    expect(env.payload.raw).toEqual({});
  });

  it("passes provider-specific identity through raw opaquely", () => {
    const env = buildUserEventPayload(
      session({ id: "u2", raw: { open_id: "ou_x", departmentPaths: ["A/B"] } }),
      fakeReq(),
      { eventType: "login" },
    );
    expect(env.payload.raw).toEqual({ open_id: "ou_x", departmentPaths: ["A/B"] });
  });

  it("prefers x-forwarded-for for the client ip", () => {
    const env = buildUserEventPayload(
      null,
      fakeReq({ "x-forwarded-for": "198.51.100.7, 203.0.113.5" }),
      { eventType: "project_view" },
    );
    expect(env.payload.sourceIp).toBe("198.51.100.7");
  });

  it("falls back to the socket remote address", () => {
    const env = buildUserEventPayload(null, fakeReq({}, "203.0.113.9"), { eventType: "project_view" });
    expect(env.payload.sourceIp).toBe("203.0.113.9");
  });

  it("payload exposes the full set of stable top-level keys downstream sinks depend on", () => {
    // Sinks (deploy.yaml columns, external-record scripts) index into payload by
    // literal key names. If someone renames a field here without updating the
    // sink, rows silently land as blanks. This locks the contract.
    const env = buildUserEventPayload(
      session({ id: "u1", email: "a@b.c", displayName: "Alice", raw: { open_id: "ou_x" } }),
      fakeReq({ "user-agent": "UA/1.0" }),
      { eventType: "project_view", targetType: "project", targetId: "demo", targetName: "Demo", targetUrl: "/project/demo/" },
    );
    const expected = [
      "eventId",
      "eventTime",
      "eventType",
      "userId",
      "email",
      "displayName",
      "sourceIp",
      "userAgent",
      "targetType",
      "targetId",
      "targetName",
      "targetUrl",
      "extra",
      "raw",
    ];
    for (const key of expected) {
      expect(env.payload).toHaveProperty(key);
    }
  });
});
