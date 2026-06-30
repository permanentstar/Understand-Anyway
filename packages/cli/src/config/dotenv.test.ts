import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadDotenv, parseDotenv } from "./dotenv.js";

describe("parseDotenv", () => {
  it("parses KEY=value, strips export prefix and quotes, skips comments", () => {
    const parsed = parseDotenv(
      ["# comment", "export A=1", 'B="two"', "C='three'", "  ", "D=four=with=eq"].join("\n"),
    );
    expect(parsed).toEqual({ A: "1", B: "two", C: "three", D: "four=with=eq" });
  });
});

describe("loadDotenv", () => {
  const cwd = "/work";
  const home = "/home/u";

  it("merges ~/.env then ./.env with cwd winning", () => {
    const cwdEnv = resolve(cwd, ".env");
    const homeEnv = resolve(home, ".env");
    const merged = loadDotenv({
      cwd,
      home,
      fileExists: (p) => p === cwdEnv || p === homeEnv,
      readFile: (p) => {
        if (p === homeEnv) return "A=home\nB=home";
        if (p === cwdEnv) return "A=cwd";
        return "";
      },
    });
    expect(merged).toEqual({ A: "cwd", B: "home" });
  });

  it("returns {} when no .env files exist", () => {
    expect(loadDotenv({ cwd, home, fileExists: () => false })).toEqual({});
  });
});
