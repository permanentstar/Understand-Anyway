import { describe, expect, it } from "vitest";
import { interpolate } from "./interpolate.js";

describe("interpolate", () => {
  it("resolves {{ KEY }} from env over dotenv", () => {
    const out = interpolate(
      { token: "{{ SECRET }}" },
      { env: { SECRET: "from-env" }, dotenv: { SECRET: "from-dotenv" } },
    );
    expect(out).toEqual({ token: "from-env" });
  });

  it("falls back to dotenv when env is absent", () => {
    const out = interpolate({ token: "{{ SECRET }}" }, { dotenv: { SECRET: "from-dotenv" } });
    expect(out).toEqual({ token: "from-dotenv" });
  });

  it("resolves {{ file('/path') }} via readFile, trimmed", () => {
    const out = interpolate(
      { token: "{{ file('/secrets/app') }}" },
      { readFile: (p) => (p === "/secrets/app" ? "  filevalue\n" : "") },
    );
    expect(out).toEqual({ token: "filevalue" });
  });

  it("recurses into nested objects and arrays", () => {
    const out = interpolate(
      { providers: { auth: { config: { appSecret: "{{ S }}" } }, list: ["{{ S }}", "x"] } },
      { env: { S: "v" } },
    );
    expect(out).toEqual({
      providers: { auth: { config: { appSecret: "v" } }, list: ["v", "x"] },
    });
  });

  it("substitutes within surrounding text", () => {
    const out = interpolate({ url: "https://{{ HOST }}/x" }, { env: { HOST: "h.example" } });
    expect(out).toEqual({ url: "https://h.example/x" });
  });

  it("throws on an unresolved placeholder", () => {
    expect(() => interpolate({ token: "{{ MISSING }}" }, { env: {} })).toThrow(/unresolved/);
  });

  it("leaves non-placeholder strings untouched", () => {
    const out = interpolate({ host: "0.0.0.0", port: 18666 }, { env: {} });
    expect(out).toEqual({ host: "0.0.0.0", port: 18666 });
  });
});
