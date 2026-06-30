/**
 * Minimal provider registry. The overlay registers in-house implementations;
 * the open-source core registers defaults. Resolution is by provider name with
 * a safe default fallback.
 */

import { AllowAllOrgPolicyProvider, type OrgPolicyProvider } from "./org-policy.js";
import { NoAuthProvider, type AuthProvider } from "./auth.js";
import { NoopEmbeddingProvider, type EmbeddingProvider } from "./embedding.js";
import { NoopRecordProvider, type RecordProvider } from "./record.js";
import { UnconfiguredLlmProvider, type LlmProvider } from "./llm.js";
import { NoopNotifyProvider, type NotifyProvider } from "./notify.js";

export interface ProviderRegistry {
  auth: AuthProvider;
  orgPolicy: OrgPolicyProvider;
  record: RecordProvider;
  llm: LlmProvider;
  embedding: EmbeddingProvider;
  notify: NotifyProvider;
}

export function defaultProviderRegistry(): ProviderRegistry {
  return {
    auth: new NoAuthProvider(),
    orgPolicy: new AllowAllOrgPolicyProvider(),
    record: new NoopRecordProvider(),
    llm: new UnconfiguredLlmProvider(),
    embedding: new NoopEmbeddingProvider(),
    notify: new NoopNotifyProvider(),
  };
}
