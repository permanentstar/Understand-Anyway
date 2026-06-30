/**
 * Parent-process reaper for spawned mapper workers (C7).
 *
 * `trackChildProcess` registers a child for cleanup; the registry is consulted
 * by `installParentSignalReaper`, which binds SIGINT/SIGTERM/exit handlers
 * once on the parent. On signal:
 *   1. Send SIGTERM to every tracked child.
 *   2. After `escalationMs` (default 250) those still alive get SIGKILL.
 *   3. Exit with 130 for SIGINT, 143 for SIGTERM (standard codes).
 *
 * Children that exit on their own remove themselves via `removeChild`, so
 * the reaper only chases survivors.
 *
 * The signal handlers are no-ops (best-effort sync `kill`) inside Node's
 * `exit` event so a hard crash still tries to clean up; full escalation only
 * runs from the SIGINT/SIGTERM paths where async sleeps are safe.
 *
 * Everything (`process.kill`, `setTimeout`, `process.on`, `process.exit`) is
 * injectable so unit tests stay deterministic.
 */

export interface TrackableChild {
  pid?: number | null;
  killed?: boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  on?: (event: "exit" | "close", listener: (...args: unknown[]) => void) => void;
}

export interface ReaperRegistry {
  size: number;
  add(child: TrackableChild): void;
  remove(child: TrackableChild): void;
  list(): TrackableChild[];
  clear(): void;
}

export function createReaperRegistry(): ReaperRegistry {
  const set = new Set<TrackableChild>();
  return {
    get size() {
      return set.size;
    },
    add(child) {
      set.add(child);
    },
    remove(child) {
      set.delete(child);
    },
    list() {
      return Array.from(set);
    },
    clear() {
      set.clear();
    },
  };
}

const defaultRegistry = createReaperRegistry();

/**
 * Register a child so the parent's signal reaper can clean it up. Wires
 * `on('exit')` / `on('close')` so the child de-registers itself when it
 * exits normally — preventing the reaper from chasing dead pids.
 */
export function trackChildProcess(child: TrackableChild, registry: ReaperRegistry = defaultRegistry): void {
  registry.add(child);
  const unregister = () => registry.remove(child);
  child.on?.("exit", unregister);
  child.on?.("close", unregister);
}

export function removeTrackedChild(child: TrackableChild, registry: ReaperRegistry = defaultRegistry): void {
  registry.remove(child);
}

export interface ReaperEnv {
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  process?: NodeJS.EventEmitter & { exit: (code?: number) => void };
}

export interface ReaperOptions {
  registry?: ReaperRegistry;
  escalationMs?: number;
  env?: ReaperEnv;
}

export interface ReaperHandle {
  /** Stops the reaper, removing all listeners; useful for tests. */
  dispose(): void;
}

const DEFAULT_ESCALATION_MS = 250;

function kill(env: ReaperEnv, pid: number, signal: NodeJS.Signals | number): void {
  const fn = env.kill ?? ((p, s) => process.kill(p, s));
  try {
    fn(pid, signal);
  } catch {
    // Process already gone; reaping is best-effort.
  }
}

function isAlive(child: TrackableChild): boolean {
  if (child.killed) return false;
  if (child.exitCode != null) return false;
  if (child.signalCode != null) return false;
  return typeof child.pid === "number" && child.pid > 0;
}

function reapAll(registry: ReaperRegistry, env: ReaperEnv, escalationMs: number, onComplete: () => void): void {
  const survivors: TrackableChild[] = [];
  for (const child of registry.list()) {
    if (isAlive(child) && typeof child.pid === "number") {
      kill(env, child.pid, "SIGTERM");
      survivors.push(child);
    }
  }
  const setTimeoutFn = env.setTimeout ?? ((h, ms) => setTimeout(h, ms));
  setTimeoutFn(() => {
    for (const child of survivors) {
      if (isAlive(child) && typeof child.pid === "number") {
        kill(env, child.pid, "SIGKILL");
      }
    }
    onComplete();
  }, escalationMs);
}

export function installParentSignalReaper(options: ReaperOptions = {}): ReaperHandle {
  const registry = options.registry ?? defaultRegistry;
  const escalationMs = options.escalationMs ?? DEFAULT_ESCALATION_MS;
  const proc = options.env?.process ?? (process as unknown as NodeJS.EventEmitter & { exit: (code?: number) => void });
  const env = options.env ?? {};

  const onSigint = () => {
    reapAll(registry, env, escalationMs, () => proc.exit(130));
  };
  const onSigterm = () => {
    reapAll(registry, env, escalationMs, () => proc.exit(143));
  };
  const onExit = () => {
    // Synchronous best-effort kill on plain exit. Cannot await escalation.
    for (const child of registry.list()) {
      if (isAlive(child) && typeof child.pid === "number") {
        kill(env, child.pid, "SIGTERM");
      }
    }
  };

  proc.on("SIGINT", onSigint);
  proc.on("SIGTERM", onSigterm);
  proc.on("exit", onExit);

  return {
    dispose() {
      proc.removeListener("SIGINT", onSigint);
      proc.removeListener("SIGTERM", onSigterm);
      proc.removeListener("exit", onExit);
    },
  };
}

/** Test seam: expose the default registry for assertions in C7.4. */
export function getDefaultReaperRegistry(): ReaperRegistry {
  return defaultRegistry;
}
