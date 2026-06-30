import { describe, expect, it } from "vitest";
import { redactTokenInUrl, urlHostFor } from "./url.js";

describe("urlHostFor", () => {
  it("rewrites wildcard hosts to loopback for browser-openable URLs", () => {
    expect(urlHostFor("0.0.0.0")).toBe("127.0.0.1");
    expect(urlHostFor("::")).toBe("127.0.0.1");
    expect(urlHostFor("[::]")).toBe("127.0.0.1");
  });
  it("passes loopback / hostnames through unchanged", () => {
    expect(urlHostFor("127.0.0.1")).toBe("127.0.0.1");
    expect(urlHostFor("localhost")).toBe("localhost");
    expect(urlHostFor("dashboard.example")).toBe("dashboard.example");
  });
});

describe("redactTokenInUrl", () => {
  it("redacts ?token=<hex> in a URL", () => {
    expect(redactTokenInUrl("http://127.0.0.1:18666/?token=abc123def"))
      .toBe("http://127.0.0.1:18666/?token=***");
  });
  it("redacts &token=<hex> inside a longer query string", () => {
    expect(redactTokenInUrl("http://h/project/x/?foo=1&token=abc123&bar=2"))
      .toBe("http://h/project/x/?foo=1&token=***&bar=2");
  });
  it("does not touch unrelated tokens (key names that aren't exactly 'token')", () => {
    expect(redactTokenInUrl("http://h/?id_token=abc")).toBe("http://h/?id_token=abc");
    expect(redactTokenInUrl("http://h/?tokenX=abc")).toBe("http://h/?tokenX=abc");
  });
  it("returns the input unchanged when no token param is present", () => {
    expect(redactTokenInUrl("http://h/")).toBe("http://h/");
  });
  it("handles empty / undefined-ish input safely", () => {
    expect(redactTokenInUrl("")).toBe("");
  });
});
