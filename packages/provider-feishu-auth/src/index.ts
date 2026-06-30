/**
 * Feishu (Lark) OAuth2 login provider.
 *
 * Implements the {@link AuthProvider} contract using the public Feishu OAuth2
 * endpoints (open.feishu.cn / accounts.feishu.cn) via `simple-oauth2`.
 *
 * Scope: authentication only — exchange an authorization code for an identity
 * and keep the session token fresh. Authorization decisions (enterprise
 * directory / department allowlists) are NOT handled here; they belong to an
 * OrgPolicyProvider (the in-house variant lives in the private overlay).
 */

export { FeishuAuthProvider } from "./feishu-auth-provider.js";
export type { FeishuAuthProviderOptions, FeishuUserInfo } from "./feishu-auth-provider.js";

import type { AuthProviderFactory } from "@understand-anyway/plugin-api";
import { FeishuAuthProvider, type FeishuAuthProviderOptions } from "./feishu-auth-provider.js";

/** Dynamic-loading factory: see PROVIDER_FACTORY_EXPORTS.auth. */
export const createAuthProvider: AuthProviderFactory = (config) =>
  new FeishuAuthProvider(config as FeishuAuthProviderOptions);
