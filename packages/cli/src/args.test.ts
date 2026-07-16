import { describe, expect, it } from "vitest";
import { ArgsError, helpText, parseArgs, parseServeDaemonArgs } from "./args.js";

describe("parseArgs", () => {
  it("returns help for empty argv and help flags", () => {
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["-h"]).command).toBe("help");
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["help"]).command).toBe("help");
  });

  it("parses a full public serve invocation through --project", () => {
    const parsed = parseArgs([
      "serve",
      "--project", "alpha",
      "--host", "0.0.0.0",
      "--port", "18666",
      "--project-root", "/p",
    ]);
    expect(parsed).toEqual({
      command: "serve",
      host: "0.0.0.0",
      port: 18666,
      hostExplicit: true,
      portExplicit: true,
      projectId: "alpha",
      stateDir: "",
      distDir: "",
      token: "",
      projectRoot: "/p",
      recordProviders: [],
      authProvider: null,
      orgPolicy: null,
      embeddingProvider: null,
      portal: false,
      portalAssets: null,
      projectRoute: false,
      registryPath: null,
      maintenanceEnabled: false,
      maintenanceScope: "global",
      maintenanceProjectIds: [],
      maintenanceTitle: null,
      maintenanceMessage: null,
      maintenanceEta: null,
      maintenanceContact: null,
      config: null,
      serveProfile: null,
    });
  });

  it("applies default host/port and null project root", () => {
    const parsed = parseArgs(["serve", "--project", "alpha"]);
    if (parsed.command !== "serve") throw new Error("expected serve");
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(0);
    expect(parsed.hostExplicit).toBe(false);
    expect(parsed.portExplicit).toBe(false);
    expect(parsed.projectRoot).toBeNull();
    expect(parsed.recordProviders).toEqual([]);
    expect(parsed.config).toBeNull();
    expect(parsed.serveProfile).toBeNull();
    expect(parsed.maintenanceEnabled).toBe(false);
    expect(parsed.maintenanceProjectIds).toEqual([]);
  });

  it("parses record providers (comma-separated) and the unified config path", () => {
    const parsed = parseArgs([
      "serve",
      "--project", "alpha",
      "--record-provider", "local,feishu-sheets",
      "--config", "/deploy.yaml",
      "--serve-profile", "sso-portal",
    ]);
    if (parsed.command !== "serve") throw new Error("expected serve");
    expect(parsed.recordProviders).toEqual(["local", "feishu-sheets"]);
    expect(parsed.config).toBe("/deploy.yaml");
    expect(parsed.serveProfile).toBe("sso-portal");
  });

  it("rejects an unknown record provider", () => {
    expect(() =>
      parseArgs(["serve", "--project", "alpha", "--record-provider", "bogus"]),
    ).toThrow(/invalid --record-provider/);
  });

  it("parses dynamic provider flags and registry", () => {
    const parsed = parseArgs([
      "serve",
      "--project", "alpha",
      "--auth-provider", "pkg-auth",
      "--org-policy", "pkg-org",
      "--embedding-provider", "pkg-embed",
      "--portal",
      "--portal-assets", "pkg-assets",
      "--project-route",
      "--registry", "/r.json",
      "--config", "/deploy.yaml",
    ]);
    if (parsed.command !== "serve") throw new Error("expected serve");
    expect(parsed.authProvider).toBe("pkg-auth");
    expect(parsed.orgPolicy).toBe("pkg-org");
    expect(parsed.embeddingProvider).toBe("pkg-embed");
    expect(parsed.portal).toBe(true);
    expect(parsed.portalAssets).toBe("pkg-assets");
    expect(parsed.projectRoute).toBe(true);
    expect(parsed.registryPath).toBe("/r.json");
    expect(parsed.config).toBe("/deploy.yaml");
  });

  it("allows --portal/--project-route without --registry (registry may come from config)", () => {
    const portalOnly = parseArgs(["serve", "--project", "alpha", "--portal"]);
    if (portalOnly.command !== "serve") throw new Error("expected serve");
    expect(portalOnly.portal).toBe(true);
    expect(portalOnly.registryPath).toBeNull();
  });

  it("rejects --portal-assets without --portal", () => {
    expect(() =>
      parseArgs([
        "serve", "--project", "alpha", "--registry", "/r.json", "--portal-assets", "pkg-assets",
      ]),
    ).toThrow(/--portal-assets requires --portal/);
  });

  it("parses maintenance flags", () => {
    const parsed = parseArgs([
      "serve",
      "--project", "alpha",
      "--maintenance",
      "--maintenance-scope", "project",
      "--maintenance-project", "alpha,beta",
      "--maintenance-title", "Down",
      "--maintenance-message", "Back soon",
      "--maintenance-eta", "10:00",
      "--maintenance-contact", "ops@example.com",
    ]);
    if (parsed.command !== "serve") throw new Error("expected serve");
    expect(parsed.maintenanceEnabled).toBe(true);
    expect(parsed.maintenanceScope).toBe("project");
    expect(parsed.maintenanceProjectIds).toEqual(["alpha", "beta"]);
    expect(parsed.maintenanceTitle).toBe("Down");
    expect(parsed.maintenanceMessage).toBe("Back soon");
    expect(parsed.maintenanceEta).toBe("10:00");
    expect(parsed.maintenanceContact).toBe("ops@example.com");
  });

  it("rejects invalid maintenance scope", () => {
    expect(() =>
      parseArgs(["serve", "--project", "alpha", "--maintenance-scope", "team"]),
    ).toThrow(/invalid --maintenance-scope/);
  });

  it("rejects unknown command and unknown option", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(ArgsError);
    expect(() => parseArgs(["serve", "--nope"])).toThrow(ArgsError);
  });

  it("requires --project and rejects daemon-only state flags publicly", () => {
    expect(() => parseArgs(["serve"])).toThrow(/missing required --project/);
    expect(() => parseArgs(["serve", "--state-dir", "/s"])).toThrow(/unknown option: --state-dir/);
    expect(() => parseArgs(["serve", "--dist-dir", "/d"])).toThrow(/unknown option: --dist-dir/);
    expect(() => parseArgs(["serve", "--token", "t"])).toThrow(/unknown option: --token/);
  });

  it("rejects invalid port and missing flag values", () => {
    expect(() => parseArgs(["serve", "--port", "99999", "--project", "alpha"])).toThrow(/--port/);
    expect(() => parseArgs(["serve", "--project"])).toThrow(/missing value/);
  });

  it("keeps state-dir/dist-dir/token in the hidden daemon parser only", () => {
    const parsed = parseServeDaemonArgs([
      "--state-dir", "/s",
      "--dist-dir", "/d",
      "--token", "tok",
      "--host", "0.0.0.0",
      "--port", "18666",
      "--project-root", "/p",
    ]);
    expect(parsed).toMatchObject({
      command: "serve",
      projectId: null,
      stateDir: "/s",
      distDir: "/d",
      token: "tok",
      host: "0.0.0.0",
      port: 18666,
      projectRoot: "/p",
    });
  });

  it("does not expose daemon-only state flags in help", () => {
    const help = parseArgs(["--help"]);
    expect(help.command).toBe("help");
    expect(helpText()).not.toContain("--state-dir");
    expect(helpText()).not.toContain("--dist-dir");
    expect(helpText()).not.toContain("--token <token>");
  });
});

