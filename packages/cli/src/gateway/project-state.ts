import { resolve } from "node:path";
import {
  cleanupProjectVersions,
  listProjectVersionIds,
  rollbackProjectToStable,
  seedProjectVersion,
  setStableProjectVersion,
  type ProjectVersioningDeps,
} from "@understand-anyway/gateway";
import type { ProjectStateArgs } from "../args.js";
import { resolveProjectContext } from "../project-context.js";

export interface RunProjectStateDeps {
  seedProjectVersion?: typeof seedProjectVersion;
  setStableProjectVersion?: typeof setStableProjectVersion;
  rollbackProjectToStable?: typeof rollbackProjectToStable;
  listProjectVersionIds?: typeof listProjectVersionIds;
  cleanupProjectVersions?: typeof cleanupProjectVersions;
  resolveProjectContext?: typeof resolveProjectContext;
  versioningDeps?: ProjectVersioningDeps;
  log?: (message: string) => void;
}

export async function runProjectState(args: ProjectStateArgs, deps: RunProjectStateDeps = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const resolveCtx = deps.resolveProjectContext ?? resolveProjectContext;
  const ctx = resolveCtx(args.projectId);
  const stateDir = ctx.stateRoot;
  const vd = deps.versioningDeps;

  if (args.action === "publish") {
    const state = (deps.seedProjectVersion ?? seedProjectVersion)(
      args.versionId,
      stateDir,
      {
        stable: args.stable,
        sourceRoot: args.sourceRoot ? resolve(args.sourceRoot) : undefined,
        retentionMaxVersions: args.retain ?? undefined,
      },
      vd,
    );
    log(`project-state: published ${state.currentVersion}` + (state.stableVersion === state.currentVersion ? " [stable]" : ""));
    return;
  }
  if (args.action === "set-stable") {
    const state = (deps.setStableProjectVersion ?? setStableProjectVersion)(args.versionId, stateDir, vd);
    log(`project-state: stable=${state.stableVersion}`);
    return;
  }
  if (args.action === "rollback") {
    const state = (deps.rollbackProjectToStable ?? rollbackProjectToStable)(stateDir, vd);
    log(`project-state: rolled back to stable=${state.stableVersion} (current=${state.currentVersion})`);
    return;
  }
  if (args.action === "list") {
    const ids = (deps.listProjectVersionIds ?? listProjectVersionIds)(stateDir, vd);
    log(ids.length === 0 ? "no project versions" : ids.join("\n"));
    return;
  }
  const deleted = (deps.cleanupProjectVersions ?? cleanupProjectVersions)(
    stateDir,
    args.retain === null ? {} : { retentionMaxVersions: args.retain },
    vd,
  );
  log(deleted.length === 0 ? "project-state: gc — nothing to delete" : `project-state: gc deleted ${deleted.join(", ")}`);
}
