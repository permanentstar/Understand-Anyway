/**
 * Auth orchestration for the gateway.
 *
 * Encapsulates the SSO seam points (login start, OAuth callback, logout, the
 * per-request authenticate gate, and session refresh) behind a single handler
 * that depends only on the {@link AuthProvider} abstraction and the gateway's
 * own {@link SessionStore}.
 *
 * With {@link NoAuthProvider} (open-source default) the gate short-circuits:
 * every request is allowed through and the login/callback routes are inert.
 * The dashboard runtime token is unrelated to auth and handled elsewhere.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuthProvider,
  AuthRequestContext,
  AuthSession,
} from "@understand-anyway/plugin-api";
import { SessionStore } from "./session-store.js";
import { buildSetCookie, mergeSetCookieHeader, parseCookies } from "./cookies.js";
import { renderDeniedPage } from "./access-pages.js";
import { redirect, sendHtml } from "./http.js";

export interface AuthGateOptions {
  provider: AuthProvider;
  sessions: SessionStore;
  /** Default landing path after login / for root redirects. */
  defaultEntryPath?: string;
  /** Seconds before expiry within which a session is proactively refreshed. */
  secure?: boolean;
  onLoginSuccess?: (event: AuthGateLoginSuccessEvent) => void | Promise<void>;
}

export interface AuthGateLoginSuccessEvent {
  req: IncomingMessage;
  url: URL;
  session: AuthSession;
  token: string;
  redirectTo: string;
}

export interface AuthGateDecision {
  /** True when the request was fully handled (response already written). */
  handled: boolean;
  /** Present (and authenticated) when the request may proceed downstream. */
  session?: AuthSession | null;
}

const LOGIN_REQUIRED_REASON = "login_required";

export class AuthGate {
  private readonly provider: AuthProvider;
  private readonly sessions: SessionStore;
  private readonly defaultEntryPath: string;
  private readonly secure: boolean;
  private readonly onLoginSuccess?: (event: AuthGateLoginSuccessEvent) => void | Promise<void>;

  constructor(options: AuthGateOptions) {
    this.provider = options.provider;
    this.sessions = options.sessions;
    this.defaultEntryPath = options.defaultEntryPath ?? "/";
    this.secure = Boolean(options.secure);
    this.onLoginSuccess = options.onLoginSuccess;
  }

  private get enabled(): boolean {
    return this.provider.name !== "no-auth";
  }

  private buildContext(req: IncomingMessage): AuthRequestContext {
    return {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers as Record<string, string | string[] | undefined>,
      cookies: parseCookies(req.headers.cookie),
    };
  }

  private sessionCookie(token: string): string {
    return buildSetCookie(this.sessions.cookieName, token, {
      maxAge: this.sessions.cookieMaxAgeSeconds,
      sameSite: "Lax",
      secure: this.secure,
    });
  }

  private appendSetCookie(res: ServerResponse, cookie: string): void {
    const existing = res.getHeader?.("Set-Cookie") as string | string[] | undefined;
    res.setHeader?.("Set-Cookie", mergeSetCookieHeader(existing, cookie));
  }

  /**
   * Process a request through the auth lifecycle. Returns whether the request
   * was handled (login/callback/logout/redirect) or may proceed with a session.
   */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<AuthGateDecision> {
    this.sessions.sweep();
    const ctx = this.buildContext(req);
    const token = ctx.cookies[this.sessions.cookieName];

    // Open-source default: no auth, everything proceeds.
    if (!this.enabled) {
      return { handled: false, session: null };
    }

    const pathname = url.pathname;

    if (pathname === "/logout") {
      this.sessions.delete(token);
      this.redirect(res, "/auth/start", {
        "Set-Cookie": buildSetCookie(this.sessions.cookieName, "", { maxAge: 0, sameSite: "Lax" }),
      });
      return { handled: true };
    }

    if (pathname === "/auth/start") {
      const nextPath = this.normalizeNext(url.searchParams.get("next"));
      if (!this.provider.beginLogin) {
        this.writeDenied(res, 503, "login_unavailable");
        return { handled: true };
      }
      const { redirectTo } = await this.provider.beginLogin(ctx, nextPath);
      this.redirect(res, redirectTo);
      return { handled: true };
    }

    if (pathname === "/auth/callback") {
      if (!this.provider.handleCallback) {
        this.writeDenied(res, 503, "callback_unavailable");
        return { handled: true };
      }
      const result = await this.provider.handleCallback(ctx);
      if (!result.ok || !result.session) {
        const denied = result.denied;
        if (denied?.html) {
          this.writeHtml(res, 403, denied.html);
        } else {
          this.writeDenied(res, 403, denied?.reason);
        }
        return { handled: true };
      }
      const newToken = this.sessions.create(result.session);
      const redirectTo = result.redirectTo ?? this.defaultEntryPath;
      await this.onLoginSuccess?.({
        req,
        url,
        session: result.session,
        token: newToken,
        redirectTo,
      });
      this.redirect(res, redirectTo, {
        "Set-Cookie": this.sessionCookie(newToken),
      });
      return { handled: true };
    }

    // Per-request gate.
    let session = this.sessions.get(token);
    if (!session) {
      this.redirect(res, `/auth/start?next=${encodeURIComponent(this.currentPath(url))}`);
      return { handled: true };
    }

    // Proactive refresh.
    if (this.provider.refresh) {
      const refreshed = await this.provider.refresh(session);
      if (!refreshed) {
        this.sessions.delete(token);
        this.redirect(res, `/auth/start?next=${encodeURIComponent(this.currentPath(url))}`);
        return { handled: true };
      }
      if (refreshed !== session) {
        this.sessions.replace(token!, refreshed);
        session = refreshed;
      }
    }

    const decision = await this.provider.authenticate(ctx, session);
    if (!decision.authenticated) {
      if (decision.redirectTo) {
        this.redirect(res, decision.redirectTo);
      } else {
        this.writeDenied(res, 403, LOGIN_REQUIRED_REASON);
      }
      return { handled: true };
    }

    this.appendSetCookie(res, this.sessionCookie(token!));
    return { handled: false, session };
  }

  private currentPath(url: URL): string {
    return url.pathname === "/" && !url.search ? this.defaultEntryPath : `${url.pathname}${url.search}`;
  }

  private normalizeNext(candidate: string | null): string {
    if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return this.defaultEntryPath;
    return candidate;
  }

  private redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
    redirect(res, location, headers);
  }

  private writeHtml(res: ServerResponse, status: number, html: string): void {
    sendHtml(res, status, html);
  }

  private writeDenied(res: ServerResponse, status: number, reason?: string): void {
    this.writeHtml(res, status, renderDeniedPage(reason));
  }
}