describe("parseArgs build", () => {
  it("parses --project with defaults", () => {
    const parsed = parseArgs(["build", "--project", "alpha"]);
    expect(parsed).toEqual({
      command: "build",
      projectId: "alpha",
      excludeTests: null,
      pluginRoot: null,
      outputLanguage: null,
      mode: "full",
      includePaths: [],
      config: null,
      deployProfile: null,
      llmAnalysis: null,
      llmProvider: null,
      llmProfile: null,
      embeddingProvider: null,
      llmRequired: null,
      llmModelCandidates: [],
      llmRetry: {
        maxAttempts: null,
        initialBackoffMs: null,
        maxBackoffMs: null,
      },
      batchMode: "auto",
      mapperBatchCount: null,
      mapperConcurrency: null,
    });
  });

  it("parses all build flags", () => {
    const parsed = parseArgs([
      "build",
      "--project", "alpha",
      "--include-tests",
      "--plugin-root", "/plugin",
      "--output-language", "zh",
    ]);
    if (parsed.command !== "build") throw new Error("expected build");
    expect(parsed.projectId).toBe("alpha");
    expect(parsed.excludeTests).toBe(false);
    expect(parsed.pluginRoot).toBe("/plugin");
    expect(parsed.outputLanguage).toBe("zh");
  });

  it("parses incremental, resume and backfill build modes", () => {
    expect(parseArgs(["build", "--incremental", "--project", "alpha"])).toMatchObject({
      command: "build",
      mode: "incremental",
    });
    expect(parseArgs(["build", "--resume", "--project", "alpha"])).toMatchObject({
      command: "build",
      mode: "resume",
    });
    expect(parseArgs(["build", "--backfill", "--project", "alpha"])).toMatchObject({
      command: "build",
      mode: "backfill",
      includePaths: [],
    });
    expect(parseArgs(["build", "--backfill", "--include", "src/a.ts", "--project", "alpha"])).toMatchObject({
      command: "build",
      mode: "backfill",
      includePaths: ["src/a.ts"],
    });
  });

  it("parses build config flag", () => {
    const parsed = parseArgs(["build", "--config", "/cfg/deploy.yaml", "--project", "alpha"]);
    if (parsed.command !== "build") throw new Error("expected build");
    expect(parsed.config).toBe("/cfg/deploy.yaml");
  });

  it("rejects the removed build --profile flag", () => {
    expect(() => parseArgs(["build", "--config", "/cfg/deploy.yaml", "--profile", "nightly", "--project", "alpha"]))
      .toThrow(/unknown option: --profile/);
  });

  it("parses deploy and llm profile flags for build", () => {
    const parsed = parseArgs([
      "build",
      "--config", "/cfg/deploy.yaml",
      "--deploy-profile", "ppe",
      "--llm-profile", "traex",
      "--project", "alpha",
    ]);
    if (parsed.command !== "build") throw new Error("expected build");
    expect(parsed.config).toBe("/cfg/deploy.yaml");
    expect(parsed.deployProfile).toBe("ppe");
    expect(parsed.llmProfile).toBe("traex");
  });

  it("parses llm build flags", () => {
    const parsed = parseArgs(["build", "--llm-analysis", "--llm-provider", "pkg-llm", "--embedding-provider", "pkg-embed", "--llm-required", "--llm-model-candidates", "small,large", "--project", "alpha"]);
    if (parsed.command !== "build") throw new Error("expected build");
    expect(parsed.llmAnalysis).toBe(true);
    expect(parsed.llmProvider).toBe("pkg-llm");
    expect(parsed.embeddingProvider).toBe("pkg-embed");
    expect(parsed.llmRequired).toBe(true);
    expect(parsed.llmModelCandidates).toEqual(["small", "large"]);
  });

  it("defaults llm flags to null/disabled intent", () => {
    const parsed = parseArgs(["build", "--project", "alpha"]);
    if (parsed.command !== "build") throw new Error("expected build");
    expect(parsed.llmAnalysis).toBeNull();
    expect(parsed.llmProvider).toBeNull();
    expect(parsed.embeddingProvider).toBeNull();
    expect(parsed.llmRequired).toBeNull();
  });

  it("parses the public llm retry attempts flag", () => {
    const parsed = parseArgs([
      "build",
      "--llm-retry-max-attempts", "5",
      "--project", "alpha",
    ]);
    if (parsed.command !== "build") throw new Error("expected build");
    expect(parsed.llmRetry).toEqual({
      maxAttempts: 5,
      initialBackoffMs: null,
      maxBackoffMs: null,
    });
  });

  it("rejects invalid llm retry values", () => {
    expect(() => parseArgs(["build", "--project", "alpha", "--llm-retry-max-attempts", "0"])).toThrow(/--llm-retry-max-attempts/);
  });

  it("does not expose llm retry timing as public build flags", () => {
    expect(() => parseArgs(["build", "--project", "alpha", "--llm-retry-initial-backoff", "250"]))
      .toThrow(/unknown option: --llm-retry-initial-backoff/);
    expect(() => parseArgs(["build", "--project", "alpha", "--llm-retry-max-backoff", "10000"]))
      .toThrow(/unknown option: --llm-retry-max-backoff/);
  });

  it("parses C7 batch-mode tuning flags", () => {
    const parsed = parseArgs([
      "build",
      "--batch-mode", "segmented",
      "--mapper-batch-count", "25",
      "--mapper-concurrency", "4",
      "--project", "alpha",
    ]);
    if (parsed.command !== "build") throw new Error("expected build");
    expect(parsed.batchMode).toBe("segmented");
    expect(parsed.mapperBatchCount).toBe(25);
    expect(parsed.mapperConcurrency).toBe(4);
  });

  it("rejects invalid batch-mode/mapper values", () => {
    expect(() => parseArgs(["build", "--project", "alpha", "--batch-mode", "turbo"])).toThrow(/--batch-mode/);
    expect(() => parseArgs(["build", "--project", "alpha", "--mapper-batch-count", "0"])).toThrow(/--mapper-batch-count/);
    expect(() => parseArgs(["build", "--project", "alpha", "--mapper-concurrency", "-1"])).toThrow(/--mapper-concurrency/);
  });

  it("rejects multiple build modes", () => {
    expect(() => parseArgs(["build", "--incremental", "--resume", "--project", "alpha"])).toThrow(/choose only one build mode/);
  });

  it("rejects --include outside backfill", () => {
    expect(() => parseArgs(["build", "--include", "src/a.ts", "--project", "alpha"])).toThrow(/--include requires --backfill/);
  });

  it("--exclude-tests is the default and can be made explicit", () => {
    const parsed = parseArgs(["build", "--project", "alpha", "--include-tests", "--exclude-tests"]);
    if (parsed.command !== "build") throw new Error("expected build");
    expect(parsed.excludeTests).toBe(true);
  });

    it("accepts --no-dashboard as a build no-op for deploy script compatibility", () => {
      const parsed = parseArgs(["build", "--project", "alpha", "--no-dashboard"]);
      expect(parsed).toMatchObject({ command: "build", projectId: "alpha" });
    });

  it("requires a --project and rejects positional args", () => {
    expect(() => parseArgs(["build"])).toThrow(/--project/);
    expect(() => parseArgs(["build", "/a"])).toThrow(/unexpected positional/);
  });

  it("rejects unknown build option and returns help on -h", () => {
    expect(() => parseArgs(["build", "--project", "alpha", "--nope"])).toThrow(/unknown option/);
    expect(parseArgs(["build", "-h"]).command).toBe("help");
  });
});

