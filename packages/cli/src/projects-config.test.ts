import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildDeployConfigPath,
  buildGatewayOperationsRoot,
  buildGatewayRegistryPath,
  buildGatewayRoot,
  buildPortalAssetsRoot,
  buildProjectStateRoot,
  buildProjectsConfigPath,
  copyIconFile,
  expandTemplate,
  IconExtensionError,
  PORTAL_ICON_EXTENSIONS,
  readProjectsConfig,
  resolveTemplatePath,
  resolveTemplateVars,
  upsertEntry,
  withProjectsConfigLock,
  writeProjectsConfigAtomic,
  type ProjectsConfig,
} from "./projects-config.js";

let dir: string;
let projectsRoot: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ua-projects-config-"));
  projectsRoot = join(dir, "projects");
  configPath = buildProjectsConfigPath(projectsRoot);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildProjectsConfigPath / buildPortalAssetsRoot", () => {
  it("returns conventional subpaths anchored on projectsRoot", () => {
    expect(buildGatewayRoot("/r")).toBe(resolve("/r/gateway"));
    expect(buildProjectsConfigPath("/r")).toBe(resolve("/r/gateway/config/projects.json"));
    expect(buildDeployConfigPath("/r")).toBe(resolve("/r/gateway/config/deploy.yaml"));
    expect(buildPortalAssetsRoot("/r")).toBe(resolve("/r/gateway/portal-assets"));
    expect(buildGatewayRegistryPath("/r")).toBe(resolve("/r/gateway/registry.json"));
    expect(buildGatewayOperationsRoot("/r")).toBe(resolve("/r/gateway/operations"));
    expect(buildProjectStateRoot("/r", "alpha")).toBe(resolve("/r/projects/alpha"));
  });
});

describe("readProjectsConfig", () => {
  it("returns empty config when the file is missing", () => {
    expect(readProjectsConfig(configPath)).toEqual({ version: 1, projects: [] });
  });

  it("tolerates corrupt JSON", () => {
    mkdirSync(join(projectsRoot, "gateway", "config"), { recursive: true });
    writeFileSync(configPath, "{ not json", "utf8");
    expect(readProjectsConfig(configPath).projects).toEqual([]);
  });

  it("drops entries missing a projectId", () => {
    mkdirSync(join(projectsRoot, "gateway", "config"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        projects: [{ projectId: "alpha" }, { name: "no-id" }, { projectId: "  " }],
      }),
      "utf8",
    );
    const cfg = readProjectsConfig(configPath);
    expect(cfg.projects.map((p) => p.projectId)).toEqual(["alpha"]);
  });
});

describe("writeProjectsConfigAtomic", () => {
  it("creates the file with sorted projects and a trailing newline", () => {
    writeProjectsConfigAtomic(configPath, {
      version: 1,
      projectBaseDir: "..",
      projects: [
        { projectId: "beta" },
        { projectId: "alpha", version: "v1" },
      ],
    });
    const raw = readFileSync(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw) as ProjectsConfig;
    expect(parsed.projects.map((p) => p.projectId)).toEqual(["alpha", "beta"]);
  });

  it("strips undefined fields from entries", () => {
    writeProjectsConfigAtomic(configPath, {
      version: 1,
      projects: [{ projectId: "alpha", name: undefined as unknown as string }],
    });
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as ProjectsConfig;
    expect(Object.prototype.hasOwnProperty.call(parsed.projects[0], "name")).toBe(false);
  });

  it("does not emit projectBaseDir when it was not supplied", () => {
    writeProjectsConfigAtomic(configPath, { version: 1, projects: [{ projectId: "alpha" }] });
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, "projectBaseDir")).toBe(false);
  });
});

describe("withProjectsConfigLock", () => {
  it("creates the lockdir and removes it on exit", () => {
    const lockDir = `${configPath}.lock`;
    withProjectsConfigLock(configPath, () => {
      expect(existsSync(lockDir)).toBe(true);
    });
    expect(existsSync(lockDir)).toBe(false);
  });

  it("releases the lock when the callback throws", () => {
    const lockDir = `${configPath}.lock`;
    expect(() =>
      withProjectsConfigLock(configPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockDir)).toBe(false);
  });
});

