/**
 * `pnpm -C <dashboardDir> exec vite --host <h> --port <p>` wrapper.
 *
 * Used only by `understand-anyway dashboard dev` (D3-dev). Lives under
 * `dashboard-dev/` so the isolation guard keeps it out of the prod path.
 *
 * The handle is intentionally minimal: stdio is inherited (Vite already prints
 * its own banner + HMR logs) and the only control surfaces tests need are
 * `close()` (SIGINT) and `wait()` (resolves on child close, rejects on error).
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface SpawnViteDevArgs {
  /** Path to the patched dashboard package (output of preparePatchedUpstreamPluginRoot). */
  dashboardDir: string;
  /** Vite --host. */
  host: string;
  /** Vite --port. */
  port: number;
  /** Override the host shown in the surfaced URL (e.g. 0.0.0.0 → 127.0.0.1). */
  urlHost?: string;
  /** Extra env merged on top of process.env for the child. */
  env?: Record<string, string>;
}

export interface SpawnViteDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  pnpmBin?: string;
  log?: (message: string) => void;
}

export interface ViteDevHandle {
  /** PID of the spawned child (undefined until spawn returns). */
  pid: number | undefined;
  /** URL the dashboard frontend is reachable at. */
  url: string;
  /** Send SIGINT to the spawned child. Idempotent. */
  close(): void;
  /** Resolves when the child exits, rejects on spawn errors. */
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnViteDev(args: SpawnViteDevArgs, deps: SpawnViteDeps = {}): ViteDevHandle {
  const spawn = deps.spawn ?? nodeSpawn;
  const pnpmBin = deps.pnpmBin ?? "pnpm";
  const log = deps.log ?? (() => {});

  const argv = [
    "-C",
    args.dashboardDir,
    "exec",
    "vite",
    "--host",
    args.host,
    "--port",
    String(args.port),
  ];

  log(`spawning ${pnpmBin} ${argv.join(" ")}`);
  const child = spawn(pnpmBin, argv, {
    stdio: "inherit",
    env: { ...process.env, ...(args.env ?? {}) },
  });

  const urlHost = args.urlHost ?? args.host;
  const url = `http://${urlHost}:${args.port}/`;

  let closeRequested = false;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveWait, rejectWait) => {
      child.on("error", (err) => rejectWait(err));
      child.on("close", (code, signal) => resolveWait({ code, signal }));
    },
  );

  return {
    get pid() {
      return child.pid;
    },
    url,
    close() {
      if (closeRequested) return;
      closeRequested = true;
      log(`sending SIGINT to vite dev (pid=${child.pid ?? "?"})`);
      child.kill("SIGINT");
    },
    wait: () => waitPromise,
  };
}