describe("parseArgs compat", () => {
  it("parses compat with defaults", () => {
    const parsed = parseArgs(["compat"]);
    expect(parsed).toEqual({ command: "compat", pluginRoot: null, json: false, update: false });
  });

  it("parses all compat flags", () => {
    const parsed = parseArgs(["compat", "--plugin-root", "/plugin", "--json", "--update"]);
    if (parsed.command !== "compat") throw new Error("expected compat");
    expect(parsed.pluginRoot).toBe("/plugin");
    expect(parsed.json).toBe(true);
    expect(parsed.update).toBe(true);
  });

  it("rejects unknown compat option and returns help on -h", () => {
    expect(() => parseArgs(["compat", "--nope"])).toThrow(/unknown option/);
    expect(parseArgs(["compat", "-h"]).command).toBe("help");
  });
});

describe("parseArgs — dashboard subcommand (D2)", () => {
  it("dashboard with no action returns help", () => {
    expect(parseArgs(["dashboard"]).command).toBe("help");
    expect(parseArgs(["dashboard", "-h"]).command).toBe("help");
  });

  it("rejects an unknown dashboard subcommand", () => {
    expect(() => parseArgs(["dashboard", "boom"])).toThrow(
      /expected start \| stop \| stop-all \| status \| build-dist \| dev/,
    );
  });

  describe("start", () => {
    it("parses a minimal start invocation with defaults", () => {
      const parsed = parseArgs([
        "dashboard", "start",
        "--project", "alpha",
      ]);
      expect(parsed).toEqual({
        command: "dashboard",
        action: "start",
        projectId: "alpha",
        projectRoot: null,
        host: "127.0.0.1",
        port: 0,
        token: null,
        noOpen: false,
        config: null,
        serveProfile: null,
        portal: false,
        projectRoute: false,
        registryPath: null,
        pluginRoot: null,
        rebuildDashboard: false,
      });
    });

    it("parses every flag", () => {
      const parsed = parseArgs([
        "dashboard", "start",
        "--project", "alpha",
        "--project-root", "/p",
        "--host", "0.0.0.0",
        "--port", "18666",
        "--no-open",
        "--config", "/cfg",
        "--serve-profile", "nightly",
        "--portal",
        "--project-route",
        "--registry", "/registry.json",
        "--plugin-root", "/plugin",
        "--rebuild-dashboard",
      ]);
      expect(parsed).toMatchObject({
        action: "start",
        projectId: "alpha",
        host: "0.0.0.0",
        port: 18666,
        token: null,
        noOpen: true,
        config: "/cfg",
        serveProfile: "nightly",
        portal: true,
        projectRoute: true,
        registryPath: "/registry.json",
        projectRoot: "/p",
        pluginRoot: "/plugin",
        rebuildDashboard: true,
      });
    });

    it("rejects public dashboard token override", () => {
      expect(() => parseArgs(["dashboard", "start", "--project", "alpha", "--token", "tok"]))
        .toThrow(/unknown option: --token/);
    });

    it("parses dashboard build-dist", () => {
      const parsed = parseArgs([
        "dashboard", "build-dist",
        "--project", "alpha",
        "--plugin-root", "/plugin",
        "--rebuild-dashboard",
      ]);
      expect(parsed).toEqual({
        command: "dashboard",
        action: "build-dist",
        projectId: "alpha",
        pluginRoot: "/plugin",
        rebuildDashboard: true,
      });
    });

    it("rejects when --project is missing on start", () => {
      expect(() => parseArgs(["dashboard", "start"]))
        .toThrow(/missing required --project/);
    });

    it("rejects build-dist when --plugin-root is missing", () => {
      expect(() => parseArgs(["dashboard", "build-dist", "--project", "alpha"]))
        .toThrow(/missing required --plugin-root/);
    });

    it("rejects an out-of-range port", () => {
      expect(() => parseArgs([
        "dashboard", "start",
        "--project", "alpha",
        "--port", "70000",
      ])).toThrow(/--port/);
    });
  });

  describe("stop", () => {
    it("parses a stop invocation", () => {
      const parsed = parseArgs(["dashboard", "stop", "--project", "alpha"]);
      expect(parsed).toEqual({ command: "dashboard", action: "stop", projectId: "alpha" });
    });

    it("rejects when --project is missing", () => {
      expect(() => parseArgs(["dashboard", "stop"])).toThrow(/missing required --project/);
    });
  });

  describe("stop-all", () => {
    it("parses a stop-all invocation", () => {
      const parsed = parseArgs(["dashboard", "stop-all", "--projects-root", "/r"]);
      expect(parsed).toEqual({ command: "dashboard", action: "stop-all", projectsRoot: "/r" });
    });

    it("rejects when --projects-root is missing", () => {
      expect(() => parseArgs(["dashboard", "stop-all"])).toThrow(/--projects-root/);
    });
  });

  describe("status", () => {
    it("accepts --project alone", () => {
      const parsed = parseArgs(["dashboard", "status", "--project", "alpha"]);
      expect(parsed).toEqual({
        command: "dashboard",
        action: "status",
        projectId: "alpha",
        projectsRoot: null,
      });
    });

    it("accepts --projects-root alone", () => {
      const parsed = parseArgs(["dashboard", "status", "--projects-root", "/r"]);
      expect(parsed).toEqual({
        command: "dashboard",
        action: "status",
        projectId: null,
        projectsRoot: "/r",
      });
    });

    it("rejects when both --project and --projects-root are passed", () => {
      expect(() => parseArgs([
        "dashboard", "status",
        "--project", "alpha",
        "--projects-root", "/r",
      ])).toThrow(/only one/);
    });

    it("accepts neither (consumer enforces; parser permissive)", () => {
      const parsed = parseArgs(["dashboard", "status"]);
      expect(parsed).toEqual({
        command: "dashboard",
        action: "status",
        projectId: null,
        projectsRoot: null,
      });
    });
  });

  it("rejects unknown options inside dashboard", () => {
    expect(() => parseArgs(["dashboard", "start", "--project", "alpha", "--nope"]))
      .toThrow(/unknown option/);
  });

  describe("dev (D3-dev, hidden)", () => {
    it("--help-dev returns the help command", () => {
      expect(parseArgs(["dashboard", "--help-dev"]).command).toBe("help");
      expect(parseArgs(["dashboard", "dev", "--help-dev"]).command).toBe("help");
    });

    it("parses minimal dev with defaults (port 5173, host 127.0.0.1)", () => {
      const parsed = parseArgs([
        "dashboard", "dev",
        "--project", "alpha",
        "--plugin-root", "/plugin",
      ]);
      expect(parsed).toEqual({
        command: "dashboard",
        action: "dev",
        projectId: "alpha",
        pluginRoot: "/plugin",
        host: "127.0.0.1",
        port: 5173,
        noOpen: false,
      });
    });

    it("parses every dev flag", () => {
      const parsed = parseArgs([
        "dashboard", "dev",
        "--project", "alpha",
        "--plugin-root", "/plugin",
        "--host", "0.0.0.0",
        "--port", "5200",
        "--no-open",
      ]);
      expect(parsed).toEqual({
        command: "dashboard",
        action: "dev",
        projectId: "alpha",
        pluginRoot: "/plugin",
        host: "0.0.0.0",
        port: 5200,
        noOpen: true,
      });
    });

    it("rejects when --project is missing", () => {
      expect(() => parseArgs(["dashboard", "dev", "--plugin-root", "/p"]))
        .toThrow(/dashboard dev: missing required --project/);
    });

    it("rejects when --plugin-root is missing", () => {
      expect(() => parseArgs(["dashboard", "dev", "--project", "alpha"]))
        .toThrow(/dashboard dev: missing required --plugin-root/);
    });

    it("rejects unknown options", () => {
      expect(() => parseArgs([
        "dashboard", "dev",
        "--project", "alpha",
        "--plugin-root", "/p",
        "--bogus",
      ])).toThrow(/unknown option/);
    });
  });
});

