/**
 * Project registry — JSON-file-backed store of runtime project records.
 *
 * The registry maps a project id to its access/runtime metadata so the gateway
 * can build the portal listing and route `/project/<id>/` traffic. It is a
 * self-contained fs store: the caller supplies the registry file path (the
 * gateway owns the state-dir layout), so this module carries no deploy-specific
 * directory conventions, versioned-state, or SSO coupling.
 */

import { dirname } from "node:path";
import { mkdirSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import registrySchema from "./registry.schema.json" with { type: "json" };

export const PUBLIC_PROJECT_ROUTE_PREFIX = "/project/";

export type ProjectRuntimeMode = "prod" | "dev" | "";

export interface ProjectRegistryRecord {
  id: string;
  name: string;
  projectRoot: string;
  stateRoot: string;
  accessUrl: string;
  dashboardUrl: string;
  internalUrl: string;
  publicPath: string;
  runtimeMode: ProjectRuntimeMode;
  prodDistDir: string;
  prodToken: string;
  status: string;
  updatedAt?: string;
}

export interface ProjectRegistry {
  version: number;
  updatedAt: string | null;
  projects: Record<string, ProjectRegistryRecord>;
}

export interface UpsertProjectPayload {
  name?: string;
  accessUrl?: string;
  dashboardUrl?: string;
  internalUrl?: string;
  publicPath?: string;
  runtimeMode?: ProjectRuntimeMode;
  prodDistDir?: string;
  prodToken?: string;
  status?: string;
}

function pad(value: number, width = 2): string {
  return String(Math.trunc(Math.abs(value))).padStart(width, "0");
}

function formatLocalTimestamp(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const milliseconds = pad(date.getMilliseconds(), 3);
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainderMinutes = pad(Math.abs(offsetMinutes) % 60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${offsetSign}${offsetHours}:${offsetRemainderMinutes}`;
}

export function normalizeOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  const value = String(origin).trim();
  if (!value) return null;
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function buildPublicProjectPath(projectId: string, suffix = "/"): string {
  const encodedProjectId = encodeURIComponent(String(projectId ?? "").trim());
  if (!encodedProjectId) return "";
  if (!suffix || suffix === "/") return `${PUBLIC_PROJECT_ROUTE_PREFIX}${encodedProjectId}/`;
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${PUBLIC_PROJECT_ROUTE_PREFIX}${encodedProjectId}${normalizedSuffix}`;
}

export interface ParsedPublicProjectPath {
  projectId: string;
  upstreamPath: string;
}

export function parsePublicProjectPath(pathname: string): ParsedPublicProjectPath | null {
  if (!pathname || !pathname.startsWith(PUBLIC_PROJECT_ROUTE_PREFIX)) return null;
  const remainder = pathname.slice(PUBLIC_PROJECT_ROUTE_PREFIX.length);
  if (!remainder) return null;
  const slashIndex = remainder.indexOf("/");
  const rawProjectId = slashIndex < 0 ? remainder : remainder.slice(0, slashIndex);
  const rawSuffix = slashIndex < 0 ? "/" : remainder.slice(slashIndex) || "/";
  if (!rawProjectId) return null;
  try {
    return {
      projectId: decodeURIComponent(rawProjectId),
      upstreamPath: rawSuffix || "/",
    };
  } catch {
    return null;
  }
}

export function createEmptyProjectRegistry(): ProjectRegistry {
  return { version: 2, updatedAt: null, projects: {} };
}

export interface ProjectRegistryValidation {
  valid: boolean;
  errors: string[];
}

let compiledRegistrySchema: ValidateFunction | undefined;

function getRegistryValidator(): ValidateFunction {
  if (compiledRegistrySchema) return compiledRegistrySchema;
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  compiledRegistrySchema = ajv.compile(registrySchema as object);
  return compiledRegistrySchema;
}

function formatRegistryError(err: ErrorObject): string {
  const where = err.instancePath || "(root)";
  return `${where} ${err.message ?? "is invalid"}`;
}

/**
 * Validate a parsed registry against the schema. The registry is a runtime,
 * machine-written state file, so callers use this for observability (warn-only)
 * rather than fatal rejection — see {@link ProjectRegistryStore.read}.
 */
export function validateProjectRegistry(registry: unknown): ProjectRegistryValidation {
  const validate = getRegistryValidator();
  const valid = validate(registry) as boolean;
  return { valid, errors: valid ? [] : (validate.errors ?? []).map(formatRegistryError) };
}

function normalizeProjectRegistryRecord(
  record: Partial<ProjectRegistryRecord> | null | undefined,
): ProjectRegistryRecord | null {
  if (!record || typeof record !== "object") return null;
  const projectId = record.id ?? "";
  const runtimeMode = (record.runtimeMode ?? "") as ProjectRuntimeMode;
  return {
    ...record,
    id: projectId,
    name: record.name ?? projectId,
    projectRoot: record.projectRoot ?? "",
    stateRoot: record.stateRoot ?? "",
    accessUrl: record.accessUrl ?? "",
    dashboardUrl: record.dashboardUrl ?? "",
    internalUrl:
      runtimeMode === "prod"
        ? ""
        : normalizeOrigin(record.internalUrl ?? record.accessUrl ?? "") ?? "",
    publicPath: record.publicPath ?? (projectId ? buildPublicProjectPath(projectId) : ""),
    runtimeMode,
    prodDistDir: record.prodDistDir ?? "",
    prodToken: record.prodToken ?? "",
    status: record.status ?? "running",
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * JSON-file-backed project registry, bound to a single registry file path.
 *
 * The path is the store's identity, so it is supplied once at construction
 * instead of being threaded through every operation. Mutations share one
 * directory-lock + read-modify-write helper rather than re-deriving it per
 * call. Pure path/predicate helpers stay as free functions below — they carry
 * no state and are reused without a store instance.
 */
export interface ProjectRegistryStoreOptions {
  /**
   * Called when a parsed-but-schema-invalid registry is read. The default logs
   * a warning. Validation is warn-only: read() still returns the parsed value
   * so a registry written by a newer/older writer never bricks the gateway.
   */
  onInvalid?: (errors: string[]) => void;
}

export class ProjectRegistryStore {
  private readonly onInvalid: (errors: string[]) => void;

  constructor(
    private readonly registryPath: string,
    options: ProjectRegistryStoreOptions = {},
  ) {
    this.onInvalid =
      options.onInvalid ??
      ((errors) => console.warn(`project registry schema warnings: ${errors.join("; ")}`));
  }

  read(): ProjectRegistry {
    if (!existsSync(this.registryPath)) return createEmptyProjectRegistry();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.registryPath, "utf8"));
    } catch {
      return createEmptyProjectRegistry();
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as ProjectRegistry).projects !== "object" ||
      Array.isArray((parsed as ProjectRegistry).projects)
    ) {
      return createEmptyProjectRegistry();
    }
    const validation = validateProjectRegistry(parsed);
    if (!validation.valid) this.onInvalid(validation.errors);
    return parsed as ProjectRegistry;
  }

  list(): ProjectRegistryRecord[] {
    const registry = this.read();
    return Object.values(registry.projects ?? {})
      .map((project) => normalizeProjectRegistryRecord(project))
      .filter((project): project is ProjectRegistryRecord => project !== null)
      .sort((left, right) =>
        String(left.name || left.id || "").localeCompare(String(right.name || right.id || "")),
      );
  }

  get(projectId: string): ProjectRegistryRecord | null {
    if (!projectId) return null;
    const registry = this.read();
    return normalizeProjectRegistryRecord(registry.projects?.[projectId]);
  }

  upsert(
    projectId: string,
    projectRoot: string,
    stateRoot: string,
    payload: UpsertProjectPayload = {},
  ): ProjectRegistryRecord {
    return this.withLock(() => {
      const registry = this.read();
      registry.version = Math.max(Number(registry.version) || 1, 2);
      const current = registry.projects[projectId] ?? ({} as Partial<ProjectRegistryRecord>);
      const runtimeMode = (payload.runtimeMode ?? current.runtimeMode ?? "") as ProjectRuntimeMode;
      const internalUrl =
        runtimeMode === "prod"
          ? ""
          : payload.internalUrl ?? current.internalUrl ?? payload.accessUrl ?? "";
      const next: ProjectRegistryRecord = {
        ...current,
        id: projectId,
        name: payload.name ?? current.name ?? projectId,
        // Never overwrite a previously good projectRoot with an empty value:
        // prod data API path sanitization relies on it to relativize node
        // filePath against the source repo. In versioned mode the stateRoot is
        // the version dir, so this is the only place that holds the repo root.
        projectRoot: projectRoot || current.projectRoot || "",
        stateRoot,
        accessUrl: payload.accessUrl ?? current.accessUrl ?? "",
        dashboardUrl: payload.dashboardUrl ?? current.dashboardUrl ?? payload.accessUrl ?? "",
        internalUrl,
        publicPath: payload.publicPath ?? current.publicPath ?? buildPublicProjectPath(projectId),
        runtimeMode,
        prodDistDir: payload.prodDistDir ?? current.prodDistDir ?? "",
        prodToken: payload.prodToken ?? current.prodToken ?? "",
        status: payload.status ?? "running",
        updatedAt: formatLocalTimestamp(),
      };
      registry.projects[projectId] = next;
      registry.updatedAt = formatLocalTimestamp();
      this.write(registry);
      return normalizeProjectRegistryRecord(next) as ProjectRegistryRecord;
    });
  }

  remove(projectId: string): boolean {
    return this.withLock(() => {
      const registry = this.read();
      if (!registry.projects[projectId]) return false;
      delete registry.projects[projectId];
      registry.updatedAt = formatLocalTimestamp();
      this.write(registry);
      return true;
    });
  }

  clear(): void {
    this.withLock(() => this.write(createEmptyProjectRegistry()));
  }

  private write(registry: ProjectRegistry): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const tmpPath = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(registry, null, 2), "utf8");
    renameSync(tmpPath, this.registryPath);
  }

  private withLock<T>(callback: () => T): T {
    const lockDir = `${this.registryPath}.lock`;
    const deadline = Date.now() + 10000;
    mkdirSync(dirname(this.registryPath), { recursive: true });
    for (;;) {
      try {
        mkdirSync(lockDir, { recursive: false });
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`project registry lock timeout: ${lockDir}`);
        sleepSync(50);
      }
    }
    try {
      return callback();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

export function hasProjectDirectProdRuntime(
  project: ProjectRegistryRecord | null | undefined,
): boolean {
  return Boolean(
    project &&
      project.status === "running" &&
      project.runtimeMode === "prod" &&
      project.stateRoot &&
      project.prodDistDir &&
      project.prodToken,
  );
}

export function hasProjectProxyRuntime(
  project: ProjectRegistryRecord | null | undefined,
): boolean {
  return Boolean(project?.status === "running" && project?.runtimeMode === "dev" && project?.internalUrl);
}

export function hasProjectLiveAccess(
  project: ProjectRegistryRecord | null | undefined,
): boolean {
  return Boolean(
    project?.status === "running" &&
      (hasProjectProxyRuntime(project) || hasProjectDirectProdRuntime(project)),
  );
}
