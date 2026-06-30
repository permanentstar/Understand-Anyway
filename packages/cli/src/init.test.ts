import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArgsError, parseArgs, type InitArgs } from "./args.js";
import { runInit } from "./init.js";
import {
  buildPortalAssetsRoot,
  buildProjectsConfigPath,
  readProjectsConfig,
  type ProjectsConfig,
} from "./projects-config.js";

let dir: string;
let projectsRoot: string;
let repoDir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ua-init-"));
  projectsRoot = join(dir, "projects");
  repoDir = join(dir, "alpha");
  configPath = buildProjectsConfigPath(projectsRoot);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshArgs(overrides: Partial<InitArgs> = {}): InitArgs {
  const base: InitArgs = {
    command: "init",
    repo: repoDir,
    projectId: null,
    iconFile: null,
    version: null,
    sortOrder: null,
    repoPath: null,
    dryRun: false,
    force: false,
    explicit: new Set(),
  };
  return { ...base, ...overrides };
}

function noopLog(): (line: string) => void {
  return () => {
    // swallow JSON payload in tests
  };
}

describe("parseInitArgs", () => {
  it("parses the minimal positional invocation", () => {
    const parsed = parseArgs(["init", "/tmp/alpha"]);
    expect(parsed.command).toBe("init");
    if (parsed.command !== "init") return;
    expect(parsed.repo).toBe("/tmp/alpha");
    expect(parsed.projectId).toBeNull();
    expect(parsed.explicit.size).toBe(0);
  });

  it("tracks explicit flags in args.explicit", () => {
    const parsed = parseArgs([
      "init",
      "/tmp/alpha",
      "--project",
      "alpha",
      "--version",
      "v1",
      "--sort-order",
      "10",
      "--repo-path",
      "${projectBaseDir}/alpha",
      "--icon-file",
      "./alpha.svg",
    ]);
    expect(parsed.command).toBe("init");
    if (parsed.command !== "init") return;
    expect(parsed.projectId).toBe("alpha");
    expect(parsed.version).toBe("v1");
    expect(parsed.sortOrder).toBe(10);
    expect(parsed.repoPath).toBe("${projectBaseDir}/alpha");
    expect(parsed.iconFile).toBe("./alpha.svg");
    expect([...parsed.explicit].sort()).toEqual([
      "iconFile",
      "repoPath",
      "sortOrder",
      "version",
    ]);
  });

  it("rejects --sort-order with non-integer values", () => {
    expect(() => parseArgs(["init", "/tmp/alpha", "--sort-order", "1.5"])).toThrow(
      /invalid --sort-order/,
    );
  });

  it("accepts negative and zero sort orders", () => {
    const neg = parseArgs(["init", "/tmp/alpha", "--sort-order", "-3"]);
    if (neg.command !== "init") throw new Error("expected init");
    expect(neg.sortOrder).toBe(-3);
    const zero = parseArgs(["init", "/tmp/alpha", "--sort-order", "0"]);
    if (zero.command !== "init") throw new Error("expected init");
    expect(zero.sortOrder).toBe(0);
  });

  it("requires a positional <repo>", () => {
    expect(() => parseArgs(["init"])).toThrow(/missing required <repo>/);
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["init", "/tmp/alpha", "--icon-url", "http://x"])).toThrow(
      /unknown option/,
    );
  });

  it("--dry-run and --force toggle without tracking explicit", () => {
    const parsed = parseArgs(["init", "/tmp/alpha", "--dry-run", "--force"]);
    if (parsed.command !== "init") throw new Error("expected init");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.force).toBe(true);
    expect(parsed.explicit.size).toBe(0);
  });
});