describe("expandTemplate", () => {
  it("prefers the vars table over process.env", () => {
    const vars = resolveTemplateVars("/r", "alpha", undefined, {
      HOME: "/home/test",
      projectsRoot: "/should/be/shadowed",
    });
    const expanded = expandTemplate("${projectsRoot}:${projectId}:${HOME}", vars, {
      HOME: "/home/test",
    });
    expect(expanded).toBe(`${vars.projectsRoot}:alpha:/home/test`);
  });

  it("falls back to process.env for unknown identifiers", () => {
    const vars = resolveTemplateVars("/r", "alpha");
    expect(expandTemplate("${UA_TEST_FOO}-x", vars, { UA_TEST_FOO: "bar" })).toBe("bar-x");
  });

  it("returns empty for unknown identifiers when env is empty", () => {
    const vars = resolveTemplateVars("/r", "alpha");
    expect(expandTemplate("${UA_NOPE_XYZ}!", vars, {})).toBe("!");
  });
});

describe("resolveTemplatePath", () => {
  it("expands templates and anchors relative results", () => {
    const vars = resolveTemplateVars("/r", "alpha");
    const out = resolveTemplatePath("${projectId}/src", "/anchor", vars);
    expect(out).toBe(resolve("/anchor/alpha/src"));
  });

  it("keeps absolute templates absolute", () => {
    const vars = resolveTemplateVars("/r", "alpha");
    const out = resolveTemplatePath("/abs/${projectId}", "/anchor", vars);
    expect(out).toBe(resolve("/abs/alpha"));
  });
});

describe("upsertEntry", () => {
  it("creates a new entry when the projectId is unknown", () => {
    const cfg: ProjectsConfig = { version: 1, projects: [] };
    const res = upsertEntry(cfg, { projectId: "alpha", version: "v1" });
    expect(res.created).toBe(true);
    expect(res.conflicts).toEqual([]);
    expect(cfg.projects[0]).toEqual({ projectId: "alpha", version: "v1" });
  });

  it("patches only explicitly provided fields", () => {
    const cfg: ProjectsConfig = {
      version: 1,
      projects: [{ projectId: "alpha", version: "v1", visible: false }],
    };
    const res = upsertEntry(cfg, { projectId: "alpha", version: "v2" });
    expect(res.created).toBe(false);
    expect(cfg.projects[0]).toEqual({ projectId: "alpha", version: "v2", visible: false });
  });

  it("reports repoPath as conflict without overwriting unless force is set", () => {
    const cfg: ProjectsConfig = {
      version: 1,
      projects: [{ projectId: "alpha", repoPath: "/old", version: "v1" }],
    };
    const reject = upsertEntry(cfg, { projectId: "alpha", repoPath: "/new", version: "v2" });
    expect(reject.created).toBe(false);
    expect(reject.conflicts).toEqual(["repoPath"]);
    // The whole patch is rejected when a tracked field conflicts; the
    // pre-existing entry is left untouched.
    expect(cfg.projects[0]).toEqual({ projectId: "alpha", repoPath: "/old", version: "v1" });

    const force = upsertEntry(
      cfg,
      { projectId: "alpha", repoPath: "/new", version: "v2" },
      { force: true },
    );
    expect(force.conflicts).toEqual(["repoPath"]);
    expect(cfg.projects[0]).toEqual({ projectId: "alpha", repoPath: "/new", version: "v2" });
  });

  it("allows routine display fields to overwrite without --force", () => {
    const cfg: ProjectsConfig = {
      version: 1,
      projects: [{ projectId: "alpha", version: "v1", sortOrder: 5 }],
    };
    const res = upsertEntry(cfg, { projectId: "alpha", version: "v2", sortOrder: 10 });
    expect(res.created).toBe(false);
    expect(res.conflicts).toEqual([]);
    expect(cfg.projects[0]).toEqual({ projectId: "alpha", version: "v2", sortOrder: 10 });
  });

  it("treats matching values as non-conflicts", () => {
    const cfg: ProjectsConfig = {
      version: 1,
      projects: [{ projectId: "alpha", version: "v1" }],
    };
    const res = upsertEntry(cfg, { projectId: "alpha", version: "v1" });
    expect(res.conflicts).toEqual([]);
  });

  it("rejects empty projectId", () => {
    const cfg: ProjectsConfig = { version: 1, projects: [] };
    expect(() => upsertEntry(cfg, { projectId: "  " } as unknown as { projectId: string })).toThrow(
      /projectId is required/,
    );
  });
});

