#!/usr/bin/env node
// scripts/__tests__/write-external-records.test.mjs
//
// End-to-end alignment: feed a real-shaped aggregate JSON through
// write-external-records.mjs with a mock Feishu Sheets client and assert
// (a) each configured column has a value in the appended row, so no field name
//     silently drifts from the payload keys, and
// (b) the header PUT payload equals the column list (so the sheet header is
//     kept in sync automatically).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

const providerModule = await import(
  new URL("../../packages/provider-feishu-sheets/dist/index.js", import.meta.url).href
);
const { FeishuSheetsRecordProvider } = providerModule;

const {
  NIGHTLY_COLUMNS,
  PROJECT_COLUMNS,
  buildNightlyEnvelope,
  buildProjectEnvelopes,
  resolveRuntime,
} = await import(new URL("../write-external-records.mjs", import.meta.url).href);

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

// Prod aggregate shape captured from
// ~/understand-anyway-projects/gateway/operations/nightly-latest.json
// on 10.37.14.13. Keep this fixture close to the real payload so any
// upstream schema shift also breaks these tests.
const aggregateFixture = {
  runId: "20260714-170836",
  startedAt: "2026-07-14T17:08:36+08:00",
  finishedAt: "2026-07-14T17:08:44+08:00",
  overallStatus: "partial_success",
  projectCount: 3,
  successCount: 0,
  failedCount: 1,
  buildSuccessCount: 0,
  logs: {
    result:
      "/home/suheng.cloud/understand-anyway-projects/gateway/operations/nightly-runs/20260714-170836/result.json",
  },
  projects: [
    {
      projectName: "bytedcli",
      repoPath: "/home/suheng.cloud/project/bytedcli",
      stateDir: "/home/suheng.cloud/understand-anyway-projects/projects/bytedcli",
      commit: "5c30301122f15e41a1034b63094e1ac0cc8a519d",
      runId: "20260714-170836",
      startedAt: "2026-07-14T17:08:36+08:00",
      finishedAt: "2026-07-14T17:08:38+08:00",
      overallStatus: "failed",
      failureReason: "build_failed",
      needsManualIntervention: false,
      git: {
        pullStatus: "success",
        pullSkipped: false,
        commitBefore: "b979be9c52b1e077584671f0910f5096e2675083",
        commitAfter: "5c30301122f15e41a1034b63094e1ac0cc8a519d",
      },
      build: { status: "failed" },
      gate: {
        status: "skipped",
        approved: false,
        criticalCount: 0,
        warningCount: 0,
        failureReason: "build_failed",
        jsonPath: "/tmp/review.json",
        logPath: "/tmp/review.log",
      },
      llm: {
        enabled: true,
        status: "skipped",
        provider: "trae-cli-v1",
        model: "Qwen3.6-Plus",
      },
      logs: {
        result: "/tmp/nightly-result.json",
        build: "/tmp/build.log",
      },
    },
  ],
};

function makeCollectingFetch(calls) {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const u = new URL(url);
    const respond = (data) => ({ ok: true, async json() { return { code: 0, data }; } });
    if (u.pathname.endsWith("/tenant_access_token/internal")) {
      return { ok: true, async json() { return { code: 0, tenant_access_token: "t-test", expire: 7200 }; } };
    }
    if (u.pathname.endsWith("/metainfo")) {
      return respond({
        sheets: [
          { sheetId: "shtN", title: "nightly-update" },
          { sheetId: "shtP", title: "project-update" },
        ],
      });
    }
    if (u.pathname.includes("/values/") && method === "GET") {
      // Empty header row so ensureHeader triggers a PUT.
      return respond({ valueRange: { values: [[]] } });
    }
    if (u.pathname.endsWith("/values") && method === "PUT") {
      return respond({});
    }
    if (u.pathname.endsWith("/values_append")) {
      return respond({});
    }
    return { ok: false, async json() { return { code: 1, msg: `unexpected ${u.pathname}` }; } };
  };
}

function findByRange(calls, method, range) {
  return calls.find((c) => c.method === method && c.body?.valueRange?.range?.startsWith(range));
}

