/**
 * `understand-anyway dashboard dev` — foreground Vite dev server.
 *
 * Maintainer-only entrypoint: spawns the upstream plugin's `pnpm dev` against
 * the **same** patched workspace that prod (D3) builds from, opens the
 * browser, and waits for the child to exit. SIGINT/SIGTERM are forwarded so
 * Ctrl-C in the terminal stops the dev server cleanly.
 *
 * Strict isolation: this module only depends on `dashboard-shared/**`, the
 * sibling `spawn-vite.ts`, and Node stdlib. The lint guard in
 * `scripts/lint-isolation.mjs` keeps it that way.
 */

import { resolve } from "node:path";
import {
  preparePatchedUpstreamPluginRoot,
  type PreparedPatchedUpstreamPluginRoot,
  type DashboardPatchDeps,
} from "../dashboard-shared/dashboard-patch.js";
import { openBrowser, type OpenBrowserResult } from "../dashboard-shared/open-browser.js";
import { urlHostFor } from "../dashboard-shared/url.js";
import {
  spawnViteDev,
  type SpawnViteDevArgs,
  type SpawnViteDeps,
  type ViteDevHandle,
} from "./spawn-vite.js";

export interface DashboardDevArgs {
  command: "dashboard";
  action: "dev";
  stateDir: string;
  pluginRoot: string;
  host: string;
  port: number;
  noOpen: boolean;
}

export interface RunDashboardDevDeps {
  /** Override the patch step (used by tests). */
  preparePatched?: (
    pluginRoot: string,
    stateRoot: string,
    deps?: DashboardPatchDeps,
  ) => PreparedPatchedUpstreamPluginRoot;
  /** Override the spawn step (used by tests). */
  spawnVite?: (args: SpawnViteDevArgs, deps?: SpawnViteDeps) => ViteDevHandle;
  /** Override the browser open step (used by tests). */
  openBrowser?: (url: string) => OpenBrowserResult;
  /**
   * Register a signal handler. Returns an unsubscribe function. Defaults to
   * `process.on(signal, handler)` + `process.removeListener(signal, handler)`.
   */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => () => void;
  log?: (message: string) => void;
}

export interface DashboardDevResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function defaultOnSignal(signal: NodeJS.Signals, handler: () => void): () => void {
  process.on(signal, handler);
  return () => {
    process.removeListener(signal, handler);
  };
}

export async function runDashboardDev(
  args: DashboardDevArgs,
  deps: RunDashboardDevDeps = {},
): Promise<DashboardDevResult> {
  const prepare = deps.preparePatched ?? preparePatchedUpstreamPluginRoot;
  const spawn = deps.spawnVite ?? spawnViteDev;
  const open = deps.openBrowser ?? openBrowser;
  const onSignal = deps.onSignal ?? defaultOnSignal;
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));

  const stateRoot = resolve(args.stateDir);
  const pluginRoot = resolve(args.pluginRoot);

  log(`dashboard dev: preparing patched workspace at ${stateRoot}`);
  const prepared = prepare(pluginRoot, stateRoot, { log });
  log(
    `dashboard dev: patch ${prepared.patchId} (upstream ${prepared.upstreamVersion}) ` +
      `applied to ${prepared.dashboardDir}`,
  );

  const urlHost = urlHostFor(args.host);
  const handle = spawn(
    {
      dashboardDir: prepared.dashboardDir,
      host: args.host,
      port: args.port,
      urlHost,
    },
    { log },
  );
  log(`dashboard dev: vite spawned (pid=${handle.pid ?? "?"}), url=${handle.url}`);

  if (!args.noOpen) {
    open(handle.url);
  }

  const teardown: Array<() => void> = [];
  const forward = (signal: NodeJS.Signals) => {
    log(`dashboard dev: received ${signal}; forwarding to vite`);
    handle.close();
  };
  teardown.push(onSignal("SIGINT", () => forward("SIGINT")));
  teardown.push(onSignal("SIGTERM", () => forward("SIGTERM")));

  try {
    const result = await handle.wait();
    log(`dashboard dev: vite exited (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`);
    return result;
  } finally {
    for (const off of teardown) off();
  }
}