describe("parseArgs — gateway subcommand (D5)", () => {
  it("gateway with no action returns help", () => {
    expect(parseArgs(["gateway"]).command).toBe("help");
    expect(parseArgs(["gateway", "-h"]).command).toBe("help");
  });

  it("rejects an unknown gateway subcommand", () => {
    expect(() => parseArgs(["gateway", "nope"])).toThrow(/unknown gateway subcommand/);
  });

  describe("publish", () => {
    it("parses minimal publish", () => {
      const parsed = parseArgs(["gateway", "publish", "v123", "--projects-root", "/r"]);
      expect(parsed).toEqual({
        command: "gateway",
        action: "publish",
        projectsRoot: "/r",
        versionId: "v123",
        stable: false,
        retain: null,
        reason: null,
        gc: false,
        pluginRoot: null,
      });
    });

    it("parses auto publish without an explicit versionId", () => {
      const parsed = parseArgs([
        "gateway", "publish",
        "--projects-root", "/r",
        "--gc",
        "--plugin-root", "/plugin",
      ]);
      expect(parsed).toEqual({
        command: "gateway",
        action: "publish",
        projectsRoot: "/r",
        versionId: null,
        stable: false,
        retain: null,
        reason: null,
        gc: true,
        pluginRoot: "/plugin",
      });
    });

    it("parses every flag", () => {
      const parsed = parseArgs([
        "gateway", "publish", "v1",
        "--projects-root", "/r",
        "--stable",
        "--retain", "5",
        "--reason", "hotfix",
        "--gc",
        "--plugin-root", "/plugin",
      ]);
      expect(parsed).toMatchObject({
        action: "publish",
        versionId: "v1",
        stable: true,
        retain: 5,
        reason: "hotfix",
        gc: true,
        pluginRoot: "/plugin",
      });
    });

    it("rejects unexpected extra positional args", () => {
      expect(() => parseArgs(["gateway", "publish", "v1", "v2", "--projects-root", "/r"]))
        .toThrow(/unexpected positional/);
    });

    it("rejects --retain with non-positive value", () => {
      expect(() => parseArgs(["gateway", "publish", "v1", "--projects-root", "/r", "--retain", "0"]))
        .toThrow(/--retain/);
    });
  });

  describe("set-stable", () => {
    it("parses with explicit versionId", () => {
      const parsed = parseArgs(["gateway", "set-stable", "v1", "--projects-root", "/r"]);
      expect(parsed).toEqual({
        command: "gateway",
        action: "set-stable",
        projectsRoot: "/r",
        versionId: "v1",
      });
    });

    it("parses without versionId (defaults to current)", () => {
      const parsed = parseArgs(["gateway", "set-stable", "--projects-root", "/r"]);
      expect(parsed).toEqual({
        command: "gateway",
        action: "set-stable",
        projectsRoot: "/r",
        versionId: null,
      });
    });
  });

  describe("rollback", () => {
    it("parses rollback", () => {
      const parsed = parseArgs(["gateway", "rollback", "--projects-root", "/r"]);
      expect(parsed).toEqual({ command: "gateway", action: "rollback", projectsRoot: "/r" });
    });

    it("rejects positional args", () => {
      expect(() => parseArgs(["gateway", "rollback", "extra", "--projects-root", "/r"]))
        .toThrow(/unexpected positional/);
    });
  });

  describe("list", () => {
    it("parses list with --json", () => {
      const parsed = parseArgs(["gateway", "list", "--json", "--projects-root", "/r"]);
      expect(parsed).toEqual({
        command: "gateway",
        action: "list",
        projectsRoot: "/r",
        json: true,
      });
    });

    it("parses list without --json", () => {
      const parsed = parseArgs(["gateway", "list", "--projects-root", "/r"]);
      expect(parsed).toEqual({
        command: "gateway",
        action: "list",
        projectsRoot: "/r",
        json: false,
      });
    });
  });

  describe("gc", () => {
    it("parses gc with --retain", () => {
      const parsed = parseArgs(["gateway", "gc", "--retain", "3", "--projects-root", "/r"]);
      expect(parsed).toEqual({
        command: "gateway",
        action: "gc",
        projectsRoot: "/r",
        retain: 3,
      });
    });

    it("parses gc without --retain", () => {
      const parsed = parseArgs(["gateway", "gc", "--projects-root", "/r"]);
      expect(parsed).toEqual({
        command: "gateway",
        action: "gc",
        projectsRoot: "/r",
        retain: null,
      });
    });
  });

  describe("start / stop", () => {
    it("parses shared gateway start without exposing state-dir", () => {
      const parsed = parseArgs([
        "gateway", "start",
        "--projects-root", "/r",
        "--host", "0.0.0.0",
        "--port", "18666",
        "--no-open",
        "--serve-profile", "prod",
        "--config", "/cfg/deploy.yaml",
      ]);
      expect(parsed).toEqual({
        command: "gateway",
        action: "start",
        projectsRoot: "/r",
        host: "0.0.0.0",
        port: 18666,
        noOpen: true,
        serveProfile: "prod",
        config: "/cfg/deploy.yaml",
      });
    });

    it("parses shared gateway stop", () => {
      const parsed = parseArgs(["gateway", "stop", "--projects-root", "/r"]);
      expect(parsed).toEqual({ command: "gateway", action: "stop", projectsRoot: "/r" });
    });
  });

  it("falls back to UA_PROJECTS_ROOT when --projects-root is omitted", () => {
    const original = process.env.UA_PROJECTS_ROOT;
    process.env.UA_PROJECTS_ROOT = "/env-root";
    try {
      const parsed = parseArgs(["gateway", "rollback"]);
      expect((parsed as { projectsRoot: string }).projectsRoot).toBe("/env-root");
    } finally {
      if (original === undefined) delete process.env.UA_PROJECTS_ROOT;
      else process.env.UA_PROJECTS_ROOT = original;
    }
  });

  describe("review-graph-health", () => {
    it("parses --project / --output", () => {
      const parsed = parseArgs([
        "review-graph-health",
        "--project", "alpha",
        "--output", "/r/review.json",
      ]);
      expect(parsed).toEqual({
        command: "review-graph-health",
        projectId: "alpha",
        output: "/r/review.json",
      });
    });

    it("rejects when --project or --output is missing", () => {
      const before = {
        projectId: process.env.UA_PROJECT_ID,
        json: process.env.UA_REVIEW_JSON,
      };
      delete process.env.UA_PROJECT_ID;
      delete process.env.UA_REVIEW_JSON;
      try {
        expect(() => parseArgs(["review-graph-health", "--output", "/o"]))
          .toThrow(/missing required --project/);
        expect(() => parseArgs(["review-graph-health", "--project", "alpha"]))
          .toThrow(/missing required --output/);
      } finally {
        if (before.projectId !== undefined) process.env.UA_PROJECT_ID = before.projectId;
        if (before.json !== undefined) process.env.UA_REVIEW_JSON = before.json;
      }
    });

    it("falls back to UA_PROJECT_ID / UA_REVIEW_JSON env vars", () => {
      const before = {
        projectId: process.env.UA_PROJECT_ID,
        json: process.env.UA_REVIEW_JSON,
      };
      process.env.UA_PROJECT_ID = "env-project";
      process.env.UA_REVIEW_JSON = "/env-out";
      try {
        const parsed = parseArgs(["review-graph-health"]);
        expect(parsed).toEqual({
          command: "review-graph-health",
          projectId: "env-project",
          output: "/env-out",
        });
      } finally {
        if (before.projectId === undefined) delete process.env.UA_PROJECT_ID;
        else process.env.UA_PROJECT_ID = before.projectId;
        if (before.json === undefined) delete process.env.UA_REVIEW_JSON;
        else process.env.UA_REVIEW_JSON = before.json;
      }
    });

    it("rejects unknown options", () => {
      expect(() => parseArgs(["review-graph-health", "--bogus"]))
        .toThrow(ArgsError);
    });
  });

  describe("run-review-hook", () => {
    it("parses --review-cmd", () => {
      const before = process.env.UA_REVIEW_CMD;
      delete process.env.UA_REVIEW_CMD;
      try {
        const parsed = parseArgs(["run-review-hook", "--review-cmd", "echo ok"]);
        expect(parsed).toEqual({ command: "run-review-hook", reviewCmd: "echo ok" });
      } finally {
        if (before !== undefined) process.env.UA_REVIEW_CMD = before;
      }
    });

    it("falls back to UA_REVIEW_CMD env var when --review-cmd omitted", () => {
      const before = process.env.UA_REVIEW_CMD;
      process.env.UA_REVIEW_CMD = "/usr/bin/run-hook.sh";
      try {
        const parsed = parseArgs(["run-review-hook"]);
        expect(parsed).toEqual({ command: "run-review-hook", reviewCmd: "/usr/bin/run-hook.sh" });
      } finally {
        if (before === undefined) delete process.env.UA_REVIEW_CMD;
        else process.env.UA_REVIEW_CMD = before;
      }
    });

    it("returns empty reviewCmd when no flag and no env (downstream maps to MISSING_COMMAND)", () => {
      const before = process.env.UA_REVIEW_CMD;
      delete process.env.UA_REVIEW_CMD;
      try {
        const parsed = parseArgs(["run-review-hook"]);
        expect(parsed).toEqual({ command: "run-review-hook", reviewCmd: "" });
      } finally {
        if (before !== undefined) process.env.UA_REVIEW_CMD = before;
      }
    });

    it("rejects unknown options", () => {
      expect(() => parseArgs(["run-review-hook", "--bogus"]))
        .toThrow(ArgsError);
    });
  });
});

