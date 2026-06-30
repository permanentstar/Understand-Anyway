import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { AuthorizationCode, type ModuleOptions, type Token } from "simple-oauth2";
import type {
  AuthBeginResult,
  AuthCallbackResult,
  AuthProvider,
  AuthRequestContext,
  AuthResult,
  AuthSession,
  AuthedUser,
} from "@understand-anyway/plugin-api";

const TOKEN_HOST = "https://open.feishu.cn";
const TOKEN_PATH = "/open-apis/authen/v2/oauth/token";
const AUTHORIZE_HOST = "https://accounts.feishu.cn";
const AUTHORIZE_PATH = "/open-apis/authen/v1/authorize";
const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";

const DEFAULT_REFRESH_WINDOW_SECONDS = 300;
const STATE_TTL_MS = 10 * 60 * 1000;
const CALLBACK_PATH = "/auth/callback";

export interface FeishuAuthProviderOptions {
  appId: string;
  /** Provide the secret directly, or via `appSecretFile` / `appSecretEnv`. */
  appSecret?: string;
  appSecretFile?: string;
  /** Env var holding the secret; defaults to FEISHU_APP_SECRET. */
  appSecretEnv?: string;
  /** Public origin the IdP redirects back to; callback is `<origin>/auth/callback`. */
  redirectOrigin: string;
  /** OAuth scope string (space-delimited). Include `offline_access` to enable refresh. */
  scope?: string;
  /** Seconds before expiry within which the access token is proactively refreshed. */
  refreshWindowSeconds?: number;
}

export interface FeishuUserInfo {
  open_id?: string;
  union_id?: string;
  user_id?: string;
  name?: string;
  en_name?: string;
  email?: string;
  enterprise_email?: string;
  avatar_url?: string;
  [key: string]: unknown;
}

interface PendingState {
  createdAt: number;
  nextPath: string;
}

export class FeishuAuthProvider implements AuthProvider {
  readonly name = "feishu";

  private readonly options: FeishuAuthProviderOptions;
  private readonly refreshWindowSeconds: number;
  private readonly pendingStates = new Map<string, PendingState>();

  constructor(options: FeishuAuthProviderOptions) {
    if (!options.appId) throw new Error("FeishuAuthProvider: missing appId");
    if (!options.redirectOrigin) throw new Error("FeishuAuthProvider: missing redirectOrigin");
    this.options = options;
    this.refreshWindowSeconds = options.refreshWindowSeconds ?? DEFAULT_REFRESH_WINDOW_SECONDS;
  }

  async authenticate(_ctx: AuthRequestContext, session?: AuthSession | null): Promise<AuthResult> {
    if (session?.user) {
      return { authenticated: true, user: session.user };
    }
    return { authenticated: false, redirectTo: "/auth/start" };
  }

  async beginLogin(_ctx: AuthRequestContext, nextPath: string): Promise<AuthBeginResult> {
    this.sweepStates();
    const state = randomBytes(16).toString("hex");
    this.pendingStates.set(state, { createdAt: Date.now(), nextPath });
    const client = this.createClient({ requireSecret: false });
    const redirectTo = client.authorizeURL({
      redirect_uri: this.callbackUrl(),
      scope: this.options.scope || undefined,
      state,
    });
    return { redirectTo };
  }

  async handleCallback(ctx: AuthRequestContext): Promise<AuthCallbackResult> {
    this.sweepStates();
    const query = new URL(ctx.url, "http://localhost").searchParams;
    const state = query.get("state") || "";
    const code = query.get("code") || "";
    const error = query.get("error") || "";

    const pending = this.pendingStates.get(state);
    if (!pending) {
      return { ok: false, denied: { reason: "invalid_state" } };
    }
    this.pendingStates.delete(state);

    if (error) {
      return { ok: false, denied: { reason: `authorization_error:${error}` } };
    }
    if (!code) {
      return { ok: false, denied: { reason: "missing_code" } };
    }

    let tokenPayload: Token;
    try {
      const client = this.createClient({ requireSecret: true });
      const token = await client.getToken({ code, redirect_uri: this.callbackUrl() });
      tokenPayload = token.token;
    } catch (err) {
      return { ok: false, denied: { reason: formatOAuthError(err, "token_exchange_failed") } };
    }

    const accessToken = readAccessToken(tokenPayload);
    const userInfo = accessToken ? await fetchFeishuUserInfo(accessToken) : null;
    if (!userInfo) {
      return { ok: false, denied: { reason: "user_info_unavailable" } };
    }

    const session: AuthSession = {
      user: toAuthedUser(userInfo),
      createdAt: Date.now(),
      providerState: { oauthToken: tokenPayload as unknown as Record<string, unknown> },
    };
    return { ok: true, session, redirectTo: pending.nextPath };
  }

