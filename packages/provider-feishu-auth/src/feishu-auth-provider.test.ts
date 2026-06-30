import { describe, expect, it } from "vitest";
import type { AuthRequestContext } from "@understand-anyway/plugin-api";
import { FeishuAuthProvider } from "./feishu-auth-provider.js";

function ctx(url: string): AuthRequestContext {
  return { method: "GET", url, headers: {}, cookies: {} };
}

function makeProvider(): FeishuAuthProvider {
  return new FeishuAuthProvider({
    appId: "cli_test",
    appSecret: "secret_test",
    redirectOrigin: "https://example.test",
    scope: "offline_access",
  });
}

describe("FeishuAuthProvider", () => {
  it("requires appId and redirectOrigin", () => {
    expect(() => new FeishuAuthProvider({ appId: "", redirectOrigin: "https://x" })).toThrow(/appId/);
    expect(() => new FeishuAuthProvider({ appId: "x", redirectOrigin: "" })).toThrow(/redirectOrigin/);
  });

  it("name is 'feishu' so the gate treats it as enabled", () => {
    expect(makeProvider().name).toBe("feishu");
  });

  it("beginLogin builds an authorize URL on the public Feishu endpoint", async () => {
    const { redirectTo } = await makeProvider().beginLogin(ctx("/auth/start"), "/project/demo/");
    const url = new URL(redirectTo);
    expect(url.origin).toBe("https://accounts.feishu.cn");
    expect(url.pathname).toBe("/open-apis/authen/v1/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.test/auth/callback");
    expect(url.searchParams.get("scope")).toBe("offline_access");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("rejects a callback whose state was never issued", async () => {
    const result = await makeProvider().handleCallback(ctx("/auth/callback?state=bogus&code=abc"));
    expect(result.ok).toBe(false);
    expect(result.denied?.reason).toBe("invalid_state");
  });

  it("rejects a callback carrying an authorization error", async () => {
    const provider = makeProvider();
    const { redirectTo } = await provider.beginLogin(ctx("/auth/start"), "/");
    const state = new URL(redirectTo).searchParams.get("state")!;
    const result = await provider.handleCallback(ctx(`/auth/callback?state=${state}&error=access_denied`));
    expect(result.ok).toBe(false);
    expect(result.denied?.reason).toContain("access_denied");
  });

  it("rejects a callback missing the authorization code", async () => {
    const provider = makeProvider();
    const { redirectTo } = await provider.beginLogin(ctx("/auth/start"), "/");
    const state = new URL(redirectTo).searchParams.get("state")!;
    const result = await provider.handleCallback(ctx(`/auth/callback?state=${state}`));
    expect(result.ok).toBe(false);
    expect(result.denied?.reason).toBe("missing_code");
  });

  it("consumes state on use (single-use)", async () => {
    const provider = makeProvider();
    const { redirectTo } = await provider.beginLogin(ctx("/auth/start"), "/");
    const state = new URL(redirectTo).searchParams.get("state")!;
    await provider.handleCallback(ctx(`/auth/callback?state=${state}`));
    const second = await provider.handleCallback(ctx(`/auth/callback?state=${state}&code=x`));
    expect(second.denied?.reason).toBe("invalid_state");
  });
});