describe("parseArgs — project-state subcommand (G27)", () => {
  it("project-state with no action returns help", () => {
    expect(parseArgs(["project-state"]).command).toBe("help");
  });

  it("parses publish", () => {
    const parsed = parseArgs(["project-state", "publish", "v1", "--project", "alpha", "--source-root", "/repo", "--stable", "--retain", "3"]);
    expect(parsed).toEqual({
      command: "project-state",
      action: "publish",
      projectId: "alpha",
      versionId: "v1",
      sourceRoot: "/repo",
      stable: true,
      retain: 3,
    });
  });

  it("parses set-stable/list/gc", () => {
    expect(parseArgs(["project-state", "set-stable", "v1", "--project", "alpha"])).toEqual({
      command: "project-state",
      action: "set-stable",
      projectId: "alpha",
      versionId: "v1",
    });
    expect(parseArgs(["project-state", "list", "--project", "alpha"])).toEqual({
      command: "project-state",
      action: "list",
      projectId: "alpha",
    });
    expect(parseArgs(["project-state", "gc", "--project", "alpha"])).toEqual({
      command: "project-state",
      action: "gc",
      projectId: "alpha",
      retain: null,
    });
  });

  it("parses rollback (no positional, no extra flags)", () => {
    expect(parseArgs(["project-state", "rollback", "--project", "alpha"])).toEqual({
      command: "project-state",
      action: "rollback",
      projectId: "alpha",
    });
  });

  it("rejects positional arg on rollback", () => {
    expect(() => parseArgs(["project-state", "rollback", "v1", "--project", "alpha"])).toThrow(/unexpected positional/);
  });

  it("rejects missing project id or version id", () => {
    expect(() => parseArgs(["project-state", "publish", "v1"])).toThrow(/missing required --project/);
    expect(() => parseArgs(["project-state", "publish", "--project", "alpha"])).toThrow(/missing required <versionId>/);
  });
});

