/**
 * Single-shot config loading: discover → parse → interpolate → ResolvedConfig.
 *
 * `serve` calls this once at startup; the result is then layered with CLI flags
 * and the selected profile and handed to both builders, replacing the previous
 * three independent `JSON.parse(readFileSync)` reads. All fs / env / yaml access
 * goes through injectable deps so tests can drive it with fakes.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYamlDefault } from "yaml";
import type { ProfileSection, ResolvedConfig } from "@understand-anyway/plugin-api";
import { ArgsError, type ServeArgs } from "../args.js";
import { discoverConfigPath } from "./discover.js";
import { loadDotenv } from "./dotenv.js";
import { interpolate } from "./interpolate.js";
import { formatSchemaErrors, validateDeployConfig, type DeployConfigValidation } from "./schema.js";

export interface LoadResolvedConfigArgs extends Pick<ServeArgs, "config"> {
  /** True only when the user explicitly passed --config. Derived default paths stay optional. */
  configExplicit?: boolean;
  /** Optional deployment profile selector; falls back to UA_DEPLOY_PROFILE when omitted. */
  deployProfile?: string | null;
}

export interface LoadConfigDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  parseYaml?: (text: string) => unknown;
  /** Pre-resolved secret `.env` map; when absent it is loaded from the chain. */
  dotenv?: Record<string, string>;
  /** Executable project root override (for discovery). */
  exeRoot?: string;
  /** Schema validation hook (injectable for tests). */
  validateConfig?: (config: unknown) => DeployConfigValidation;
}

/** Discover, read, parse + interpolate the deploy config into a ResolvedConfig. */
export function loadResolvedConfig(args: LoadResolvedConfigArgs, deps: LoadConfigDeps = {}): ResolvedConfig {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? ((path: string) => existsSync(path));
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const parseYaml = deps.parseYaml ?? ((text: string) => parseYamlDefault(text) as unknown);

  const path = discoverConfigPath(args.config, { cwd, env, fileExists, exeRoot: deps.exeRoot });
  if (!path) {
    if (args.config && (args.configExplicit ?? true)) throw new ArgsError(`config not found: ${args.config}`);
    return {};
  }

  let raw: string;
  try {
    raw = readFile(path);
  } catch (err) {
    throw new ArgsError(`failed to read --config ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ArgsError(`failed to parse config ${path}: ${(err as Error).message}`);
  }
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArgsError(`config ${path} must be a YAML mapping`);
  }

  const validate = deps.validateConfig ?? validateDeployConfig;
  const result = validate(parsed);
  if (!result.valid) {
    throw new ArgsError(`invalid config ${path}: ${formatSchemaErrors(result.errors)}`);
  }

  const dotenv = deps.dotenv ?? loadDotenv({ configDir: dirname(path), fileExists, readFile });
  const config = interpolate(parsed, { env, dotenv, readFile }) as ResolvedConfig;
  return applyDeployProfile(config, args.deployProfile ?? env.UA_DEPLOY_PROFILE ?? null);
}

function applyDeployProfile(config: ResolvedConfig, name: string | null): ResolvedConfig {
  const profileName = name?.trim();
  if (!profileName) return config;
  const profile = config.deployProfiles?.[profileName];
  if (!profile) throw new ArgsError(`unknown --deploy-profile: ${profileName}`);
  return {
    ...config,
    deploy: profile.deploy ? { ...config.deploy, ...profile.deploy } : config.deploy,
    gateway: profile.gateway ? { ...config.gateway, ...profile.gateway } : config.gateway,
  };
}

/** Resolve the selected serve profile; throws when a named profile is missing. */
export function selectProfile(config: ResolvedConfig, name: string | null): ProfileSection | undefined {
  if (!name) return undefined;
  const profile = config.profiles?.[name];
  if (!profile) throw new ArgsError(`unknown --serve-profile: ${name}`);
  return profile;
}
