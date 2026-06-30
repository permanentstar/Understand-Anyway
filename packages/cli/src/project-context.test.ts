import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArgsError } from "./args.js";
import {
  resolveProjectContext,
  resolveProjectDistDir,
  resolveProjectsRoot,
} from "./project-context.js";
import { buildProjectsConfigPath } from "./projects-config.js";

let dir: string;
let projectsRoot: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ua-project-context-"));
  projectsRoot = join(dir, "projects");
  configPath = buildProjectsConfigPath(projectsRoot);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(payload: unknown): void {
  mkdirSync(join(projectsRoot, "gateway", "config"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(payload), "utf8");
}

describe("resolveProjectsRoot", () => {
  it("uses the explicit override when provided", () => {
    const root = resolveProjectsRoot({ explicit: "/explicit", env: { UA_PROJECTS_ROOT: "/env" } });
    expect(root).toBe(resolve("/explicit"));
  });

  it("falls back to UA_PROJECTS_ROOT env", () => {
    const root = resolveProjectsRoot({ env: { UA_PROJECTS_ROOT: "/env" } });
    expect(root).toBe(resolve("/env"));
  });

  it("falls back to $HOME/understand-projects", () => {
    const root = resolveProjectsRoot({ env: { HOME: "/home/test" } });
    expect(root).toBe(resolve("/home/test/understand-projects"));
  });

  it("falls back to literal understand-projects without HOME", () => {
    const root = resolveProjectsRoot({ env: {} });
    expect(root).toBe("understand-projects");
  });
});

describe("resolveProjectContext", () => {
  it("throws ArgsError when projectId is empty", () => {
    expect(() => resolveProjectContext("", { explicit: projectsRoot })).toThrow(ArgsError);
  });

  it("throws ArgsError with init hint when project is not registered", () => {
    writeConfig({ version: 1, projects: [] });
    expect(() => resolveProjectContext("alpha", { explicit: projectsRoot })).toThrow(
      /not registered/,
    );
  });

  it("throws a legacy layout hint when old config path exists", () => {
    mkdirSync(join(projectsRoot, "config"), { recursive: true });
    writeFileSync(
      join(projectsRoot, "config", "projects.json"),
      JSON.stringify({ version: 1, projects: [{ projectId: "alpha" }] }),
      "utf8",
    );
    expect(() => resolveProjectContext("alpha", { explicit: projectsRoot })).toThrow(
      /legacy projects config.*gateway\/config\/projects\.json/i,
    );
  });

  it("resolves conventional paths under gateway/ and projects/", () => {
    writeConfig({ version: 1, projects: [{ projectId: "alpha" }] });
    const ctx = resolveProjectContext("alpha", { explicit: projectsRoot });
    expect(ctx.stateRoot).toBe(resolve(projectsRoot, "projects", "alpha"));
    expect(ctx.projectsConfigPath).toBe(resolve(projectsRoot, "gateway", "config", "projects.json"));
    expect(ctx.deployConfigPath).toBe(resolve(projectsRoot, "gateway", "config", "deploy.yaml"));
    expect(ctx.portalAssetsRoot).toBe(resolve(projectsRoot, "gateway", "portal-assets"));
  });

  it("defaults repoPath to ${projectBaseDir}/${projectId} anchored on projectsRoot", () => {
    writeConfig({ version: 1, projects: [{ projectId: "alpha" }] });
    const ctx = resolveProjectContext("alpha", { explicit: projectsRoot });
    // projectBaseDir defaults to ".." rooted at <projectsRoot>.
    expect(ctx.repoPath).toBe(resolve(projectsRoot, "..", "alpha"));
  });

  it("honors explicit repoPath templates", () => {
    writeConfig({
      version: 1,
      projects: [{ projectId: "alpha", repoPath: "${projectsRoot}/sources/${projectId}" }],
    });
    const ctx = resolveProjectContext("alpha", { explicit: projectsRoot });
    expect(ctx.repoPath).toBe(resolve(projectsRoot, "sources", "alpha"));
  });

  it("respects projectBaseDir override", () => {
    writeConfig({
      version: 1,
      projectBaseDir: "${HOME}/repos",
      projects: [{ projectId: "alpha" }],
    });
    const ctx = resolveProjectContext("alpha", {
      explicit: projectsRoot,
      env: { HOME: "/home/x" },
    });
    expect(ctx.repoPath).toBe(resolve("/home/x/repos/alpha"));
  });
});

describe("resolveProjectDistDir", () => {
  it("prefers <stateRoot>/current/dashboard-dist when present", () => {
    const stateRoot = join(dir, "alpha");
    mkdirSync(join(stateRoot, "current", "dashboard-dist"), { recursive: true });
    expect(resolveProjectDistDir(stateRoot)).toBe(
      resolve(stateRoot, "current", "dashboard-dist"),
    );
  });

  it("falls back to <stateRoot>/dashboard-dist otherwise", () => {
    const stateRoot = join(dir, "alpha");
    expect(resolveProjectDistDir(stateRoot)).toBe(resolve(stateRoot, "dashboard-dist"));
  });
});
