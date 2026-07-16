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
  const home = "/home/u";
  const configDir = "/etc/app";
  const homeEnv = resolve(home, ".env");
  const configEnv = resolve(configDir, ".env");

  it("returns ~/.env values when only home has a .env", () => {
    const merged = loadDotenv({
      configDir,
      home,
      fileExists: (p) => p === homeEnv,
      readFile: () => "A=home\nB=home",
    });
    expect(merged).toEqual({ A: "home", B: "home" });
  });

  it("returns config .env values when only configDir has a .env", () => {
    const merged = loadDotenv({
      configDir,
      home,
      fileExists: (p) => p === configEnv,
      readFile: () => "A=cfg",
    });
    expect(merged).toEqual({ A: "cfg" });
  });

  it("merges ~/.env then <configDir>/.env with config winning", () => {
    const merged = loadDotenv({
      configDir,
      home,
      fileExists: (p) => p === homeEnv || p === configEnv,
      readFile: (p) => {
        if (p === homeEnv) return "A=home\nB=home";
        if (p === configEnv) return "A=cfg";
        return "";
      },
    });
    expect(merged).toEqual({ A: "cfg", B: "home" });
  });

  it("skips configDir entirely when configDir is null", () => {
    const merged = loadDotenv({
      configDir: null,
      home,
      fileExists: (p) => p === homeEnv,
      readFile: () => "A=home",
    });
    expect(merged).toEqual({ A: "home" });
  });

  it("returns {} when no .env files exist", () => {
    expect(loadDotenv({ configDir, home, fileExists: () => false })).toEqual({});
  });
});