describe("runInit basics", () => {
  it("creates a new entry using basename(repo) as the projectId", async () => {
    const args = freshArgs({ version: "v1" });
    args.explicit.add("version");
    const result = await runInit(args, {
      log: noopLog(),
      deps: { env: { UA_PROJECTS_ROOT: projectsRoot } },
    });
    expect(result.action).toBe("created");
    expect(result.projectId).toBe("alpha");
    expect(result.projectsConfigPath).toBe(configPath);
    expect(result.portalAssetsRoot).toBe(buildPortalAssetsRoot(projectsRoot));
    const persisted = readProjectsConfig(configPath);
    expect(persisted.projects).toEqual([{ projectId: "alpha", version: "v1" }]);
  });

  it("respects an explicit --project override", async () => {
    const args = freshArgs({ projectId: "beta", version: "v2" });
    args.explicit.add("version");
    const result = await runInit(args, {
      log: noopLog(),
      deps: { env: { UA_PROJECTS_ROOT: projectsRoot } },
    });
    expect(result.projectId).toBe("beta");
    const persisted = readProjectsConfig(configPath);
    expect(persisted.projects[0]?.projectId).toBe("beta");
  });

  it("is idempotent when re-run with the same flags (no-op)", async () => {
    const args = freshArgs({ version: "v1" });
    args.explicit.add("version");
    const env = { UA_PROJECTS_ROOT: projectsRoot };
    await runInit(args, { log: noopLog(), deps: { env } });

    const same = freshArgs({ version: "v1" });
    same.explicit.add("version");
    const result = await runInit(same, { log: noopLog(), deps: { env } });
    expect(result.action).toBe("no-op");
  });

  it("updates only explicitly-supplied fields (display field overwrite is free)", async () => {
    const env = { UA_PROJECTS_ROOT: projectsRoot };
    const first = freshArgs({ version: "v1", sortOrder: 5 });
    first.explicit.add("version");
    first.explicit.add("sortOrder");
    await runInit(first, { log: noopLog(), deps: { env } });

    const second = freshArgs({ version: "v2" });
    second.explicit.add("version");
    const result = await runInit(second, { log: noopLog(), deps: { env } });
    expect(result.action).toBe("updated");
    const persisted = readProjectsConfig(configPath);
    expect(persisted.projects[0]).toEqual({ projectId: "alpha", version: "v2", sortOrder: 5 });
  });

  it("rejects repoPath conflicts without --force", async () => {
    const env = { UA_PROJECTS_ROOT: projectsRoot };
    const first = freshArgs({ repoPath: "/old" });
    first.explicit.add("repoPath");
    await runInit(first, { log: noopLog(), deps: { env } });

    const second = freshArgs({ repoPath: "/new" });
    second.explicit.add("repoPath");
    await expect(runInit(second, { log: noopLog(), deps: { env } })).rejects.toBeInstanceOf(
      ArgsError,
    );
    const persisted = readProjectsConfig(configPath);
    expect(persisted.projects[0]?.repoPath).toBe("/old");
  });

  it("overwrites repoPath conflicts with --force", async () => {
    const env = { UA_PROJECTS_ROOT: projectsRoot };
    const first = freshArgs({ repoPath: "/old" });
    first.explicit.add("repoPath");
    await runInit(first, { log: noopLog(), deps: { env } });

    const second = freshArgs({ repoPath: "/new", force: true });
    second.explicit.add("repoPath");
    const result = await runInit(second, { log: noopLog(), deps: { env } });
    expect(result.action).toBe("updated");
    const persisted = readProjectsConfig(configPath);
    expect(persisted.projects[0]?.repoPath).toBe("/new");
  });
});

describe("runInit icon copy", () => {
  it("copies --icon-file into <portalAssetsRoot>/icons/<projectId>.<ext>", async () => {
    const iconSrc = join(dir, "alpha.svg");
    writeFileSync(iconSrc, "<svg/>", "utf8");
    const args = freshArgs({ iconFile: iconSrc });
    args.explicit.add("iconFile");

    const result = await runInit(args, {
      log: noopLog(),
      deps: { env: { UA_PROJECTS_ROOT: projectsRoot } },
    });
    expect(result.action).toBe("created");
    const dest = join(projectsRoot, "gateway", "portal-assets", "icons", "alpha.svg");
    expect(result.iconPath).toBe(dest);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("<svg/>");
    // entry must NOT record any icon field
    const persisted = readProjectsConfig(configPath);
    expect(persisted.projects[0]).toEqual({ projectId: "alpha" });
  });

  it("rejects unsupported icon extensions with ArgsError", async () => {
    const iconSrc = join(dir, "alpha.gif");
    writeFileSync(iconSrc, "GIF", "utf8");
    const args = freshArgs({ iconFile: iconSrc });
    args.explicit.add("iconFile");
    await expect(
      runInit(args, {
        log: noopLog(),
        deps: { env: { UA_PROJECTS_ROOT: projectsRoot } },
      }),
    ).rejects.toBeInstanceOf(ArgsError);
  });

  it("removes a previous icon variant when the extension changes", async () => {
    const env = { UA_PROJECTS_ROOT: projectsRoot };
    const png = join(dir, "alpha.png");
    writeFileSync(png, "PNG", "utf8");
    const first = freshArgs({ iconFile: png });
    first.explicit.add("iconFile");
    await runInit(first, { log: noopLog(), deps: { env } });
    expect(existsSync(join(projectsRoot, "gateway", "portal-assets", "icons", "alpha.png"))).toBe(true);

    const svg = join(dir, "alpha2.svg");
    writeFileSync(svg, "<svg/>", "utf8");
    const second = freshArgs({ iconFile: svg });
    second.explicit.add("iconFile");
    await runInit(second, { log: noopLog(), deps: { env } });
    expect(existsSync(join(projectsRoot, "gateway", "portal-assets", "icons", "alpha.png"))).toBe(false);
    expect(existsSync(join(projectsRoot, "gateway", "portal-assets", "icons", "alpha.svg"))).toBe(true);
  });
});

