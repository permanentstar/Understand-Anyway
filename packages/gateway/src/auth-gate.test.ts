import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuthBeginResult,
  AuthCallbackResult,
  AuthProvider,
  AuthRequestContext,
  AuthResult,
  AuthSession,
} from "@understand-anyway/plugin-api";
import { NoAuthProvider } from "@understand-anyway/plugin-api";
import { AuthGate } from "./auth-gate.js";
import { SessionStore } from "./session-store.js";
import { parseCookies } from "./cookies.js";

interface FakeRes {
  statusCode: number | null;
  headers: Record<string, string | string[]>;
  body: string;
  ended: boolean;
}

function makeRes(): { res: ServerResponse; sink: FakeRes } {
  const sink: FakeRes = { statusCode: null, headers: {}, body: "", ended: false };
  const res = {
    getHeader(name: string) {
      return sink.headers[name];
    },
    setHeader(name: string, value: string | string[]) {
      sink.headers[name] = value;
      return this;
    },
    writeHead(status: number, headers: Record<string, string> = {}) {
      sink.statusCode = status;
      Object.assign(sink.headers, headers);
      return this;
    },
    end(chunk?: string) {
      if (chunk) sink.body += chunk;
      sink.ended = true;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, sink };
}

function makeReq(url: string, cookie?: string): IncomingMessage {
  return {
    method: "GET",
    url,
    headers: cookie ? { cookie } : {},
  } as unknown as IncomingMessage;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

class StubProvider implements AuthProvider {
  readonly name = "stub";
  async authenticate(_ctx: AuthRequestContext, session?: AuthSession | null): Promise<AuthResult> {
    return session ? { authenticated: true, user: session.user } : { authenticated: false };
  }
  async beginLogin(_ctx: AuthRequestContext, nextPath: string): Promise<AuthBeginResult> {
    return { redirectTo: `https://idp.example/authorize?next=${encodeURIComponent(nextPath)}` };
  }
  async handleCallback(ctx: AuthRequestContext): Promise<AuthCallbackResult> {
    const ok = new URL(ctx.url, "http://x").searchParams.get("ok") === "1";
    if (!ok) return { ok: false, denied: { reason: "denied_by_stub" } };
    return {
      ok: true,
      session: { user: { id: "u1", displayName: "User One" }, createdAt: Date.now() },
      redirectTo: "/project/demo/",
    };
  }
}

describe("AuthGate with NoAuthProvider", () => {
  it("short-circuits: every request proceeds, nothing written", async () => {
    const gate = new AuthGate({ provider: new NoAuthProvider(), sessions: new SessionStore({ cookieName: "ua" }) });
    const { res, sink } = makeRes();
    const decision = await gate.handle(makeReq("/project/demo/"), res, new URL("http://h/project/demo/"));
    expect(decision.handled).toBe(false);
    expect(sink.ended).toBe(false);
  });
});

describe("AuthGate with an enabled provider", () => {
  it("redirects unauthenticated requests to /auth/start with next", async () => {
    const gate = new AuthGate({ provider: new StubProvider(), sessions: new SessionStore({ cookieName: "ua" }) });
    const { res, sink } = makeRes();
    const decision = await gate.handle(makeReq("/project/demo/"), res, new URL("http://h/project/demo/"));
    expect(decision.handled).toBe(true);
    expect(sink.statusCode).toBe(302);
    expect(sink.headers.Location).toContain("/auth/start?next=");
  });

  it("begins login by redirecting to the provider authorize URL", async () => {
    const gate = new AuthGate({ provider: new StubProvider(), sessions: new SessionStore({ cookieName: "ua" }) });
    const { res, sink } = makeRes();
    await gate.handle(makeReq("/auth/start?next=/project/demo/"), res, new URL("http://h/auth/start?next=/project/demo/"));
    expect(sink.statusCode).toBe(302);
    expect(sink.headers.Location).toContain("https://idp.example/authorize");
  });

  it("completes callback, sets session cookie, and redirects to next", async () => {
    const sessions = new SessionStore({ cookieName: "ua" });
    const gate = new AuthGate({ provider: new StubProvider(), sessions });
    const { res, sink } = makeRes();
    await gate.handle(makeReq("/auth/callback?ok=1"), res, new URL("http://h/auth/callback?ok=1"));
    expect(sink.statusCode).toBe(302);
    expect(sink.headers.Location).toBe("/project/demo/");
    const token = parseCookies(firstHeaderValue(sink.headers["Set-Cookie"]))["ua"];
    expect(token).toBeTruthy();
    expect(sessions.get(token)?.user.id).toBe("u1");
    expect(sink.headers["Set-Cookie"]).toContain("Max-Age=604800");
  });

  it("calls the login success hook once after a successful callback", async () => {
    const sessions = new SessionStore({ cookieName: "ua" });
    const onLoginSuccess = vi.fn();
    const gate = new AuthGate({ provider: new StubProvider(), sessions, onLoginSuccess });
    const { res } = makeRes();
    const req = makeReq("/auth/callback?ok=1");
    const url = new URL("http://h/auth/callback?ok=1");

    await gate.handle(req, res, url);

    expect(onLoginSuccess).toHaveBeenCalledTimes(1);
    expect(onLoginSuccess.mock.calls[0]![0]).toMatchObject({
      session: { user: { id: "u1", displayName: "User One" } },
      token: expect.any(String),
      redirectTo: "/project/demo/",
    });
    expect(onLoginSuccess.mock.calls[0]![0].req).toBe(req);
    expect(onLoginSuccess.mock.calls[0]![0].url).toBe(url);
  });

  it("does not call the login success hook for a denied callback", async () => {
    const sessions = new SessionStore({ cookieName: "ua" });
    const onLoginSuccess = vi.fn();
    const gate = new AuthGate({ provider: new StubProvider(), sessions, onLoginSuccess });
    const { res } = makeRes();

    await gate.handle(makeReq("/auth/callback?ok=0"), res, new URL("http://h/auth/callback?ok=0"));

    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it("renders a neutral 403 on a denied callback", async () => {
    const gate = new AuthGate({ provider: new StubProvider(), sessions: new SessionStore({ cookieName: "ua" }) });
    const { res, sink } = makeRes();
    await gate.handle(makeReq("/auth/callback?ok=0"), res, new URL("http://h/auth/callback?ok=0"));
    expect(sink.statusCode).toBe(403);
    expect(sink.body).toContain("denied_by_stub");
  });

  it("allows requests carrying a valid session cookie", async () => {
    const sessions = new SessionStore({ cookieName: "ua" });
    const token = sessions.create({ user: { id: "u1" }, createdAt: Date.now() });
    const gate = new AuthGate({ provider: new StubProvider(), sessions });
    const { res, sink } = makeRes();
    const decision = await gate.handle(makeReq("/project/demo/", `ua=${token}`), res, new URL("http://h/project/demo/"));
    expect(decision.handled).toBe(false);
    expect(decision.session?.user.id).toBe("u1");
    expect(sink.headers["Set-Cookie"]).toContain(`ua=${token}`);
    expect(sink.headers["Set-Cookie"]).toContain("Max-Age=604800");
  });
});