describe("copyIconFile", () => {
  const portalAssetsRoot = () => join(dir, "portal-assets");
  const writeSrc = (name: string, content: string) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };

  it("copies the file and preserves the extension", () => {
    const src = writeSrc("alpha.svg", "<svg/>");
    const result = copyIconFile(src, portalAssetsRoot(), "alpha");
    expect(result.extension).toBe(".svg");
    expect(result.destination).toBe(resolve(portalAssetsRoot(), "icons", "alpha.svg"));
    expect(readFileSync(result.destination, "utf8")).toBe("<svg/>");
  });

  it("rejects unsupported extensions", () => {
    const src = writeSrc("alpha.gif", "GIF");
    expect(() => copyIconFile(src, portalAssetsRoot(), "alpha")).toThrow(IconExtensionError);
  });

  it("lowercases extension comparison", () => {
    const src = writeSrc("alpha.PNG", "PNG");
    const result = copyIconFile(src, portalAssetsRoot(), "alpha");
    expect(result.extension).toBe(".png");
    // case is preserved on the destination from the comparison value
    expect(result.destination.endsWith(".png")).toBe(true);
  });

  it("removes existing icons with other extensions to keep one canonical file per project", () => {
    const png = writeSrc("alpha.png", "PNG");
    copyIconFile(png, portalAssetsRoot(), "alpha");
    const svg = writeSrc("alpha2.svg", "<svg/>");
    const next = copyIconFile(svg, portalAssetsRoot(), "alpha");
    expect(next.extension).toBe(".svg");
    expect(existsSync(resolve(portalAssetsRoot(), "icons", "alpha.png"))).toBe(false);
    expect(existsSync(resolve(portalAssetsRoot(), "icons", "alpha.svg"))).toBe(true);
  });

  it("rejects missing source files", () => {
    expect(() => copyIconFile(join(dir, "missing.svg"), portalAssetsRoot(), "alpha")).toThrow(
      /not found/,
    );
  });

  it("exposes a stable extension whitelist", () => {
    expect([...PORTAL_ICON_EXTENSIONS]).toEqual([".svg", ".png", ".webp", ".jpg", ".jpeg"]);
  });
});

describe("round-trip", () => {
  it("writeProjectsConfigAtomic survives a follow-up read", () => {
    writeProjectsConfigAtomic(configPath, {
      version: 1,
      projects: [{ projectId: "alpha", repoPath: "${projectBaseDir}/alpha", version: "v1.0" }],
    });
    const reloaded = readProjectsConfig(configPath);
    expect(reloaded.projects).toEqual([
      { projectId: "alpha", repoPath: "${projectBaseDir}/alpha", version: "v1.0" },
    ]);
  });

  it("copyIconFile + readProjectsConfig stay independent (no entry mutation)", () => {
    writeProjectsConfigAtomic(configPath, { version: 1, projects: [{ projectId: "alpha" }] });
    const src = join(dir, "alpha.svg");
    writeFileSync(src, "<svg/>");
    copyIconFile(src, buildPortalAssetsRoot(projectsRoot), "alpha");
    const cfg = readProjectsConfig(configPath);
    expect(cfg.projects[0]).toEqual({ projectId: "alpha" });
  });
});