describe("parseArgs repair subcommands", () => {
  it("parses repair llm-failures with all options", () => {
    const parsed = parseArgs([
      "repair",
      "llm-failures",
      "--project", "alpha",
      "--plugin-root", "/p",
      "--llm-provider", "pkg-llm",
      "--config", "/deploy.yaml",
      "--repair-max-tasks", "5",
    ]);
    expect(parsed).toEqual({
      command: "repair",
      action: "llm-failures",
      projectId: "alpha",
      pluginRoot: "/p",
      llmProvider: "pkg-llm",
      config: "/deploy.yaml",
      dryRun: false,
      maxTasks: 5,
      noDashboard: true,
    });
  });

  it("accepts --project for llm-graph-failures with defaults", () => {
    const parsed = parseArgs(["repair", "llm-graph-failures", "--project", "alpha"]);
    expect(parsed).toEqual({
      command: "repair",
      action: "llm-graph-failures",
      projectId: "alpha",
      pluginRoot: null,
      llmProvider: null,
      config: null,
      dryRun: false,
      maxTasks: null,
      noDashboard: true,
    });
  });

  it("sets dryRun for --repair-dry-run and always implies --no-dashboard", () => {
    const parsed = parseArgs(["repair", "llm-failures", "--project", "alpha", "--repair-dry-run", "--no-dashboard"]);
    if (parsed.command !== "repair") throw new Error("expected repair");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.noDashboard).toBe(true);
  });

  it("returns help with no subcommand or --help", () => {
    expect(parseArgs(["repair"]).command).toBe("help");
    expect(parseArgs(["repair", "--help"]).command).toBe("help");
    expect(parseArgs(["repair", "llm-failures", "--help"]).command).toBe("help");
  });

  it("rejects an unknown subcommand", () => {
    expect(() => parseArgs(["repair", "bogus"])).toThrow(ArgsError);
  });

  it("rejects a missing --project", () => {
    expect(() => parseArgs(["repair", "llm-failures"])).toThrow(/missing required --project/);
  });

  it("rejects an invalid --repair-max-tasks", () => {
    expect(() => parseArgs(["repair", "llm-failures", "--project", "alpha", "--repair-max-tasks", "0"])).toThrow(ArgsError);
    expect(() => parseArgs(["repair", "llm-failures", "--project", "alpha", "--repair-max-tasks", "x"])).toThrow(ArgsError);
  });

  it("rejects unknown options and a second positional", () => {
    expect(() => parseArgs(["repair", "llm-failures", "--project", "alpha", "--bogus"])).toThrow(ArgsError);
    expect(() => parseArgs(["repair", "llm-failures", "--project", "alpha", "/extra"])).toThrow(/unexpected positional/);
  });
});

