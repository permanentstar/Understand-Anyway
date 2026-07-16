/**
 * Dynamic provider-loading contract.
 *
 * The open-source CLI never statically imports in-house provider packages. It
 * loads them at runtime by package name and calls a well-known factory export.
 * Any package that exports the agreed factory name (see
 * {@link PROVIDER_FACTORY_EXPORTS}) can be wired in via a `--*-provider <pkg>`
 * flag — the core stays unaware of which concrete provider it loaded.
 *
 * Factories take an opaque `config` (parsed from a runtime JSON config file, so
 * secrets never live in code or flags) and return a provider instance.
 */

import type { AuthProvider } from "./auth.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { LlmProvider } from "./llm.js";
import type { NotifyProvider } from "./notify.js";
import type { OrgPolicyProvider } from "./org-policy.js";

/** Neutral portal brand assets, as URLs. Each is omitted when absent. */
export interface PortalAssets {
  /** Hero stage background image URL. Omitted → gradient-only stage. */
  background?: string;
  /**
   * Full-page background image URL, painted on `<body>` beneath the stage and
   * content (cover-fit). Distinct from {@link background}, which is confined to
   * the hero `.stage` for stage-composed art. Omitted → gradient-only page.
   */
  pageBackground?: string;
  /** Footer wordmark image URL. Omitted → no wordmark image. */
  wordmark?: string;
  /** Default left footer link avatar URL. */
  footerLeft?: string;
  /** Default right footer link avatar URL. */
  footerRight?: string;
}

export type AuthProviderFactory = (config: unknown) => AuthProvider | Promise<AuthProvider>;

export type OrgPolicyProviderFactory = (config: unknown) => OrgPolicyProvider | Promise<OrgPolicyProvider>;

export type LlmProviderFactory = (config: unknown) => LlmProvider | Promise<LlmProvider>;

export type EmbeddingProviderFactory = (config: unknown) => EmbeddingProvider | Promise<EmbeddingProvider>;

export type NotifyProviderFactory = (config: unknown) => NotifyProvider | Promise<NotifyProvider>;

/** What a portal-assets package contributes: a dir to mount + the asset URL map. */
export interface PortalAssetsContribution {
  /** Directory served under the portal asset route prefix. */
  assetsDir?: string;
  /** Asset URL map injected into the portal view. */
  assets?: PortalAssets;
}

export type PortalAssetsFactory = (
  config: unknown,
) => PortalAssetsContribution | Promise<PortalAssetsContribution>;

/** Well-known factory export names a loadable provider package must use. */
export const PROVIDER_FACTORY_EXPORTS = {
  auth: "createAuthProvider",
  orgPolicy: "createOrgPolicyProvider",
  portalAssets: "createPortalAssets",
  llm: "createLlmProvider",
  embedding: "createEmbeddingProvider",
  notify: "createNotifyProvider",
} as const;
