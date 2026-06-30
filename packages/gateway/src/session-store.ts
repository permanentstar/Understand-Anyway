/**
 * Provider-agnostic session store.
 *
 * The gateway owns sessions (cookie name, in-memory map, expiry) regardless of
 * which AuthProvider is active. AuthProvider only produces/refreshes the
 * {@link AuthSession} payload; this store persists it across requests.
 */

import { randomBytes } from "node:crypto";
import type { AuthSession } from "@understand-anyway/plugin-api";

export interface SessionStoreOptions {
  cookieName: string;
  /** Idle session lifetime in milliseconds. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class SessionStore {
  readonly cookieName: string;
  readonly ttlMs: number;
  private readonly sessions = new Map<string, AuthSession>();

  constructor(options: SessionStoreOptions) {
    this.cookieName = options.cookieName;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  get cookieMaxAgeSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  private renew(session: AuthSession, now: number): AuthSession {
    return {
      ...session,
      createdAt: typeof session.createdAt === "number" ? session.createdAt : now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
    };
  }

  private isExpired(session: AuthSession, now: number): boolean {
    const expiresAt = typeof session.expiresAt === "number"
      ? session.expiresAt
      : ((typeof session.createdAt === "number" ? session.createdAt : now) + this.ttlMs);
    return expiresAt <= now;
  }

  create(session: AuthSession, now = Date.now()): string {
    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, this.renew(session, now));
    return token;
  }

  get(token: string | undefined | null, now = Date.now()): AuthSession | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (this.isExpired(session, now)) {
      this.sessions.delete(token);
      return null;
    }
    const renewed = this.renew(session, now);
    this.sessions.set(token, renewed);
    return renewed;
  }

  replace(token: string, session: AuthSession, now = Date.now()): void {
    this.sessions.set(token, this.renew(session, now));
  }

  delete(token: string | undefined | null): void {
    if (token) this.sessions.delete(token);
  }

  /** Drop expired sessions. Safe to call per-request. */
  sweep(now = Date.now()): void {
    for (const [token, session] of this.sessions.entries()) {
      if (this.isExpired(session, now)) this.sessions.delete(token);
    }
  }
}
