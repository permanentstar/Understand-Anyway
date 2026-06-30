import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_PID_FILENAME,
  UA_DIR_NAME,
  dashboardPidPath,
  isPidAlive,
  readDashboardPid,
  removeDashboardPid,
  writeDashboardPid,
  type DashboardPidInfo,
  type PidStoreDeps,
} from "./pid-store.js";

let stateRoot: string;

const sample: DashboardPidInfo = {
  pid: 12345,
  host: "127.0.0.1",
  port: 18666,
  token: "abc123",
  distDir: "/tmp/dist",
  stateRoot: "/tmp/state",
  url: "http://127.0.0.1:18666/?token=abc123",
  startedAt: "2026-06-23T10:00:00.000Z",
};

beforeEach(() => {
  stateRoot = mkdtempSync(resolve(tmpdir(), "ua-pid-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("dashboardPidPath", () => {
  it("resolves to <stateRoot>/.understand-anything/dashboard.pid", () => {
    const path = dashboardPidPath(stateRoot);
    expect(path).toBe(resolve(stateRoot, UA_DIR_NAME, DASHBOARD_PID_FILENAME));
  });
});

describe("writeDashboardPid + readDashboardPid", () => {
  it("round-trips an info object via JSON", () => {
    writeDashboardPid(stateRoot, sample);
    const got = readDashboardPid(stateRoot);
    expect(got).toEqual(sample);
  });

  it("creates the .understand-anything dir if missing", () => {
    // stateRoot already exists but the .understand-anything subdir does not yet.
    writeDashboardPid(stateRoot, sample);
    const got = readDashboardPid(stateRoot);
    expect(got?.pid).toBe(12345);
  });

  it("returns null when the pid file is missing", () => {
    expect(readDashboardPid(stateRoot)).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", () => {
    const fakeRead = () => "{not json";
    const got = readDashboardPid(stateRoot, {
      existsSync: () => true,
      readFileSync: fakeRead,
    });
    expect(got).toBeNull();
  });

  it("returns null when shape is wrong (missing pid)", () => {
    const fakeRead = () => JSON.stringify({ host: "x" });
    const got = readDashboardPid(stateRoot, {
      existsSync: () => true,
      readFileSync: fakeRead,
    });
    expect(got).toBeNull();
  });
});

describe("removeDashboardPid", () => {
  it("removes the pid file when present", () => {
    writeDashboardPid(stateRoot, sample);
    expect(readDashboardPid(stateRoot)).not.toBeNull();
    removeDashboardPid(stateRoot);
    expect(readDashboardPid(stateRoot)).toBeNull();
  });

  it("is a no-op when the pid file is absent", () => {
    expect(() => removeDashboardPid(stateRoot)).not.toThrow();
  });
});

describe("isPidAlive (injected probe)", () => {
  it("returns the probe result", () => {
    const probe: PidStoreDeps["isPidAlive"] = (pid) => pid === 99;
    expect(isPidAlive(99, { isPidAlive: probe })).toBe(true);
    expect(isPidAlive(100, { isPidAlive: probe })).toBe(false);
  });

  it("default probe returns true for our own pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("default probe returns false for a clearly dead pid (negative)", () => {
    expect(isPidAlive(-1)).toBe(false);
  });

  it("default probe returns false for non-integer pid", () => {
    expect(isPidAlive(1.5 as unknown as number)).toBe(false);
  });
});
