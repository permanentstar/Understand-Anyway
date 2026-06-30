import { describe, expect, it } from "vitest";
import { createAuthProvider } from "./index.js";

describe("createAuthProvider factory", () => {
  it("builds a FeishuAuthProvider from config", async () => {
    const provider = await createAuthProvider({
      appId: "cli_test",
      appSecret: "secret_test",
      redirectOrigin: "https://example.test",
    });
    expect(provider.name).toBe("feishu");
  });
});
