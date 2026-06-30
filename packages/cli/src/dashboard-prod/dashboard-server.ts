/**
 * `dashboard-server` — hidden subcommand. Runs as the daemon child of
 * `dashboard start`: starts the read-only gateway via the existing `runServe`
 * pipeline, then sends an IPC `dashboard-ready` message to the parent so it
 * can persist the pid file and open the browser.
 *
 * Why a hidden subcommand instead of a separate script: the runtime token,
 * config discovery, and signal handling all already live in the existing
 * `runServe` flow — reusing it avoids forking the gateway boot logic.
 */

import { runServe, type RunServeOptions } from "../serve.js";
import type { ServeArgs } from "../args.js";
import type { DashboardDaemonMessage } from "./dashboard-start.js";
import { urlHostFor } from "../dashboard-shared/url.js";

export interface DashboardServerDeps {
  /** Override the gateway start path (tests). */
  runServe?: typeof runServe;
  /** IPC sender; defaults to `process.send` bound to current process. */
  send?: (msg: DashboardDaemonMessage) => boolean;
  /** Override `process.exit` (tests). */
  exit?: (code: number) => never;
  /** Logger (tests). */
  log?: (message: string) => void;
}

/**
 * Run the daemon body. Parses {@link ServeArgs}-shaped CLI args (already split
 * from the `dashboard-server` subcommand by the parser) and reuses runServe.
 */
export async function runDashboardServer(
  args: ServeArgs,
  deps: DashboardServerDeps = {},
  serveOptions: RunServeOptions = {},
): Promise<void> {
  const start = deps.runServe ?? runServe;
  const send = deps.send ?? ((msg: DashboardDaemonMessage) => Boolean(process.send?.(msg)));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));

  try {
    const running = await start(args, {
      ...serveOptions,
      log,
      // Daemon installs its own SIGINT/SIGTERM via runServe defaults.
    });
    // Resolve the actual listen address; --port 0 means auto-assigned, so read
    // from the underlying server rather than blindly echoing args.port.
    const address = running.server.address();
    const host = args.host;
    const port = typeof address === "object" && address ? address.port : args.port;
    const url = `http://${urlHostFor(host)}:${port}/?token=${args.token}`;
    const ok = send({ type: "dashboard-ready", host, port, url });
    if (!ok) log("warning: parent IPC channel unavailable; dashboard-ready not delivered");
  } catch (err) {
    const reason = (err as Error).message ?? String(err);
    send({ type: "dashboard-failed", reason });
    log(`dashboard daemon failed: ${reason}`);
    exit(1);
  }
}
