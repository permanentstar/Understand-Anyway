import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { discoverConfigPath } from "./discover.js";

function fakeExists(present: Set<string>) {
  return (path: string) => present.has(path);
}

describe("discoverConfigPath", () => {
  const cwd = "/work";
  const exeRoot = "/exe";

  it("returns null when nothing exists", () => {
    expect(discoverConfigPath(null, { cwd, exeRoot, env: {}, fileExists: () => false })).toBeNull();
  });

  it("finds cwd/deploy.yaml before exe-root", () => {
    const present = fakeExists(new Set([resolve(cwd, "deploy.yaml"), resolve(exeRoot, "deploy.yaml")]));
    expect(discoverConfigPath(null, { cwd, exeRoot, env: {}, fileExists: present })).toBe(
      resolve(cwd, "deploy.yaml"),
    );
  });

  it("falls back to cwd/config/deploy.yaml", () => {
    const present = fakeExists(new Set([resolve(cwd, "config/deploy.yaml")]));
    expect(discoverConfigPath(null, { cwd, exeRoot, env: {}, fileExists: present })).toBe(
      resolve(cwd, "config/deploy.yaml"),
    );
  });

  it("falls back to exe-root when cwd has nothing", () => {
    const present = fakeExists(new Set([resolve(exeRoot, "deploy.yaml")]));
    expect(discoverConfigPath(null, { cwd, exeRoot, env: {}, fileExists: present })).toBe(
      resolve(exeRoot, "deploy.yaml"),
    );
  });

  it("$UA_CONFIG overrides the cwd/exe-root chain", () => {
    const envPath = "/custom/my.yaml";
    const present = fakeExists(new Set([envPath, resolve(cwd, "deploy.yaml")]));
    expect(
      discoverConfigPath(null, { cwd, exeRoot, env: { UA_CONFIG: envPath }, fileExists: present }),
    ).toBe(envPath);
  });

  it("--config overrides $UA_CONFIG and the chain", () => {
    const explicit = "/explicit/deploy.yaml";
    const present = fakeExists(new Set([explicit, "/custom/my.yaml", resolve(cwd, "deploy.yaml")]));
    expect(
      discoverConfigPath(explicit, {
        cwd,
        exeRoot,
        env: { UA_CONFIG: "/custom/my.yaml" },
        fileExists: present,
      }),
    ).toBe(explicit);
  });

  it("treats a pointer to a directory by probing config file names", () => {
    const dir = "/cfgdir";
    const present = fakeExists(new Set([resolve(dir, "deploy.yaml")]));
    expect(discoverConfigPath(dir, { cwd, exeRoot, env: {}, fileExists: present })).toBe(
      resolve(dir, "deploy.yaml"),
    );
  });

  it("default chain never includes a home absolute directory", () => {
    // With nothing present, no path is returned; assert no ~ / home probing.
    const probed: string[] = [];
    discoverConfigPath(null, {
      cwd,
      exeRoot,
      env: {},
      fileExists: (path: string) => {
        probed.push(path);
        return false;
      },
    });
    expect(probed.every((p) => p.startsWith(cwd) || p.startsWith(exeRoot))).toBe(true);
  });
});
