import { describe, expect, it } from "vitest";
import type { RecordEnvelope, RecordProvider } from "@understand-anyway/plugin-api";
import { CompositeRecordProvider } from "./record-composite.js";

function envelope(): RecordEnvelope {
  return { kind: "user-event", timestamp: "2026-06-16T00:00:00.000Z", payload: { eventType: "x" } };
}

function spy(name: string, seen: string[], fail = false): RecordProvider {
  return {
    name,
    async write() {
      seen.push(name);
      if (fail) throw new Error(`${name} boom`);
    },
  };
}

describe("CompositeRecordProvider", () => {
  it("writes the envelope to every child provider", async () => {
    const seen: string[] = [];
    const composite = new CompositeRecordProvider([spy("a", seen), spy("b", seen)]);
    await composite.write(envelope());
    expect(seen).toEqual(["a", "b"]);
  });

  it("does not let one failing provider block the others, and logs the failure", async () => {
    const seen: string[] = [];
    const messages: string[] = [];
    const composite = new CompositeRecordProvider(
      [spy("a", seen, true), spy("b", seen)],
      { log: (m) => messages.push(m) },
    );
    await expect(composite.write(envelope())).resolves.toBeUndefined();
    expect(seen).toEqual(["a", "b"]);
    expect(messages.some((m) => m.includes("composite record write failed (a)"))).toBe(true);
  });

  it("is a no-op with no children", async () => {
    await expect(new CompositeRecordProvider([]).write(envelope())).resolves.toBeUndefined();
  });
});
