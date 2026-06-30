/**
 * Cross-platform "open URL in default browser" helper.
 *
 * Uses the host OS's well-known launcher: macOS `open`, Linux `xdg-open`,
 * Windows `start`. Spawned detached + unref'd so the dashboard CLI can exit
 * immediately after the daemon is up. All platform sniffing + spawn is
 * injectable for tests.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface OpenBrowserDeps {
  /** Override `process.platform`; defaults to the live process. */
  platform?: NodeJS.Platform;
  /** Override `child_process.spawn`. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** When true, log each action via this sink instead of staying silent. */
  log?: (message: string) => void;
}

export interface OpenBrowserResult {
  /** Command actually invoked (e.g. "open" / "xdg-open" / "cmd"). */
  command: string;
  /** Args passed to the command. */
  args: string[];
}

/**
 * Picks the launcher for the current platform. Exposed for unit tests; callers
 * normally use {@link openBrowser}.
 */
export function pickBrowserLauncher(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  // linux + freebsd + others fall back to xdg-open.
  return { command: "xdg-open", args: [url] };
}

export function openBrowser(url: string, deps: OpenBrowserDeps = {}): OpenBrowserResult {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? nodeSpawn;
  const log = deps.log;
  const { command, args } = pickBrowserLauncher(platform, url);
  if (log) log(`opening browser: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  // Don't keep the parent alive waiting on the spawned launcher.
  child.unref?.();
  return { command, args };
}
