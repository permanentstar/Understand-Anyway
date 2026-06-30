import { describe, expect, it, vi } from "vitest";
import { runScanPhase } from "./scan.js";

describe("runScanPhase", () => {
  it("runs the scanner, applies system + test filters, and writes back", () => {
    const scanResult = {
      files: [
        { path: "src/a.ts", fileCategory: "code", language: "ts" },
        { path: "node_modules/x.js", fileCategory: "code", language: "js" },
        { path: "src/a.test.ts", fileCategory: "code", language: "ts" },
      ],
      totalFiles: 3,
    };
    const writes: Array<[string, string]> = [];
    const execFileSync = vi.fn();

    const scan = runScanPhase(
      {
        skillDir: "/skill",
        scanInputRoot: "/repo",
        scanPath: "/repo/scan.json",
        excludeTests: true,
        core: {},
        log: () => {},
      },
      {
        execFileSync: execFileSync as any,
        readFileSync: () => JSON.stringify(scanResult),
        writeFileSync: (p, d) => { writes.push([p, d]); },
      },
    );

    expect(execFileSync).toHaveBeenCalledOnce();
    const files = scan.files as Array<{ path: string }>;
    expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(scan.totalFiles).toBe(1);
    // both system + test filters wrote back
    expect(writes).toHaveLength(2);
  });

  it("keeps test files when excludeTests is false", () => {
    const scanResult = {
      files: [
        { path: "src/a.ts", fileCategory: "code", language: "ts" },
        { path: "src/a.test.ts", fileCategory: "code", language: "ts" },
      ],
      totalFiles: 2,
    };
    const scan = runScanPhase(
      { skillDir: "/s", scanInputRoot: "/repo", scanPath: "/repo/scan.json", excludeTests: false, core: {}, log: () => {} },
      { execFileSync: vi.fn() as any, readFileSync: () => JSON.stringify(scanResult), writeFileSync: () => {} },
    );
    expect((scan.files as unknown[]).length).toBe(2);
  });
});