async function run() {
  {
    const work = mkdtempSync(resolve(tmpdir(), "ua-write-records-"));
    const previousEnv = {
      HOME: process.env.HOME,
      UA_PROJECTS_ROOT: process.env.UA_PROJECTS_ROOT,
      UA_CONFIG: process.env.UA_CONFIG,
      UA_RECORD_PROVIDER: process.env.UA_RECORD_PROVIDER,
      UA_RECORD_SHEET: process.env.UA_RECORD_SHEET,
      LARK_APP_ID: process.env.LARK_APP_ID,
      LARK_APP_SECRET: process.env.LARK_APP_SECRET,
    };
    try {
      const configDir = resolve(work, "gateway", "config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(resolve(configDir, ".env"), "LARK_APP_ID=cli_from_config\nLARK_APP_SECRET=secret_from_config\n");
      writeFileSync(resolve(configDir, "deploy.yaml"), `record:
  providers: ["local", "feishu-sheets"]
  config:
    feishu-sheets:
      appId: "{{ LARK_APP_ID }}"
      appSecret: "{{ LARK_APP_SECRET }}"
      spreadsheetToken: "DEPLOY_TOKEN"
      mappings:
        nightly-update:
          worksheet: "nightly-update"
          columns: ["runId"]
`);
      process.env.HOME = work;
      process.env.UA_PROJECTS_ROOT = work;
      process.env.UA_RECORD_PROVIDER = "none";
      process.env.UA_RECORD_SHEET = "LEGACY_ENV_TOKEN";
      delete process.env.UA_CONFIG;
      delete process.env.LARK_APP_ID;
      delete process.env.LARK_APP_SECRET;

      const runtime = await resolveRuntime({ config: "", provider: "", sheet: "" });
      check("runtime resolves provider from deploy.yaml over legacy env", runtime.provider === "feishu", runtime.provider);
      check("runtime resolves sheet from deploy.yaml over legacy env", runtime.sheet === "DEPLOY_TOKEN", runtime.sheet);
      check("runtime resolves appId from config .env template", runtime.recordConfig.appId === "cli_from_config", runtime.recordConfig.appId);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(work, { recursive: true, force: true });
    }
  }

  const calls = [];
  const provider = new FeishuSheetsRecordProvider({
    appId: "cli_test",
    appSecret: "secret_test",
    spreadsheetToken: "shtTest",
    fetchImpl: makeCollectingFetch(calls),
    mappings: {
      "nightly-update": { worksheet: "nightly-update", columns: NIGHTLY_COLUMNS },
      "project-update": { worksheet: "project-update", columns: PROJECT_COLUMNS },
    },
  });

  await provider.write(buildNightlyEnvelope(aggregateFixture));
  for (const envelope of buildProjectEnvelopes(aggregateFixture)) {
    await provider.write(envelope);
  }

  // Nightly header PUT
  const nightlyHeader = findByRange(calls, "PUT", "shtN!A1:");
  check("nightly header PUT sent", nightlyHeader !== undefined);
  if (nightlyHeader) {
    check(
      "nightly header row = NIGHTLY_COLUMNS",
      JSON.stringify(nightlyHeader.body.valueRange.values[0]) === JSON.stringify(NIGHTLY_COLUMNS),
      JSON.stringify(nightlyHeader.body.valueRange.values[0]),
    );
  }

  // Nightly data append
  const nightlyAppend = calls.find((c) => c.url.includes("/values_append") && c.body?.valueRange?.range?.startsWith("shtN!"));
  check("nightly data append sent", nightlyAppend !== undefined);
  if (nightlyAppend) {
    const row = nightlyAppend.body.valueRange.values[0];
    check("nightly row length matches columns", row.length === NIGHTLY_COLUMNS.length);
    for (let i = 0; i < NIGHTLY_COLUMNS.length; i += 1) {
      const col = NIGHTLY_COLUMNS[i];
      // Every column must be non-empty for this fixture (all fields are set).
      check(`nightly column '${col}' has value`, row[i] !== "" && row[i] !== undefined, `row[${i}]=${JSON.stringify(row[i])}`);
    }
    check("nightly runId cell matches fixture", row[NIGHTLY_COLUMNS.indexOf("runId")] === aggregateFixture.runId);
    check(
      "nightly resultJson cell matches fixture logs.result",
      row[NIGHTLY_COLUMNS.indexOf("resultJson")] === aggregateFixture.logs.result,
    );
  }

  // Project header PUT
  const projectHeader = findByRange(calls, "PUT", "shtP!A1:");
  check("project header PUT sent", projectHeader !== undefined);
  if (projectHeader) {
    check(
      "project header row = PROJECT_COLUMNS",
      JSON.stringify(projectHeader.body.valueRange.values[0]) === JSON.stringify(PROJECT_COLUMNS),
      JSON.stringify(projectHeader.body.valueRange.values[0]),
    );
  }

  // Project data append
  const projectAppend = calls.find((c) => c.url.includes("/values_append") && c.body?.valueRange?.range?.startsWith("shtP!"));
  check("project data append sent", projectAppend !== undefined);
  if (projectAppend) {
    const row = projectAppend.body.valueRange.values[0];
    check("project row length matches columns", row.length === PROJECT_COLUMNS.length);
    // Spot-check dotted-path columns that historically drifted:
    const idx = (name) => PROJECT_COLUMNS.indexOf(name);
    check("project build.status = 'failed'", row[idx("build.status")] === "failed");
    check("project gate.status = 'skipped'", row[idx("gate.status")] === "skipped");
    check("project gate.approved = 'false'", row[idx("gate.approved")] === "false");
    check(
      "project git.commitBefore matches fixture",
      row[idx("git.commitBefore")] === aggregateFixture.projects[0].git.commitBefore,
    );
    check(
      "project git.commitAfter matches fixture",
      row[idx("git.commitAfter")] === aggregateFixture.projects[0].git.commitAfter,
    );
    check(
      "project llm.provider column resolves (not llm.providerName)",
      row[idx("llm.provider")] === "trae-cli-v1",
      `got ${JSON.stringify(row[idx("llm.provider")])}`,
    );
    check(
      "project logs.result matches fixture",
      row[idx("logs.result")] === aggregateFixture.projects[0].logs.result,
    );
    check(
      "project logs.build matches fixture",
      row[idx("logs.build")] === aggregateFixture.projects[0].logs.build,
    );
    check(
      "project gate.jsonPath matches fixture",
      row[idx("gate.jsonPath")] === aggregateFixture.projects[0].gate.jsonPath,
    );
    check(
      "project gate.logPath matches fixture",
      row[idx("gate.logPath")] === aggregateFixture.projects[0].gate.logPath,
    );
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} test(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nall tests passed\n");
}

run().catch((err) => {
  process.stderr.write(`test crashed: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(2);
});
