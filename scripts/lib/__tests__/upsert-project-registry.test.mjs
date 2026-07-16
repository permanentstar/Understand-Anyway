#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeAccessHost, pruneRegistryRecords, resolveGatewayEntry, upsertProdRegistryRecord } from "../upsert-project-registry.mjs";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    process.stdout.write(`  ok  ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL ${name}\n`);
    if (detail) process.stdout.write(`    ${detail}\n`);
  }
}

const work = mkdtempSync(resolve(tmpdir(), "ua-registry-helper-"));

try {
  const calls = [];
  class FakeStore {
    constructor(path) {
      this.path = path;
    }
    get(projectId) {
      calls.push({ type: "get", projectId, path: this.path });
      return null;
    }
    upsert(projectId, projectRoot, stateRoot, payload) {
      calls.push({ type: "upsert", projectId, projectRoot, stateRoot, payload, path: this.path });
      return { id: projectId, projectRoot, stateRoot, ...payload };
    }
  }

  const result = await upsertProdRegistryRecord({
    registryPath: resolve(work, "registry.json"),
    projectId: "alpha",
    projectRoot: "/repo/alpha",
    stateRoot: "/state/alpha",
    host: "127.0.0.1",
    port: 18666,
  }, {
    Store: FakeStore,
    tokenFactory: () => "tok-fixed",
    now: () => "2026-06-26T00:00:00.000Z",
  });

  check("helper: calls get first", calls[0]?.type === "get", JSON.stringify(calls));
  check("helper: calls upsert second", calls[1]?.type === "upsert", JSON.stringify(calls));
  check(
    "helper: upsert payload uses prod runtime semantics",
    calls[1]?.payload?.runtimeMode === "prod"
      && calls[1]?.payload?.prodDistDir === "/state/alpha/dashboard-dist"
      && calls[1]?.payload?.prodToken === "tok-fixed"
      && calls[1]?.payload?.accessUrl === "http://127.0.0.1:18666/project/alpha/",
    JSON.stringify(calls[1]),
  );
  check("helper: returns the store result", result?.prodToken === "tok-fixed", JSON.stringify(result));

  const wildcardHostResult = await upsertProdRegistryRecord({
    registryPath: resolve(work, "registry.json"),
    projectId: "wildcard",
    projectRoot: "/repo/wildcard",
    stateRoot: "/state/wildcard",
    host: "0.0.0.0",
    port: 18666,
  }, {
    Store: FakeStore,
    tokenFactory: () => "tok-wildcard",
  });
  check(
    "helper: normalizes wildcard bind host for access URLs",
    wildcardHostResult?.accessUrl === "http://127.0.0.1:18666/project/wildcard/"
      && wildcardHostResult?.dashboardUrl === "http://127.0.0.1:18666/project/wildcard/",
    JSON.stringify(wildcardHostResult),
  );
  check("normalizeAccessHost keeps ordinary hosts", normalizeAccessHost("localhost") === "localhost");
  check("normalizeAccessHost maps IPv6 wildcard", normalizeAccessHost("[::]") === "127.0.0.1");

  const records = new Map([
    ["alpha", { id: "alpha" }],
    ["stale", { id: "stale" }],
  ]);
  class PruneStore {
    list() {
      return Array.from(records.values());
    }
    remove(id) {
      return records.delete(id);
    }
  }
  const removed = await pruneRegistryRecords({
    registryPath: resolve(work, "registry.json"),
    projectIds: ["alpha"],
  }, {
    Store: PruneStore,
  });
  check(
    "helper: prunes records missing from discovered projects",
    removed.length === 1 && removed[0] === "stale" && records.has("alpha") && !records.has("stale"),
    JSON.stringify({ removed, records: Array.from(records.keys()) }),
  );

  // resolveGatewayEntry: prefer installed @understand-anyway/gateway (npm
  // layout), fall back to monorepo packages/gateway/dist (source checkout).
  {
    const npmEntry = "file:///pkg/node_modules/@understand-anyway/gateway/dist/index.js";
    const resolvedNpm = resolveGatewayEntry("/any/root", {
      metaResolve: (spec) => {
        if (spec === "@understand-anyway/gateway") return npmEntry;
        throw new Error("not found");
      },
      exists: () => true,
    });
    check("resolveGatewayEntry: prefers installed gateway", resolvedNpm === npmEntry, resolvedNpm);
  }
  {
    const sourceEntry = pathToFileURL(resolve("/repo", "packages", "gateway", "dist", "index.js")).href;
    const resolvedSrc = resolveGatewayEntry("/repo", {
      metaResolve: () => {
        throw new Error("Cannot find package '@understand-anyway/gateway'");
      },
      exists: (p) => p === resolve("/repo", "packages", "gateway", "dist", "index.js"),
    });
    check("resolveGatewayEntry: falls back to source dist", resolvedSrc === sourceEntry, resolvedSrc);
  }
  {
    let threw = false;
    try {
      resolveGatewayEntry("/repo", {
        metaResolve: () => {
          throw new Error("nope");
        },
        exists: () => false,
      });
    } catch {
      threw = true;
    }
    check("resolveGatewayEntry: throws when neither resolves", threw);
  }

} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  process.stdout.write(`\n${failures} test(s) failed\n`);
  process.exit(1);
}

process.stdout.write("\nall tests passed\n");
