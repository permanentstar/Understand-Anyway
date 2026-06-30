/**
 * Authentication provider.
 *
 * Open-source default is {@link NoAuthProvider} (allow all; the dashboard
 * runtime token is handled separately by the gateway and is NOT auth).
 *
 * A standard OAuth2/OIDC-style login flow (e.g. the Feishu login provider)
 * ships as an optional open-source provider package. In-house specializations
 * (enterprise directory / department authz, in-house denied-page copy) live in
 * the private overlay and are layered on top via the provider registry.
 */

export interface AuthedUser {
  id: string;
  email?: string;
  displayName?: string;
  raw?: Record<string, unknown>;
}

export interface AuthRequestContext {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string>;
}

/**
 * A live authenticated session. The gateway owns the session store (cookie
 * name, map, expiry); the provider only produces and refreshes sessions.
 * `providerState` is opaque provider-private data (e.g. OAuth token payload)
 * that the gateway never interprets and only hands back on {@link AuthProvider.refresh}.
 */
export interface AuthSession {
  user: AuthedUser;
  createdAt: number;
  /** Last request time observed by the gateway's sliding session store. */
  lastSeenAt?: number;
  /** Absolute idle-expiry timestamp managed by the gateway's session store. */
  expiresAt?: number;
  providerState?: Record<string, unknown>;
}

export interface AuthResult {
  authenticated: boolean;
  user?: AuthedUser;
  /** When not authenticated, where to redirect for login (if applicable). */
  redirectTo?: string;
}

export interface AuthBeginResult {
  /** Authorization redirect target (e.g. the IdP authorize URL). */
  redirectTo: string;
}

export interface AuthCallbackDenied {
  reason: string;
  /** Optional provider-supplied denial HTML; gateway renders neutral 403 when absent. */
  html?: string;
}

export interface AuthCallbackResult {
  ok: boolean;
  /** Present when ok=true. */
  session?: AuthSession;
  /** Where to redirect after a successful login (original next path). */
  redirectTo?: string;
  /** Present when ok=false due to an authorization decision. */
  denied?: AuthCallbackDenied;
}

export interface AuthProvider {
  readonly name: string;

  /**
   * Decide whether an incoming request is allowed through. When not
   * authenticated, may return a `redirectTo` pointing at the login entry.
   * An existing session (already validated by the gateway) is passed when present.
   */
  authenticate(ctx: AuthRequestContext, session?: AuthSession | null): Promise<AuthResult>;

  /** Begin a login flow (e.g. /auth/start): return the authorization redirect. */
  beginLogin?(ctx: AuthRequestContext, nextPath: string): Promise<AuthBeginResult>;

  /**
   * Complete a login flow (e.g. /auth/callback): exchange the authorization
   * grant for an identity, apply org policy, and produce a session.
   */
  handleCallback?(ctx: AuthRequestContext): Promise<AuthCallbackResult>;

  /** Refresh a session whose token is about to expire. Return null to force re-login. */
  refresh?(session: AuthSession): Promise<AuthSession | null>;
}

/** Allow-all provider. Used when no SSO is configured (open-source default). */
export class NoAuthProvider implements AuthProvider {
  readonly name = "no-auth";
  async authenticate(): Promise<AuthResult> {
    return { authenticated: true };
  }
}
