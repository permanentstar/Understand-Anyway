import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createReaperRegistry } from "./mapper-reaper.js";
import { writeBatchGraphFilesSegmented, type SegmentedScheduleOptions } from "./batch-graph-segmented.js";

interface VirtualFs {
  files: Map<string, string>;
  writes: Array<{ path: string; data: string }>;
}

function createVirtualFs(seed: Record<string, unknown> = {}): VirtualFs {
  const files = new Map<string, string>();
  for (const [path, data] of Object.entries(seed)) {
    files.set(path, typeof data === "string" ? data : JSON.stringify(data));
  }
  return { files, writes: [] };
}

function fsDeps(state: VirtualFs) {
  return {
    existsSync: (path: string) => state.files.has(path),
    readFileSync: (path: string) => {
      const data = state.files.get(path);
      if (data === undefined) throw new Error(`ENOENT ${path}`);
      return data;
    },
    writeFileSync: (path: string, data: string) => {
      state.files.set(path, data);
      state.writes.push({ path, data });
    },
    appendFileSync: (path: string, data: string) => {
      const prev = state.files.get(path) ?? "";
      state.files.set(path, prev + data);
      state.writes.push({ path, data });
    },
    mkdirSync: () => undefined,
  };
}

interface FakeChild extends EventEmitter {
  pid: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function fakeChild(pid: number): FakeChild {
  const emitter = new EventEmitter() as FakeChild;
  emitter.pid = pid;
  emitter.killed = false;
  emitter.exitCode = null;
  emitter.signalCode = null;
  return emitter;
}

interface SpawnScript {
  /** Files (path -> JSON string) the worker would "produce" before exiting. */
  produces?: Record<string, unknown>;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** Optional inspector for the argv each invocation receives. */
  capture?: (argv: string[]) => void;
}

function spawnRecorder(scripts: SpawnScript[], state: VirtualFs) {
  let invocation = 0;
  const calls: Array<{ argv: string[]; envSnapshot: Record<string, string | undefined> }> = [];
  const spawn = vi.fn((_command: string, argv: ReadonlyArray<string>, opts: SpawnOptions = {}): ChildProcess => {
    const argvCopy = [...argv];
    calls.push({ argv: argvCopy, envSnapshot: { ...(opts.env as Record<string, string | undefined>) } });
    const script = scripts[invocation++] ?? scripts[scripts.length - 1]!;
    script.capture?.(argvCopy);
    const child = fakeChild(1000 + invocation);
    queueMicrotask(() => {
      if (script.produces) {
        for (const [path, value] of Object.entries(script.produces)) {
          state.files.set(path, typeof value === "string" ? value : JSON.stringify(value));
        }
      }
      child.exitCode = script.exitCode ?? 0;
      child.signalCode = script.signal ?? null;
      child.emit("close", script.exitCode ?? 0, script.signal ?? null);
      child.emit("exit", script.exitCode ?? 0, script.signal ?? null);
    });
    return child as unknown as ChildProcess;
  });
  return { spawn, calls };
}

const intermediateDir = "/state/.understand-anything/intermediate";

function baseOptions(overrides: Partial<SegmentedScheduleOptions> = {}): SegmentedScheduleOptions {
  return {
    cliEntry: "/cli/dist/cli.js",
    analysisRoot: "/state",
    projectRoot: "/repo",
    intermediateDir,
    batches: [],
    outputLanguage: "en",
    projectName: "demo",
    gitHash: "deadbeef",
    mappers: 2,
    log: () => {},
    ...overrides,
  };
}

function makeBatch(idx: number, files: string[] = []): { batchIndex: number; files: Array<{ path: string }> } {
  return { batchIndex: idx, files: files.map((path) => ({ path })) };
}

describe("writeBatchGraphFilesSegmented", () => {
  it("returns early when no batches are missing", async () => {
    const state = createVirtualFs({
      [resolve(intermediateDir, "batch-1.json")]: { nodes: [{ id: "x" }] },
    });
    const { spawn } = spawnRecorder([], state);
    const result = await writeBatchGraphFilesSegmented(
      baseOptions({ batches: [makeBatch(1, ["src/a.ts"])] }),
      { ...fsDeps(state), spawn, setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {}, reaperRegistry: createReaperRegistry() },
    );
    expect(result).toEqual({ segments: 0, missing: 0, written: 0 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("auto-sizes segments to fill mapper slots and runs concurrent workers", async () => {
    const batches = [1, 2, 3, 4, 5, 6].map((idx) => makeBatch(idx, [`src/${idx}.ts`]));
    const state = createVirtualFs();
    const produces = (segment: number[]) => Object.fromEntries(
      segment.map((idx) => [resolve(intermediateDir, `batch-${idx}.json`), { nodes: [{ id: `n${idx}` }] }]),
    );
    const scripts: SpawnScript[] = [
      { produces: produces([1, 2, 3]) },
      { produces: produces([4, 5, 6]) },
    ];
    const { spawn, calls } = spawnRecorder(scripts, state);

    const result = await writeBatchGraphFilesSegmented(
      baseOptions({ batches, mappers: 2 }),
      { ...fsDeps(state), spawn, setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {}, reaperRegistry: createReaperRegistry() },
    );

    expect(result.segments).toBe(2);
    expect(result.mapperBatchCount).toBe(3);
    expect(result.missing).toBe(6);
    expect(result.written).toBe(6);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(calls[0]?.argv).toEqual(expect.arrayContaining(["batch-mapper-worker", "--state-dir", "/state", "--project-root", "/repo"]));
  });

  it("fails when worker exits 0 but products are missing", async () => {
    const batches = [makeBatch(1, ["a"]), makeBatch(2, ["b"])];
    const state = createVirtualFs();
    const scripts: SpawnScript[] = [
      {
        // Worker claims success but only produces batch-1, not batch-2.
        produces: { [resolve(intermediateDir, "batch-1.json")]: { nodes: [{ id: "a" }] } },
        exitCode: 0,
      },
    ];
    const { spawn } = spawnRecorder(scripts, state);
    await expect(
      writeBatchGraphFilesSegmented(
        baseOptions({ batches, mappers: 1 }),
        { ...fsDeps(state), spawn, setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {}, reaperRegistry: createReaperRegistry() },
      ),
    ).rejects.toThrow(/mapper segment 1-2 failed.*invalid=1/);
  });

  it("propagates non-zero exit codes from the worker with a clear error", async () => {
    const batches = [makeBatch(1, ["a"])];
    const state = createVirtualFs();
    const { spawn } = spawnRecorder([{ exitCode: 7 }], state);
    await expect(
      writeBatchGraphFilesSegmented(
        baseOptions({ batches, mappers: 1 }),
        { ...fsDeps(state), spawn, setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {}, reaperRegistry: createReaperRegistry() },
      ),
    ).rejects.toThrow(/mapper segment 1-1 failed \(exit=7\)/);
  });

  it("appends --llm-* flags and splits the LLM budget across worker slots", async () => {
    const batches = [makeBatch(1, ["a"]), makeBatch(2, ["b"]), makeBatch(3, ["c"]), makeBatch(4, ["d"])];
    const state = createVirtualFs();
    const producesLlm = (segment: number[]) => Object.fromEntries(
      segment.map((idx) => [resolve(intermediateDir, `batch-${idx}.json`), { nodes: [{ id: `n${idx}` }], llmEnriched: true }]),
    );
    const scripts: SpawnScript[] = [
      { produces: producesLlm([1, 2]) },
      { produces: producesLlm([3, 4]) },
    ];
    const { spawn, calls } = spawnRecorder(scripts, state);
    const result = await writeBatchGraphFilesSegmented(
      baseOptions({
        batches,
        mappers: 2,
        llm: {
          enabled: true,
          extraArgs: ["--llm-analysis", "--llm-provider", "pkg"],
          globalConcurrency: 4,
          qpmLimit: 8,
        },
      }),
      { ...fsDeps(state), spawn, setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {}, reaperRegistry: createReaperRegistry() },
    );
    expect(result.slotBudgets).toEqual([
      { globalConcurrency: 2, qpmLimit: 4 },
      { globalConcurrency: 2, qpmLimit: 4 },
    ]);
    expect(calls[0]?.argv).toEqual(expect.arrayContaining([
      "--llm-analysis",
      "--llm-provider",
      "pkg",
      "--global-llm-concurrency",
      "2",
      "--llm-qpm-limit",
      "4",
    ]));
  });

  it("forwards UA_BATCH_* env to the spawned worker", async () => {
    const state = createVirtualFs();
    const produces = { [resolve(intermediateDir, "batch-1.json")]: { nodes: [{ id: "x" }] } };
    const { spawn, calls } = spawnRecorder([{ produces }], state);
    await writeBatchGraphFilesSegmented(
      baseOptions({
        batches: [makeBatch(1, ["a"])],
        scanRoot: "/scan/root",
      }),
      { ...fsDeps(state), spawn, setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {}, reaperRegistry: createReaperRegistry() },
    );
    expect(calls[0]?.envSnapshot.UA_BATCH_SCAN_ROOT).toBe("/scan/root");
    expect(calls[0]?.envSnapshot.UA_BATCH_PROJECT_NAME).toBe("demo");
    expect(calls[0]?.envSnapshot.UA_BATCH_GIT_HASH).toBe("deadbeef");
    expect(calls[0]?.envSnapshot.UA_CLI_ENTRY).toBe("/cli/dist/cli.js");
  });

  it("writes a batch-indexes-<s>-<e>.txt for every segment (file-based hand-off)", async () => {
    const batches = [1, 2, 3, 4].map((idx) => makeBatch(idx, [`src/${idx}.ts`]));
    const state = createVirtualFs();
    const produces = (segment: number[]) => Object.fromEntries(
      segment.map((idx) => [resolve(intermediateDir, `batch-${idx}.json`), { nodes: [{ id: `n${idx}` }] }]),
    );
    const { spawn } = spawnRecorder(
      [{ produces: produces([1, 2]) }, { produces: produces([3, 4]) }],
      state,
    );
    await writeBatchGraphFilesSegmented(
      baseOptions({ batches, mappers: 2 }),
      { ...fsDeps(state), spawn, setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {}, reaperRegistry: createReaperRegistry() },
    );
    expect(state.files.has(resolve(intermediateDir, "batch-indexes-1-2.txt"))).toBe(true);
    expect(state.files.has(resolve(intermediateDir, "batch-indexes-3-4.txt"))).toBe(true);
  });

  it("filters batches by includePaths and writes a batch-include-paths.txt", async () => {
    const batches = [
      makeBatch(1, ["src/a.ts"]),
      makeBatch(2, ["src/b.ts"]),
      makeBatch(3, ["src/c.ts"]),
    ];
    const state = createVirtualFs();
    const produces = { [resolve(intermediateDir, "batch-2.json")]: { nodes: [{ id: "b" }] } };
    const { spawn } = spawnRecorder([{ produces }], state);
    const result = await writeBatchGraphFilesSegmented(
      baseOptions({ batches, includePaths: ["src/b.ts"], mappers: 1 }),
      { ...fsDeps(state), spawn, setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {}, reaperRegistry: createReaperRegistry() },
    );
    expect(result.missing).toBe(1);
    expect(state.files.has(resolve(intermediateDir, "batch-include-paths.txt"))).toBe(true);
  });

  it("writes ndjson scheduler + segment events into batch-mapper.ndjson", async () => {
    const batches = [1, 2].map((idx) => makeBatch(idx, [`a${idx}`]));
    const state = createVirtualFs();
    const produces = (segment: number[]) => Object.fromEntries(
      segment.map((idx) => [resolve(intermediateDir, `batch-${idx}.json`), { nodes: [{ id: `${idx}` }] }]),
    );
    const { spawn } = spawnRecorder([{ produces: produces([1, 2]) }], state);
    await writeBatchGraphFilesSegmented(
      baseOptions({ batches, mappers: 1 }),
      { ...fsDeps(state), spawn, setInterval: () => 0 as unknown as NodeJS.Timeout, clearInterval: () => {}, reaperRegistry: createReaperRegistry() },
    );
    const ndjson = state.files.get(resolve(intermediateDir, "batch-mapper.ndjson"))!;
    const lines = ndjson.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(lines.some((evt) => evt.type === "mapper-segment" && evt.status === "success")).toBe(true);
    expect(lines.some((evt) => evt.type === "mapper-scheduler" && evt.status === "success" && evt.written === 2)).toBe(true);
  });
});