  async refresh(session: AuthSession): Promise<AuthSession | null> {
    const oauthToken = session.providerState?.oauthToken as Token | undefined;
    if (!oauthToken) return session;

    let accessToken;
    try {
      const client = this.createClient({ requireSecret: false });
      accessToken = client.createToken(oauthToken);
    } catch {
      return session;
    }

    if (!accessToken.expired(this.refreshWindowSeconds)) {
      return session;
    }

    if (!oauthToken.refresh_token) {
      // No refresh token (offline_access not granted): force re-login on expiry.
      return null;
    }

    try {
      const refreshClient = this.createClient({ requireSecret: true });
      const refreshable = refreshClient.createToken(oauthToken);
      const refreshed = await refreshable.refresh();
      const refreshedPayload = refreshed.token;
      const refreshedAccess = readAccessToken(refreshedPayload);
      const refreshedUserInfo = refreshedAccess ? await fetchFeishuUserInfo(refreshedAccess) : null;
      return {
        user: refreshedUserInfo ? toAuthedUser(refreshedUserInfo) : session.user,
        createdAt: session.createdAt,
        providerState: { oauthToken: refreshedPayload as unknown as Record<string, unknown> },
      };
    } catch {
      return null;
    }
  }

  private callbackUrl(): string {
    const origin = normalizeOrigin(this.options.redirectOrigin);
    return new URL(CALLBACK_PATH, `${origin}/`).toString();
  }

  private createClient(options: { requireSecret: boolean }): AuthorizationCode {
    const moduleOptions: ModuleOptions = {
      client: {
        id: this.options.appId,
        secret: this.resolveSecret(options.requireSecret),
      },
      auth: {
        tokenHost: TOKEN_HOST,
        tokenPath: TOKEN_PATH,
        authorizeHost: AUTHORIZE_HOST,
        authorizePath: AUTHORIZE_PATH,
      },
      options: {
        bodyFormat: "json",
        authorizationMethod: "body",
      },
    };
    return new AuthorizationCode(moduleOptions);
  }

  private resolveSecret(required: boolean): string {
    if (this.options.appSecret) return this.options.appSecret;
    if (this.options.appSecretFile) {
      try {
        const secret = readFileSync(this.options.appSecretFile, "utf8").trim();
        if (secret) return secret;
        if (required) throw new Error(`empty app secret file: ${this.options.appSecretFile}`);
        return "";
      } catch (err) {
        if (required) {
          throw new Error(`failed to read app secret file: ${this.options.appSecretFile} (${(err as Error).message})`);
        }
        return "";
      }
    }
    const envName = this.options.appSecretEnv || "FEISHU_APP_SECRET";
    const secret = process.env[envName];
    if (!secret && required) throw new Error(`missing app secret env: ${envName}`);
    return secret || "";
  }

  private sweepStates(): void {
    const now = Date.now();
    for (const [state, pending] of this.pendingStates.entries()) {
      if (now - pending.createdAt > STATE_TTL_MS) this.pendingStates.delete(state);
    }
  }
}

function normalizeOrigin(origin: string): string {
  const value = String(origin).trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function readAccessToken(payload: Token): string | null {
  const direct = payload.access_token as string | undefined;
  if (direct) return direct;
  const data = payload.data as { access_token?: string } | undefined;
  return data?.access_token ?? null;
}

function toAuthedUser(info: FeishuUserInfo): AuthedUser {
  return {
    id: info.open_id || info.union_id || info.user_id || "",
    email: info.enterprise_email || info.email,
    displayName: info.name || info.en_name,
    raw: info as Record<string, unknown>,
  };
}

async function fetchFeishuUserInfo(accessToken: string): Promise<FeishuUserInfo | null> {
  const response = await fetch(USER_INFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json().catch(() => null)) as
    | { code?: number; data?: FeishuUserInfo }
    | null;
  if (!response.ok || !payload || payload.code !== 0) {
    return null;
  }
  return payload.data ?? (payload as unknown as FeishuUserInfo);
}

function formatOAuthError(error: unknown, fallback: string): string {
  const err = error as { data?: { payload?: { msg?: string; message?: string } }; message?: string };
  return err?.data?.payload?.msg || err?.data?.payload?.message || err?.message || fallback;
}
