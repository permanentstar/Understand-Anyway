import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileRecordProvider } from "./record-local.js";
import type { RecordEnvelope } from "@understand-anyway/plugin-api";

function envelope(kind: RecordEnvelope["kind"], payload: Record<string, unknown> = {}): RecordEnvelope {
  return { kind, timestamp: new Date().toISOString(), payload };
}

describe("LocalFileRecordProvider", () => {
  it("writes a user-event as one NDJSON line and creates the dir on demand", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "ua-rec-")), "nested");
    try {
      const provider = new LocalFileRecordProvider({ runtimeRoot: root });
      await provider.write(envelope("user-event", { eventType: "project_view", userId: "u1" }));
      const content = readFileSync(join(root, "portal-analytics.ndjson"), "utf8");
      const lines = content.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.kind).toBe("user-event");
      expect(parsed.payload.eventType).toBe("project_view");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends multiple events", async () => {
    const root = mkdtempSync(join(tmpdir(), "ua-rec-"));
    try {
      const provider = new LocalFileRecordProvider({ runtimeRoot: root });
      await provider.write(envelope("user-event", { n: 1 }));
      await provider.write(envelope("user-event", { n: 2 }));
      const lines = readFileSync(join(root, "portal-analytics.ndjson"), "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes each kind to its own file", async () => {
    const root = mkdtempSync(join(tmpdir(), "ua-rec-"));
    try {
      const provider = new LocalFileRecordProvider({ runtimeRoot: root });
      await provider.write(envelope("nightly-update"));
      await provider.write(envelope("project-update"));
      await provider.write(envelope("system-config"));
      await provider.write(envelope("custom-kind"));
      expect(readFileSync(join(root, "nightly-events.ndjson"), "utf8")).toContain("nightly-update");
      expect(readFileSync(join(root, "project-events.ndjson"), "utf8")).toContain("project-update");
      expect(readFileSync(join(root, "system-config.ndjson"), "utf8")).toContain("system-config");
      expect(readFileSync(join(root, "records.ndjson"), "utf8")).toContain("custom-kind");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not throw on write failure (reports via log)", async () => {
    const messages: string[] = [];
    // Point runtimeRoot at a path that cannot be created (a file as a parent dir).
    const root = mkdtempSync(join(tmpdir(), "ua-rec-"));
    const fileAsParent = join(root, "blocker");
    // create a file then try to use it as a directory parent
    const { writeFileSync } = await import("node:fs");
    writeFileSync(fileAsParent, "x");
    try {
      const provider = new LocalFileRecordProvider({
        runtimeRoot: join(fileAsParent, "child"),
        log: (m) => messages.push(m),
      });
      await expect(provider.write(envelope("user-event"))).resolves.toBeUndefined();
      expect(messages.some((m) => m.includes("record-local write failed"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
