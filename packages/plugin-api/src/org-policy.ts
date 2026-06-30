/**
 * Organization policy provider — decides whether an authenticated user is
 * allowed to access a given project (org scope, allowlist, etc.).
 *
 * Open-source default {@link AllowAllOrgPolicyProvider} permits everything.
 * In-house org-directory / allowlist logic lives in the overlay.
 */

import type { AuthedUser } from "./auth.js";

export interface OrgPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface OrgPolicyProvider {
  readonly name: string;
  canAccessProject(user: AuthedUser | undefined, projectId: string): Promise<OrgPolicyDecision>;
}

export class AllowAllOrgPolicyProvider implements OrgPolicyProvider {
  readonly name = "allow-all";
  async canAccessProject(): Promise<OrgPolicyDecision> {
    return { allowed: true };
  }
}
