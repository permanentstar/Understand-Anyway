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
  /** Stable audit reason to expose in user-event sinks; defaults to `reason` when absent. */
  authReason?: string;
  /** Candidate department paths observed for the user, as path segment arrays. */
  departmentPaths?: string[][];
  /** The user department path that matched the policy, when access is allowed by department. */
  matchedDepartmentPath?: string[];
  /** Configured target department path for the policy decision. */
  targetDepartment?: string[];
  /** Optional provider-supplied denial HTML; gateway renders neutral 403 when absent. */
  html?: string;
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