describe("parseArgs notify subcommand", () => {
  it("returns help with no subcommand or --help", () => {
    expect(parseArgs(["notify"]).command).toBe("help");
    expect(parseArgs(["notify", "--help"]).command).toBe("help");
    expect(parseArgs(["notify", "-h"]).command).toBe("help");
    expect(parseArgs(["notify", "nightly", "--help"]).command).toBe("help");
  });

  it("rejects an unknown subcommand", () => {
    expect(() => parseArgs(["notify", "bogus"])).toThrow(/unknown notify subcommand/);
  });

  it("requires --report", () => {
    expect(() => parseArgs(["notify", "nightly"])).toThrow(/missing required --report/);
    expect(() => parseArgs(["notify", "nightly", "--dry-run"])).toThrow(/missing required --report/);
  });

  it("parses a minimal nightly invocation", () => {
    const parsed = parseArgs(["notify", "nightly", "--report", "/p/agg.json"]);
    expect(parsed).toEqual({
      command: "notify",
      action: "nightly",
      report: "/p/agg.json",
      provider: null,
      config: null,
      bestEffort: false,
      dryRun: false,
    });
  });

  it("parses every supported flag", () => {
    const parsed = parseArgs([
      "notify",
      "nightly",
      "--report",
      "/p/agg.json",
      "--notify-provider",
      "@example/lark-im-notify",
      "--config",
      "/p/deploy.yaml",
      "--best-effort",
      "--dry-run",
    ]);
    expect(parsed).toEqual({
      command: "notify",
      action: "nightly",
      report: "/p/agg.json",
      provider: "@example/lark-im-notify",
      config: "/p/deploy.yaml",
      bestEffort: true,
      dryRun: true,
    });
  });

  it("rejects unknown options", () => {
    expect(() =>
      parseArgs(["notify", "nightly", "--report", "/r", "--bogus"]),
    ).toThrow(/unknown option/);
  });

  it("rejects flags missing values", () => {
    expect(() => parseArgs(["notify", "nightly", "--report"])).toThrow(/missing value/);
    expect(() =>
      parseArgs(["notify", "nightly", "--report", "/r", "--notify-provider"]),
    ).toThrow(/missing value/);
  });
});
