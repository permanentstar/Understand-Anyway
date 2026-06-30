/**
 * Provider interfaces for Understand-Anyway.
 *
 * The open-source core ships these interfaces plus default (noop/generic)
 * implementations. In-house specializations (Feishu SSO, org directory authz,
 * external record sinks, vendor LLM CLIs) live in a private overlay package
 * that implements these same interfaces.
 */

export * from "./auth.js";
export * from "./org-policy.js";
export * from "./record.js";
export * from "./llm.js";
export * from "./embedding.js";
export * from "./notify.js";
export * from "./registry.js";
export * from "./provider-factory.js";
export * from "./config.js";