describe("runInit dry-run", () => {
  it("does not write projects.json or copy the icon", async () => {
    const iconSrc = join(dir, "alpha.svg");
    writeFileSync(iconSrc, "<svg/>", "utf8");
    const args = freshArgs({
      version: "v1",
      iconFile: iconSrc,
      dryRun: true,
    });
    args.explicit.add("version");
    args.explicit.add("iconFile");

    const log = vi.fn();
    const result = await runInit(args, {
      log,
      deps: { env: { UA_PROJECTS_ROOT: projectsRoot } },
    });
    expect(result.action).toBe("dry-run");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(projectsRoot, "gateway", "portal-assets", "icons", "alpha.svg"))).toBe(false);

    // payload is a single-line JSON
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]?.[0] as string;
    const payload = JSON.parse(line);
    expect(payload.action).toBe("dry-run");
    expect(payload.entry.version).toBe("v1");
    expect(payload.warnings.length).toBe(1);
  });

  it("flags repoPath conflicts in dry-run without --force", async () => {
    const env = { UA_PROJECTS_ROOT: projectsRoot };
    const first = freshArgs({ repoPath: "/old" });
    first.explicit.add("repoPath");
    await runInit(first, { log: noopLog(), deps: { env } });

    const second = freshArgs({ repoPath: "/new", dryRun: true });
    second.explicit.add("repoPath");
    await expect(runInit(second, { log: noopLog(), deps: { env } })).rejects.toBeInstanceOf(
      ArgsError,
    );
  });
});

describe("runInit repoPath template", () => {
  it("preserves template strings on the entry rather than resolving them", async () => {
    const args = freshArgs({ repoPath: "${projectBaseDir}/alpha" });
    args.explicit.add("repoPath");
    await runInit(args, {
      log: noopLog(),
      deps: { env: { UA_PROJECTS_ROOT: projectsRoot } },
    });
    const persisted = readProjectsConfig(configPath);
    expect(persisted.projects[0]?.repoPath).toBe("${projectBaseDir}/alpha");
  });
});

describe("runInit emits machine-readable JSON", () => {
  it("logs a single JSON line with the canonical fields", async () => {
    const args = freshArgs({ version: "v1" });
    args.explicit.add("version");
    const log = vi.fn();
    await runInit(args, { log, deps: { env: { UA_PROJECTS_ROOT: projectsRoot } } });
    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(Object.keys(payload).sort()).toEqual(
      ["action", "entry", "iconPath", "portalAssetsRoot", "projectId", "projectsConfigPath", "projectsRoot", "warnings"].sort(),
    );
    expect(payload.action).toBe("created");
    expect(payload.entry.projectId).toBe("alpha");
  });
});

describe("runInit projectsRoot resolution", () => {
  it("uses explicit deps.resolveProjectsRoot override", async () => {
    const customRoot = join(dir, "custom");
    const customConfig = buildProjectsConfigPath(customRoot);
    const args = freshArgs({ version: "v1" });
    args.explicit.add("version");
    await runInit(args, {
      log: noopLog(),
      deps: { resolveProjectsRoot: () => customRoot },
    });
    expect(readProjectsConfig(customConfig).projects[0]?.projectId).toBe("alpha");
  });

  it("falls back to UA_PROJECTS_ROOT env when no explicit override is given", async () => {
    const args = freshArgs();
    args.explicit.add("version"); // ensure non-empty patch
    args.version = "v1";
    const result = await runInit(args, {
      log: noopLog(),
      deps: { env: { UA_PROJECTS_ROOT: projectsRoot } },
    });
    expect(result.projectsRoot).toBe(projectsRoot);
  });
});

describe("runInit projectId inference", () => {
  it("infers projectId from basename(repo) when --project is omitted", async () => {
    const args = freshArgs();
    args.version = "v1";
    args.explicit.add("version");
    const result = await runInit(args, {
      log: noopLog(),
      deps: { env: { UA_PROJECTS_ROOT: projectsRoot } },
    });
    expect(result.projectId).toBe("alpha");
  });
});

describe("runInit returns persisted ProjectsConfig shape", () => {
  it("does NOT serialize stateDir on a clean upsert", async () => {
    const args = freshArgs({ version: "v1" });
    args.explicit.add("version");
    await runInit(args, {
      log: noopLog(),
      deps: { env: { UA_PROJECTS_ROOT: projectsRoot } },
    });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as ProjectsConfig & {
      projects: Array<Record<string, unknown>>;
    };
    expect(Object.prototype.hasOwnProperty.call(raw.projects[0] ?? {}, "stateDir")).toBe(false);
  });
});
